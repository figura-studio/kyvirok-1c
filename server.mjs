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
import { loadWritePolicy, loadBridgePolicy } from './policy.mjs'
import { makeApprovalQueue } from './approval.mjs'
import { makeActions } from './actions.mjs'
import { makeBridge, edoProviders } from './bridge.mjs'
import { makeArtifacts } from './artifacts.mjs'
import { nativeActionNames } from './changes.mjs'

export function buildServer(pool, policy, policyState, options = {}) {
  const server = new McpServer({ name: 'kyvirok-1c', version: '0.2.0-preview.1' })
  registerSchemaTools(server, pool, resolveLimits())
  registerDataTools(server, pool, resolveLimits())
  const reviews = makeReviews(pool, policy, policyState?.assertCurrent)
  const queue = makeApprovalQueue()
  const actions = makeActions(pool, policy, queue, policyState?.assertCurrent)
  const bridgeState = options.bridgeState ?? { policy: {}, assertCurrent() {} }
  const artifacts = makeArtifacts(options.artifactDir ?? join(process.cwd(), 'artifacts'))
  const bridge = makeBridge(pool, bridgeState, queue, artifacts, options.bridgeTransport)
  const operationResult = async run => {
    const result = await toolResult(run)
    if (!result.isError) for (const file of result.structuredContent?.files ?? []) {
      if (file.uri) result.content.push({ type: 'resource_link', uri: file.uri, name: file.name,
        mimeType: file.mimeType, size: file.size, description: 'Файл из 1С; SHA-256 проверен.' })
    }
    return result
  }
  const ask = async (message, title = 'Выполнить только эту операцию в 1С') => {
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
    return { summary: 'Разрешения и опубликованные возможности. Фактические права проверяет 1С.', data: { native, extension } }
  }))
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
    title: 'Подтвердить и выполнить одну операцию 1С',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    description: 'Ask the HUMAN with a required unchecked confirmation. Execute only the immutable one-use review. This is not permission for subsequent posting, signing or sending. Never retry unknown operations.',
    inputSchema: { reviewId: z.uuid() },
  }, async ({ reviewId }) => operationResult(() => queue.apply(reviewId, ask)))
  server.registerTool('get_operation_status', {
    title: 'Проверить результат операции без повторной отправки', annotations: { readOnlyHint: true },
    inputSchema: { planId: z.uuid() },
  }, async args => operationResult(() => bridge.status(args)))
  server.registerResource('operation-artifact', new ResourceTemplate('kyvirok-1c://artifacts/{id}', { list: undefined }),
    { title: 'Печатная форма или отчёт из 1С' }, async (uri, { id }) => artifacts.read(id))
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
  if (process.argv.includes('--diagnose')) {
    console.log(JSON.stringify({ version: '0.2.0-preview.1', ...policyState.diagnostics(), bridge: bridgeState.diagnostics() }, null, 2))
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
  await buildServer(pool, policyState.policy, policyState, { bridgeState,
    artifactDir: process.env.KYVIROK_1C_ARTIFACTS_DIR || join(dataDir, 'artifacts') }).connect(new StdioServerTransport())
  }
}
