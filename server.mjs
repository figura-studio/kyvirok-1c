#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ConnectionPool, FileConnectionSource, registerDataTools, registerSchemaTools,
  resolveDataDir, resolveLimits, toolResult } from './dist/upstream.mjs'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { makeReviews } from './changes.mjs'
import { loadWritePolicy, loadBridgePolicy, loadEdoPolicy } from './policy.mjs'
import { makeExternalEdo, makeEdoSecrets, createDiadocTransport, edoDocumentInput, edoListInput } from './edo.mjs'
import { makeEdoDrafts, edoDraftInput } from './edo-drafts.mjs'
import { makeApprovalQueue } from './approval.mjs'
import { makeActions } from './actions.mjs'
import { makeBridge, edoProviders } from './bridge.mjs'
import { makeArtifacts } from './artifacts.mjs'
import { nativeActionNames } from './changes.mjs'

export function buildServer(pool, policy, policyState, options = {}) {
  const server = new McpServer({ name: 'kyvirok-1c', version: '0.2.0-preview.3' })
  registerSchemaTools(server, pool, resolveLimits())
  registerDataTools(server, pool, resolveLimits())
  const reviews = makeReviews(pool, policy, policyState?.assertCurrent)
  const queue = makeApprovalQueue()
  const actions = makeActions(pool, policy, queue, policyState?.assertCurrent)
  const bridgeState = options.bridgeState ?? { policy: {}, assertCurrent() {} }
  const artifacts = makeArtifacts(options.artifactDir ?? join(process.cwd(), 'artifacts'))
  const bridge = makeBridge(pool, bridgeState, queue, artifacts, options.bridgeTransport)
  const edoState = options.edoState ?? { policy: {}, assertCurrent() {} }
  const edo = makeExternalEdo(edoState, queue, artifacts,
    options.edoSecret ?? (async () => { throw new Error('Источник токена ЭДО не настроен.') }), options.edoTransport)
  const drafts = makeEdoDrafts(edoState, queue, join(options.artifactDir ?? join(process.cwd(), 'artifacts'), '.edo-drafts'),
    options.edoSecret ?? (async () => { throw new Error('Источник токена ЭДО не настроен.') }), options.edoTransport ?? createDiadocTransport)
  const operationResult = async run => {
    const result = await toolResult(run)
    if (!result.isError) for (const file of result.structuredContent?.files ?? []) {
      if (file.uri) result.content.push({ type: 'resource_link', uri: file.uri, name: file.name,
        mimeType: file.mimeType, size: file.size, description: 'Файл из 1С или ЭДО; сохранён с SHA-256.' })
    }
    return result
  }
  const ask = async (message, title = 'Выполнить только показанную операцию в 1С или ЭДО') => {
    const capability = server.server.getClientCapabilities()?.elicitation
    if (!capability || ('url' in capability && !('form' in capability))) return { action: 'unsupported' }
    try { return await server.server.elicitInput({ mode: 'form', message, requestedSchema: {
      type: 'object', properties: { confirm: { type: 'boolean', title, default: false } }, required: ['confirm'],
    } }) } catch { return { action: 'error' } }
  }
  server.registerTool('get_capabilities', {
    title: 'Проверить доступные операции 1С и ЭДО', annotations: { readOnlyHint: true },
    description: 'Read configured and published capabilities. Missing bridge means native print/EDI is NOT connected. Never infer readiness from a provider name.',
    inputSchema: { connection: z.string().min(1) },
  }, async ({ connection }) => toolResult(async () => {
    const native = await actions.capabilities(connection)
    let extension
    try { extension = await bridge.capabilities(connection) }
    catch { extension = { configured: Object.hasOwn(bridgeState.policy, connection), available: false,
      note: 'Не удалось проверить расширение. Проверьте его адрес, права, версию протокола и перезапуск после изменения настроек.' } }
    return { summary: 'Разрешения и опубликованные возможности. Фактические права проверяют 1С и оператор.',
      data: { native, extension, externalEdo: edo.connections().data } }
  }))
  server.registerTool('get_edo_connections', {
    title: 'Посмотреть отдельные подключения ЭДО', annotations: { readOnlyHint: true }, inputSchema: {},
    description: 'Show separate operator accounts, not 1C bridge profiles. Configured does not mean API access is verified. No credentials returned.',
  }, async () => toolResult(async () => edo.connections()))
  server.registerTool('get_edo_workflow', {
    title: 'Как пройти от 1С до Диадока', annotations: { readOnlyHint: true }, inputSchema: {},
    description: 'Choose API or browser/email-code workflow and see what must be verified. This tool does not log in, read email, generate a UPD XML, sign or send.',
  }, async () => toolResult(async () => ({ summary: 'Два пути: API при настроенном доступе или кабинет Диадока через браузер и код из почты.',
    data: {
      accounts: edo.connections().data.accounts,
      oneC: 'Подготовить реализацию/счёт-фактуру через разрешённые поля OData, после отдельного подтверждения. Штатный XML УПД выгрузить средствами 1С; этот сервер XML из OData не генерирует.',
      api: ['Проверить diagnose_edo_connection. Браузерная сессия и код из почты не являются API-токеном.',
        'preview_edo_draft → показать весь XML, стороны и SHA-256 → apply_reviewed_operation с формой человека.',
        'Сохранить operationId/messageId. При unknown проверить кабинет; не повторять и не удалять журнал.'],
      browser: { url: 'https://diadoc.kontur.ru/', executor: 'Внешние инструменты управления браузером и почтой агента; в MCP-сервере их нет.',
        steps: ['Войти через почту и одноразовый код, если такой вариант предлагает кабинет. При действующей сессии повторный вход не нужен.',
          'Если пользователь разрешил вход и доступ к своему ящику, прочитать только актуальное письмо для начатого входа и ввести код на проверенной странице. Код не выводить и не сохранять.',
          'Если почта недоступна, попросить пользователя ввести код. Не извлекать cookies и не превращать веб-сессию в API-авторизацию.',
          'Проверить нужную организацию. Найти созданный черновик или, после отдельного согласия на загрузку, загрузить XML вручную через кабинет.',
          'Открыть печатную форму и проверить стороны, номер, суммы, НДС, строки. Подпись и отправка — отдельные действия человека в кабинете.'] },
      verification: ['Версия и подключение 1С; чтение OData', 'Реальный способ выгрузки XML/печатного УПД',
        'API: результат чтения/HTTP-код либо выбран браузерный путь', 'Вход по почте: доступ к нужному ящику, успешный вход без раскрытия кода',
        'Черновик: номер, SHA-256 и результат проверки', 'Подписант, место ключа, рабочее место и необходимость МЧД'],
      signingAvailable: false, sendingAvailable: false, nativeXmlGenerationAvailable: false,
    } })))
  server.registerTool('diagnose_edo_connection', {
    title: 'Проверить чтение API Диадока', annotations: { readOnlyHint: true },
    inputSchema: { account: edoDocumentInput.account },
    description: 'Read the configured box and probe document access. No registration, signing, sending or settings changes.',
  }, async ({ account }) => toolResult(() => edo.diagnose(account)))
  server.registerTool('list_edo_documents', {
    title: 'Найти документы в отдельном ЭДО', annotations: { readOnlyHint: true }, inputSchema: edoListInput,
    description: 'Read one Diadoc page. Keep identical filters and use nextAfterIndexKey while mayHaveMore. Dates are document dates. Defaults to head department; drafts are excluded. An empty result never proves no documents were sent.',
  }, async args => toolResult(() => edo.list(args)))
  server.registerTool('get_edo_document', {
    title: 'Прочитать документ и статус ЭДО', annotations: { readOnlyHint: true }, inputSchema: edoDocumentInput,
  }, async args => toolResult(() => edo.document(args)))
  server.registerTool('preview_edo_print', {
    title: 'Предпросмотр получения PDF из Диадока', annotations: { readOnlyHint: true }, inputSchema: edoDocumentInput,
    description: 'Preview printing an EXISTING Diadoc document, not creating a UPD in 1C. Use apply_reviewed_operation for human approval. No signing/sending.',
  }, async args => toolResult(() => edo.previewPrint(args)))
  server.registerTool('get_edo_print_status', {
    title: 'Получить ожидающий PDF Диадока', annotations: { readOnlyHint: true }, inputSchema: { requestId: z.uuid() },
    description: 'Continue only a previously approved pending PDF after retryAfterSeconds. Same process, 15-minute lifetime. Cannot print arbitrary document IDs.',
  }, async ({ requestId }) => operationResult(() => edo.printStatus(requestId)))
  server.registerTool('preview_edo_draft', {
    title: 'Показать импорт XML УПД в черновик Диадока', annotations: { readOnlyHint: true }, inputSchema: edoDraftInput,
    description: 'Read an existing seller XML from the policy importDirectory, verify party boxes, show complete XML and hash. No XML upload until apply_reviewed_operation confirms. Does not generate XML from OData. Creates only unsigned drafts; human signs/sends in the operator cabinet.',
  }, async args => toolResult(() => drafts.preview(args)))
  server.registerTool('get_edo_draft_receipt', {
    title: 'Проверить локальную квитанцию импорта в Диадок', annotations: { readOnlyHint: true },
    inputSchema: { account: edoDraftInput.account, operationId: z.uuid() },
    description: 'Read the durable local receipt only, not live remote state. Unknown outcomes require checking the cabinet. Never retry or remove journal records to bypass duplicate protection.',
  }, async args => toolResult(() => drafts.receipt(args)))
  server.registerTool('preview_document_action', {
    title: 'Предпросмотр проведения или пометки удаления', annotations: { readOnlyHint: true },
    description: 'Preview ONE post/unpost or deletion flag action. Includes full document and effects. No automatic repost or chained actions. Post/Unpost use a preflight version check, not an atomic OData version guarantee.',
    inputSchema: { connection: z.string().min(1), entitySet: z.string().min(1), key: z.uuid(), action: z.enum(nativeActionNames) },
  }, async args => toolResult(() => actions.preview(args)))
  server.registerTool('preview_business_operation', {
    title: 'Предпросмотр печати, отчёта или операции ЭДО', annotations: { readOnlyHint: true },
    description: 'Get an immutable dry run from the configured 1C HTTP adapter. Discover operation names/parameters with get_capabilities. Provider values: 1c-edo, diadok, sbis. Requires a deployed, tested adapter. Show recipients, amounts, files and signer before approval.',
    inputSchema: { connection: z.string().min(1), operation: z.string().min(1), provider: z.enum(edoProviders).optional(),
      parameters: z.record(z.string(), z.json()) },
  }, async args => toolResult(() => bridge.preview(args)))
  server.registerTool('apply_reviewed_operation', {
    title: 'Подтвердить и выполнить одну операцию 1С или ЭДО',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    description: 'Ask the HUMAN with a required unchecked confirmation. Execute only the immutable one-use review. This is not permission for subsequent posting, signing or sending. Never retry unknown operations.',
    inputSchema: { reviewId: z.uuid() },
  }, async ({ reviewId }) => operationResult(() => queue.apply(reviewId, ask)))
  server.registerTool('get_operation_status', {
    title: 'Проверить результат операции без повторной отправки', annotations: { readOnlyHint: true },
    inputSchema: { planId: z.uuid() },
  }, async args => operationResult(() => bridge.status(args)))
  server.registerResource('operation-artifact', new ResourceTemplate('kyvirok-1c://artifacts/{id}', { list: undefined }),
    { title: 'Печатная форма или отчёт из 1С / ЭДО' }, async (uri, { id }) => artifacts.read(id))
  server.registerTool('get_write_policy', {
    title: 'Проверить разрешения записи в 1С',
    description: 'Show policy path, loaded state, allowed entities/operations/fields, and whether a restart is required. Does not read credentials or contact 1C.',
    annotations: { readOnlyHint: true }, inputSchema: {},
  }, async () => toolResult(async () => ({ summary: 'Правила записи текущего MCP-сервера.',
    data: policyState ? policyState.diagnostics() : { permissions: policy, source: 'provided-in-memory' } })))
  server.registerTool('preview_change', {
    title: 'Показать изменения в 1С',
    description: 'Prepare creation or editing of one catalog item or draft document. Discover fields with describe_entity. A table field replaces ALL its rows. Show the returned changes to the manager.',
    inputSchema: {
      connection: z.string().min(1), entitySet: z.string().min(1),
      operation: z.enum(['create', 'update']), key: z.uuid().optional(),
      fields: z.record(z.string(), z.json()),
    },
  }, async (args) => toolResult(() => reviews.preview(args)))
  server.registerTool('apply_reviewed_change', {
    title: 'Записать проверенные изменения в 1С',
    description: 'Request explicit human approval for the immutable preview. Decline or cancel skips the write. Never automatically re-create a plan after an unknown write outcome.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { reviewId: z.uuid() },
  }, async ({ reviewId }) => toolResult(() => reviews.apply(reviewId,
    message => ask(message, 'Записать именно эти изменения в 1С'))))
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dataDir = process.env.ONEC_MCP_DATA_DIR ? resolveDataDir() : join(dirname(resolveDataDir()), 'kyvirok-1c')
  const policyState = loadWritePolicy(dataDir)
  const bridgeState = loadBridgePolicy(dataDir)
  const edoState = loadEdoPolicy(dataDir)
  if (process.argv.includes('--diagnose')) {
    console.log(JSON.stringify({ version: '0.2.0-preview.3', ...policyState.diagnostics(), bridge: bridgeState.diagnostics(),
      externalEdo: edoState.diagnostics() }, null, 2))
  } else {
  class LocalSource extends FileConnectionSource {
    secretPath(name) {
      return process.platform === 'win32' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)
        ? join(dataDir, name + '.dpapi') : null
    }
    async secretSource(name) {
      const path = this.secretPath(name)
      return path && existsSync(path) ? 'Windows DPAPI' : super.secretSource(name)
    }
    async getSecret(name) {
      const path = this.secretPath(name)
      if (!path || !existsSync(path)) return super.getSecret(name)
      const script = '$ErrorActionPreference = "Stop"; $env:PSModulePath = Join-Path $PSHOME "Modules"; ' +
        '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ' +
        '$s = ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); ' +
        '[Console]::Write([Net.NetworkCredential]::new("", $s).Password)'
      return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',script], {
        input: readFileSync(path), encoding: 'utf8', windowsHide: true, timeout: 10000, stdio:['pipe','pipe','ignore'],
      })
    }
  }
  const pool = new ConnectionPool(new LocalSource({ dataDir }))
  await buildServer(pool, policyState.policy, policyState, { bridgeState, edoState, edoSecret: makeEdoSecrets(dataDir),
    artifactDir: process.env.KYVIROK_1C_ARTIFACTS_DIR || join(dataDir, 'artifacts') }).connect(new StdioServerTransport())
  }
}
