import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { hashRequest } from './bridge.mjs'
import { validateDraftBody } from './edo-drafts.mjs'

const alias = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
const identifier = z.uuid().transform(value => value.toLowerCase())
export const edoPolicySchema = z.record(alias, z.strictObject({
  provider: z.literal('diadok'), boxId: identifier,
  operations: z.array(z.enum(['documents.read', 'document.print', 'draft.create'])).default([]),
  importDirectory: z.string().refine(isAbsolute, 'Нужен абсолютный каталог XML').optional(),
}).refine(rule => !rule.operations.includes('draft.create') || !!rule.importDirectory,
  'Для draft.create нужен отдельный importDirectory'))
export const edoDocumentInput = { account: alias, messageId: identifier, entityId: identifier }
export const edoListInput = {
  account: alias,
  category: z.enum(['Incoming', 'Outgoing', 'Internal', 'Proxy', 'Deleted', 'Any']),
  documentTypes: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).max(10).optional(),
  statuses: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,79}$/)).max(10).optional(),
  documentNumbers: z.array(z.string().min(1).max(100)).max(10).optional(),
  counteragentBoxIds: z.array(identifier).max(10).optional(),
  departmentIds: z.array(identifier).max(10).optional(),
  fromDate: z.iso.date().optional(), toDate: z.iso.date().optional(),
  afterIndexKey: z.string().min(1).max(4096).optional(),
  count: z.number().int().min(1).max(100).default(25),
}

// Only a separate operator token can be used. Never reuse a 1C password/cookie.
export function makeEdoSecrets(dataDir) {
  return async account => {
    alias.parse(account)
    let token = process.env['KYVIROK_EDO_' + account.toUpperCase() + '_TOKEN']
    if (!token && process.platform === 'win32') {
      try {
        const encrypted = readFileSync(join(dataDir, 'edo-' + account + '.dpapi'), 'utf8')
        const script = '$ErrorActionPreference="Stop"; $env:PSModulePath=Join-Path $PSHOME "Modules"; ' +
          '[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ' +
          '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim()); ' +
          '[Console]::Write([Net.NetworkCredential]::new("",$s).Password)'
        token = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          input: encrypted, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: ['pipe', 'pipe', 'ignore'],
        })
      } catch { /* Report a generic error, never child-process output or secret paths. */ }
    }
    if (!token || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token) || token.length > 16_384) {
      throw new Error('Нет действующего OAuth access_token Диадока. Введите его локально через setup-edo-windows.ps1; не отправляйте токен в чат.')
    }
    return token
  }
}

async function limitedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new Error('Ответ Диадока превышает лимит размера.')
  }
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const parts = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('Ответ Диадока превышает лимит размера.')
      parts.push(value)
    }
    return Buffer.concat(parts)
  } finally { await reader.cancel().catch(() => {}) }
}

// Fixed HTTPS origin and closed routes. The only write route accepts unsigned drafts only.
// fetchImpl is a test seam, never a setting or MCP argument.
export function createDiadocTransport(getToken, fetchImpl = fetch) {
  return async (path, query, body) => {
    const methods = { '/GetBox': 'GET', '/V4/GetDocuments': 'POST', '/V3/GetDocument': 'GET', '/GeneratePrintForm': 'GET',
      '/DetectDocumentTitles': 'POST', '/V3/PostMessage': 'POST' }
    if (!Object.hasOwn(methods, path) || (methods[path] === 'POST') !== (body !== undefined)) {
      throw new Error('Недопустимая операция прямого адаптера Диадока.')
    }
    const binary = path === '/DetectDocumentTitles'
    if (binary && (!Buffer.isBuffer(body) || body.length === 0 || body.length > 128 * 1024)) throw new Error('Недопустимый XML для распознавания.')
    if (path === '/V3/PostMessage') {
      validateDraftBody(body)
      z.strictObject({ operationId: z.uuid() }).parse(query)
    }
    const url = new URL(path, 'https://diadoc-api.kontur.ru')
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value))
    const token = await getToken()
    const pdf = path === '/GeneratePrintForm'
    let response
    try {
      response = await fetchImpl(url, { method: methods[path], redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: 'Bearer ' + token, Accept: pdf ? 'application/pdf' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': binary ? 'application/octet-stream' : 'application/json; charset=utf-8' }) },
        ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }) })
    } catch { throw new Error('Нет ответа от API Диадока. Проверьте соединение; автоматического повтора нет.') }
    if (response.status !== 200) {
      await response.body?.cancel()
      const reasons = { 401: 'Токен отсутствует или истёк. Обновите его локально.',
        402: 'Проверьте подписку на API у оператора.', 403: 'Недостаточно прав к ящику или документу.',
        404: 'Ящик или документ не найден.', 409: 'Для документа нельзя сформировать PDF.',
        429: 'Превышен лимит запросов. Повторите позже.' }
      throw new Error('Диадок: HTTP ' + response.status + '. ' + (reasons[response.status] ?? 'Проверьте настройки. Перенаправления запрещены.'))
    }
    const retry = response.headers.get('retry-after')
    if (pdf && retry !== null) {
      await response.body?.cancel()
      if (!/^\d+$/.test(retry) || Number(retry) > 3600) throw new Error('Некорректный Retry-After Диадока.')
      return { pending: true, retryAfterSeconds: Math.max(1, Number(retry)) }
    }
    const bytes = await limitedBody(response, pdf ? 20 * 1024 * 1024 : 2 * 1024 * 1024)
    if (pdf) {
      if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Диадок не вернул PDF. Файл не сохранён.')
      return { bytes }
    }
    try {
      // Preserve 64-bit timestamps exactly, rather than silently rounding in JSON.parse.
      return JSON.parse(bytes.toString('utf8'), (key, value, context) =>
        typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value)
    } catch { throw new Error('Неверный JSON в ответе Диадока.') }
  }
}

const dateForApi = iso => iso.split('-').reverse().join('.')
const documentSchema = z.object({ MessageId: identifier, EntityId: identifier }).passthrough()
function publicDocument(value) {
  const doc = documentSchema.parse(value)
  const fields = ['MessageId', 'EntityId', 'IndexKey', 'DocumentNumber', 'DocumentDate', 'TypeNamedId',
    'Function', 'Version', 'DocumentDirection', 'CounteragentBoxId', 'DepartmentId', 'FileName',
    'DocflowStatus', 'SenderSignatureStatus', 'RevocationStatus', 'RoamingNotificationStatus',
    'IsDeleted', 'IsTest', 'IsEncryptedContent', 'LastModificationTimestampTicks']
  // Keep business metadata (amount/currency/status) but never Content.Data or arbitrary response fields.
  const result = Object.fromEntries(fields.filter(key => Object.hasOwn(doc, key)).map(key => [key, doc[key]]))
  for (const key of Object.keys(doc)) if (key.endsWith('Metadata')) result[key] = doc[key]
  return result
}

export function makeExternalEdo(state, queue, artifacts, secret, factory = createDiadocTransport) {
  const pending = new Map()
  function settings(account, operation) {
    alias.parse(account); state.assertCurrent()
    const config = Object.hasOwn(state.policy, account) && state.policy[account]
    if (!config) throw new Error('Отдельное подключение ЭДО не настроено: нужен edo-policy.json.')
    if (!config.operations.includes(operation)) throw new Error('Операция отдельного ЭДО не разрешена.')
    return config
  }
  function connect(account, operation) {
    const config = settings(account, operation)
    return { config, request: factory(() => secret(account)) }
  }
  async function document(args, operation = 'documents.read') {
    const input = z.strictObject(edoDocumentInput).parse(args)
    const { config, request } = connect(input.account, operation)
    const doc = publicDocument(await request('/V3/GetDocument', { boxId: config.boxId,
      messageId: input.messageId, entityId: input.entityId, injectEntityContent: false }))
    if (doc.MessageId !== input.messageId || doc.EntityId !== input.entityId) throw new Error('Диадок вернул другой документ.')
    return doc
  }
  function cleanup() {
    for (const [id, item] of pending) if (item.expiresAt <= Date.now()) pending.delete(id)
  }
  async function obtainPrint(id, item) {
    const { config, request } = connect(item.input.account, 'document.print')
    // Bind the print to the exact document that was shown to the human.
    const current = await document(item.input, 'document.print')
    if (hashRequest(current) !== item.version) { pending.delete(id); throw new Error('Документ изменился. Нужен новый предпросмотр печати.') }
    settings(item.input.account, 'document.print')
    item.assertFresh?.()
    if (item.expiresAt <= Date.now()) throw new Error('Ожидание печатной формы истекло.')
    const result = await request('/GeneratePrintForm', { boxId: config.boxId,
      messageId: item.input.messageId, documentId: item.input.entityId })
    if (result.pending) {
      item.nextAt = Date.now() + result.retryAfterSeconds * 1000
      return { summary: 'Диадок готовит PDF. Проверьте этот requestId после указанной задержки.',
        data: { state: 'pending', requestId: id, retryAfterSeconds: result.retryAfterSeconds, files: [] } }
    }
    pending.delete(id)
    if (hashRequest(await document(item.input, 'document.print')) !== item.version) {
      throw new Error('Документ изменился во время печати. PDF не сохранён; нужен новый предпросмотр.')
    }
    const file = await artifacts.save({ id: randomUUID(), name: 'diadoc-' + item.input.entityId + '.pdf',
      mimeType: 'application/pdf', size: result.bytes.length,
      sha256: createHash('sha256').update(result.bytes).digest('hex') }, result.bytes)
    return { summary: 'PDF существующего документа получен из Диадока. Это не создание УПД в 1С.',
      data: { state: 'completed', provider: 'diadok', requestId: id, document: item.input, files: [file] } }
  }
  return {
    connections() {
      state.assertCurrent()
      return { summary: 'Настроенные отдельные подключения ЭДО. Доступ API ещё нужно проверить.', data: {
        accounts: Object.entries(state.policy).map(([account, config]) => ({ account, ...config, accessVerified: false,
          draftImportAvailable: config.operations.includes('draft.create'), signingAvailable: false, sendingAvailable: false })),
        note: 'Отдельный Диадок: чтение, PDF и подтверждённый импорт XML в неподписанный черновик. Подпись и отправка — человеком в кабинете. 1С-ЭДО/СБИС — только профили серверного адаптера.',
      } }
    },
    async diagnose(account) {
      const { config, request } = connect(account, 'documents.read')
      const box = await request('/GetBox', { boxId: config.boxId })
      if (box.BoxIdGuid?.toLowerCase() !== config.boxId) throw new Error('Диадок вернул другой ящик.')
      // GetBox alone does not verify subscription or permission to read documents.
      await this.list({ account, category: 'Incoming', count: 1 })
      return { summary: 'API Диадока ответил на чтение документов выбранного ящика.', data: { account,
        provider: 'diadok', boxId: config.boxId, title: box.Title, organization: {
          name: box.Organization?.FullName, inn: box.Organization?.Inn, kpp: box.Organization?.Kpp },
        readVerified: true, signingAvailable: false, sendingAvailable: false } }
    },
    async list(args) {
      const input = z.strictObject(edoListInput).parse(args)
      if (input.fromDate && input.toDate && input.fromDate > input.toDate) throw new Error('Начало периода позже конца.')
      const { config, request } = connect(input.account, 'documents.read')
      const body = { DocumentCategory: input.category, Count: input.count, SortDirection: 'Descending' }
      for (const [src, dest] of Object.entries({ documentTypes: 'DocumentTypeNamedIds', statuses: 'DocumentStatuses',
        documentNumbers: 'DocumentNumbers', counteragentBoxIds: 'CounteragentBoxIds', afterIndexKey: 'AfterIndexKey' })) {
        if (input[src] !== undefined) body[dest] = input[src]
      }
      if (input.departmentIds) body.Departments = input.departmentIds.map(DepartmentId => ({ DepartmentId, ExcludeSubdepartments: false }))
      if (input.fromDate) body.FromDocumentDate = dateForApi(input.fromDate)
      if (input.toDate) body.ToDocumentDate = dateForApi(input.toDate)
      const result = await request('/V4/GetDocuments', { boxId: config.boxId }, body)
      if (!Array.isArray(result.Documents) || result.Documents.length > input.count) throw new Error('Некорректный список документов Диадока.')
      const documents = result.Documents.map(publicDocument)
      const mayHaveMore = documents.length === input.count
      const next = mayHaveMore ? documents.at(-1)?.IndexKey : undefined
      if (mayHaveMore && (typeof next !== 'string' || !next || next === input.afterIndexKey)) throw new Error('Диадок не вернул новый ключ страницы.')
      return { summary: 'Одна страница документов Диадока. Пустая выборка не доказывает, что контрагент ничего не отправлял.',
        data: { provider: 'diadok', account: input.account, boxId: config.boxId, filters: input,
          totalCount: result.TotalCount, documents, mayHaveMore, nextAfterIndexKey: next,
          note: 'Выборка ограничена правами и подразделениями. По умолчанию — головное подразделение. Черновики не входят. Даты фильтруют реквизит документа, а не дату получения.' } }
    },
    async document(args) { return { summary: 'Документ и статусы из Диадока.', data: { document: await document(args) } } },
    async previewPrint(args) {
      const input = z.strictObject(edoDocumentInput).parse(args)
      const doc = await document(input, 'document.print')
      if (doc.IsDeleted || doc.IsEncryptedContent) throw new Error('Печать удалённого или зашифрованного документа этим адаптером недоступна.')
      const version = hashRequest(doc)
      return queue.add({ review: { операция: 'Получить PDF существующего документа из Диадока', account: input.account,
        boxId: settings(input.account, 'document.print').boxId, document: doc,
        эффекты: ['Создать печатную форму в Диадоке и сохранить PDF локально. Подписание и отправка не выполняются.'] },
      check: () => settings(input.account, 'document.print'), execute: async assertFresh => {
        cleanup(); if (pending.size >= 100) throw new Error('Слишком много ожидающих печатных форм.')
        const id = randomUUID(), item = { input, version, expiresAt: Date.now() + 15 * 60_000, nextAt: 0, assertFresh }
        pending.set(id, item)
        try { return await obtainPrint(id, item) } catch (error) { pending.delete(id); throw error }
        finally { delete item.assertFresh }
      } })
    },
    async printStatus(requestId) {
      cleanup(); const item = pending.get(requestId)
      if (!item) throw new Error('Ожидающая печать отсутствует или истекла. Нужен новый предпросмотр.')
      settings(item.input.account, 'document.print')
      if (item.busy || Date.now() < item.nextAt) return { summary: 'Дождитесь разрешённого времени следующей проверки.',
        data: { state: 'pending', requestId, retryAfterSeconds: Math.max(1, Math.ceil((item.nextAt - Date.now()) / 1000)), files: [] } }
      item.busy = true
      try { return await obtainPrint(requestId, item) } finally { item.busy = false }
    },
  }
}
