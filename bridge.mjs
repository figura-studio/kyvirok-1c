import { createHash } from 'node:crypto'
import { z } from 'zod'

export const edoProviders = ['1c-edo', 'diadok', 'sbis']
export const providerLabels = { '1c-edo': '1С-ЭДО', diadok: 'Контур.Диадок', sbis: 'СБИС / Saby' }
const operationName = z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const fileInfo = z.strictObject({ id: z.uuid(), name: z.string().min(1).max(180),
  mimeType: z.enum(['application/pdf', 'application/xml', 'text/xml', 'text/csv',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/pkcs7-signature']),
  size: z.number().int().min(1).max(20 * 1024 * 1024), sha256: digest })
const party = z.strictObject({ id: z.string().min(1).max(200), name: z.string().min(1).max(300),
  inn: z.string().regex(/^\d{10}(\d{2})?$/), kpp: z.string().max(9).optional() })
const ediReview = z.strictObject({ provider: z.enum(edoProviders), sender: party, recipient: party,
  senderBoxId: z.string().min(1).max(200), recipientBoxId: z.string().min(1).max(200),
  documents: z.array(z.strictObject({ id: z.string().min(1).max(200), number: z.string().max(100),
    date: z.string().min(1).max(40), total: z.string().min(1).max(100), currency: z.string().min(1).max(20),
    files: z.array(fileInfo).min(1).max(20) })).min(1).max(30),
  signature: z.strictObject({ required: z.boolean(), state: z.enum(['not_signed', 'signed']), certificateThumbprint: z.string().min(1).max(200),
    signer: z.string().min(1).max(300), powerOfAttorney: z.string().max(300).optional() }).optional(),
})
const capabilitySchema = z.strictObject({ protocol: z.literal('kyvirok-bridge/1'),
  configuration: z.strictObject({ name: z.string().min(1).max(200), version: z.string().min(1).max(100) }),
  operations: z.array(z.strictObject({ name: operationName, title: z.string().min(1).max(200),
    kind: z.enum(['print', 'report', 'draft', 'mutate', 'edo_prepare', 'edo_sign', 'edo_send', 'edo_status']),
    available: z.boolean(), reason: z.string().max(500).optional(), providers: z.array(z.enum(edoProviders)).optional(),
    // A JSON Schema supplied by the adapter for the agent; the adapter MUST validate it too.
    inputSchema: z.record(z.string(), z.json()),
  })).max(100) })
const planSchema = z.strictObject({ planId: z.uuid(), requestHash: digest, expiresAt: z.iso.datetime(),
  review: z.strictObject({ title: z.string().min(1).max(200), effects: z.array(z.string().min(1).max(500)).min(1).max(20),
    // The complete approved business change, not just a free-form description.
    changes: z.array(z.json()).max(100), sourceVersions: z.record(z.string(), z.string()),
    details: z.record(z.string(), z.json()), files: z.array(fileInfo).max(30), edo: ediReview.optional() }),
})
const resultSchema = z.strictObject({ planId: z.uuid(), requestHash: digest,
  state: z.enum(['completed', 'queued', 'rejected', 'unknown']),
  message: z.string().min(1).max(2000), receiptId: z.string().min(1).max(300).optional(),
  verification: z.record(z.string(), z.json()), files: z.array(fileInfo).max(30) })

// Separate, opt-in configuration. No tokens or passwords belong in this file.
export const bridgePolicySchema = z.record(z.string(), z.strictObject({
  servicePath: z.string().regex(/^\/(?:[\p{L}\p{N}_-]+\/)*hs\/[A-Za-z0-9_-]+\/v1$/u),
  operations: z.array(operationName), defaultEdoProvider: z.enum(edoProviders).optional(),
  edoProviders: z.array(z.enum(edoProviders)).default([]),
}))

export function stableJSON(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJSON).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + stableJSON(value[key])).join(',') + '}'
  return JSON.stringify(value)
}
export const hashRequest = value => createHash('sha256').update(stableJSON(value)).digest('hex')

async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw new Error('Ответ расширения слишком велик.')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Пустой ответ расширения.')
  const parts = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('Ответ расширения слишком велик.')
      parts.push(value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(parts)
}

// Credentials stay on the origin and publication of the configured OData base.
// Redirects, including cross-origin artifact links, are NEVER followed with credentials.
export function createBridgeTransport(entry, settings) {
  const base = new URL(entry.connection.baseUrl)
  const suffix = '/odata/standard.odata'
  const publication = base.pathname.replace(/\/$/, '')
  if (!publication.endsWith(suffix)) throw new Error('Не распознан путь публикации OData.')
  const prefix = publication.slice(0, -suffix.length)
  if (!settings.servicePath.startsWith(prefix + '/hs/')) throw new Error('Расширение должно находиться в той же публикации 1С.')
  const root = new URL(settings.servicePath + '/', base.origin)
  const { username, password } = entry.connection.auth
  const auth = 'Basic ' + Buffer.from(username + ':' + password).toString('base64')
  return async function request(path, body, binaryLimit) {
    if (!/^(capabilities|plans|plans\/[0-9a-f-]+\/execute|plans\/[0-9a-f-]+\/status|files\/[0-9a-f-]+)$/.test(path)) {
      throw new Error('Недопустимый маршрут расширения.')
    }
    const response = await fetch(new URL(path, root), { method: body === undefined ? 'GET' : 'POST',
      redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: {
        Authorization: auth, Accept: binaryLimit ? '*/*' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) {
      await response.body?.cancel()
      // Do not echo server HTML, credentialed URLs or diagnostics containing secrets.
      throw new Error('Расширение 1С вернуло HTTP ' + response.status + '. Проверьте публикацию и права.')
    }
    const bytes = await boundedBody(response, binaryLimit ?? 200_000)
    if (binaryLimit) return bytes
    try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Расширение вернуло неверный JSON.') }
  }
}

export function makeBridge(pool, settingsState, queue, artifacts, transportFactory = createBridgeTransport) {
  const executions = new Map()
  function settings(connection, operation, provider) {
    settingsState.assertCurrent()
    const config = Object.hasOwn(settingsState.policy, connection) && settingsState.policy[connection]
    if (!config) throw new Error('Расширение 1С ещё не настроено для этой базы. OData сам по себе не даёт печать и ЭДО.')
    if (operation && !config.operations.includes(operation)) throw new Error('Операция расширения не разрешена.')
    if (provider && !config.edoProviders.includes(provider)) throw new Error('Этот оператор ЭДО не разрешён в настройках.')
    return config
  }
  async function connect(connection) {
    const config = settings(connection)
    const entry = await pool.get(connection)
    return { config, request: transportFactory(entry, config) }
  }
  function remember(planId, value) {
    if (executions.size >= 100) executions.delete(executions.keys().next().value)
    executions.set(planId, value)
  }
  async function collect(result, request) {
    const saved = [], unavailable = []
    for (const file of result.files) {
      try { saved.push(await artifacts.save(file, await request('files/' + file.id, undefined, file.size))) }
      catch { unavailable.push({ id: file.id, name: file.name, reason: 'Файл не получен или контрольная сумма не совпала.' }) }
    }
    return { ...result, files: saved, unavailableFiles: unavailable }
  }
  return {
    async capabilities(connection) {
      if (!Object.hasOwn(settingsState.policy, connection)) return { configured: false, providers: edoProviders.map(id =>
        ({ id, name: providerLabels[id], allowed: false, available: false })), operations: [], note: 'Требуется HTTP-адаптер в вашей 1С.' }
      const { config, request } = await connect(connection)
      const remote = capabilitySchema.parse(await request('capabilities'))
      return { configured: true, configuration: remote.configuration,
        providers: edoProviders.map(id => ({ id, name: providerLabels[id], allowed: config.edoProviders.includes(id),
          available: config.edoProviders.includes(id) && remote.operations.some(item => item.available &&
            config.operations.includes(item.name) && item.kind.startsWith('edo_') && item.providers?.includes(id)) })),
        defaultEdoProvider: config.defaultEdoProvider,
        operations: remote.operations.map(item => ({ ...item, available: item.available && config.operations.includes(item.name) &&
          (!item.kind.startsWith('edo_') || (item.providers ?? []).some(id => config.edoProviders.includes(id))),
          providers: (item.providers ?? []).filter(id => config.edoProviders.includes(id)) })) }
    },
    async preview({ connection, operation, provider, parameters }) {
      operationName.parse(operation)
      const config = settings(connection, operation, provider)
      const { request } = await connect(connection)
      const remote = capabilitySchema.parse(await request('capabilities'))
      const capability = remote.operations.find(item => item.name === operation && item.available)
      if (!capability) throw new Error('Эта операция не подключена на стороне 1С.')
      const expectedKinds = { 'edo.prepare': 'edo_prepare', 'edo.sign': 'edo_sign', 'edo.send': 'edo_send', 'edo.status': 'edo_status' }
      if (Object.hasOwn(expectedKinds, operation) && capability.kind !== expectedKinds[operation]) {
        throw new Error('Расширение неверно описало назначение операции ЭДО.')
      }
      const isEdo = capability.kind.startsWith('edo_')
      if (isEdo) {
        provider = provider ?? config.defaultEdoProvider
        if (!provider || !capability.providers?.includes(provider)) throw new Error('Выберите подключённого оператора ЭДО.')
        settings(connection, operation, provider)
      } else if (provider !== undefined) throw new Error('Оператор ЭДО не относится к этой операции.')
      const input = structuredClone({ operation, ...(provider ? { provider } : {}), parameters })
      if (Buffer.byteLength(stableJSON(input)) > 24_000) throw new Error('Параметры операции слишком велики.')
      const requestHash = hashRequest(input)
      // This endpoint is a read-only dry run: no business documents, no signing, no transmission.
      const plan = planSchema.parse(await request('plans', { ...input, requestHash }))
      if (plan.requestHash !== requestHash) throw new Error('Расширение вернуло предпросмотр другой операции.')
      if (isEdo && plan.review.edo?.provider !== provider) throw new Error('В предпросмотре отсутствует выбранный оператор ЭДО.')
      if (['edo_sign', 'edo_send'].includes(capability.kind) &&
          (!plan.review.edo?.signature || plan.review.edo.signature.required !== true)) {
        throw new Error('Нет данных о подписанте и сертификате для подписи или отправки.')
      }
      if (capability.kind === 'edo_send' && plan.review.edo.signature.state !== 'signed') {
        throw new Error('Сначала отдельно подпишите документы. Отправка не даёт согласия на подписание.')
      }
      if (capability.kind === 'edo_sign' && plan.review.edo.signature.state !== 'not_signed') {
        throw new Error('Документы уже подписаны. Повторное подписание не требуется.')
      }
      // Hash the exact review, including recipients, amounts, certificate and file hashes.
      const reviewHash = hashRequest(plan.review)
      const guard = () => settings(connection, operation, provider)
      return queue.add({ expiresAt: Date.parse(plan.expiresAt), check: guard,
        review: { база: connection, операция: operation, тип: capability.kind,
          ...(provider ? { оператор: providerLabels[provider] } : {}),
          параметры: input.parameters, ...plan.review },
        execute: async assertFresh => {
          guard(); assertFresh()
          remember(plan.planId, { connection, operation, provider, requestHash, request })
          let result
          try {
            result = resultSchema.parse(await request('plans/' + plan.planId + '/execute', { requestHash, reviewHash }))
            if (result.planId !== plan.planId || result.requestHash !== requestHash) throw new Error('Mismatched result')
          } catch {
            return { summary: 'Результат не подтверждён. Проверяйте статус этого плана; не создавайте повторную отправку.',
              data: { state: 'unknown', planId: plan.planId, connection, operation, provider } }
          }
          return { summary: result.message, data: await collect(result, request) }
        },
      })
    },
    async status({ planId }) {
      const known = executions.get(planId)
      if (!known) throw new Error('План не выполнялся в этом сеансе. Проверьте журнал расширения 1С по planId.')
      settings(known.connection, known.operation, known.provider)
      const result = resultSchema.parse(await known.request('plans/' + planId + '/status'))
      if (result.planId !== planId || result.requestHash !== known.requestHash) throw new Error('Неверный ответ проверки статуса.')
      return { summary: result.message, data: await collect(result, known.request) }
    },
  }
}
