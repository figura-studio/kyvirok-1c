import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { createHash } from 'node:crypto'
import { policySchema } from './changes.mjs'
import { bridgePolicySchema } from './bridge.mjs'

export function loadWritePolicy(dataDir, override = process.env.KYVIROK_1C_POLICY) {
  return loadPolicy(dataDir, override, 'write-policy.json', policySchema, policy => Object.values(policy).some(entities =>
    Object.values(entities).some(operations => Object.values(operations).some(fields => fields.length > 0))))
}

export function loadBridgePolicy(dataDir, override = process.env.KYVIROK_1C_BRIDGE_POLICY) {
  return loadPolicy(dataDir, override, 'bridge-policy.json', bridgePolicySchema,
    policy => Object.values(policy).some(rule => rule.operations.length > 0))
}

function loadPolicy(dataDir, override, filename, schema, enabled) {
  const path = override || join(dataDir, filename)
  if (!isAbsolute(path)) throw new Error('Путь к правилам записи должен быть абсолютным.')
  function read() {
    try { return readFileSync(path, 'utf8').replace(/^\uFEFF/, '') }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const digest = text => text === null ? null : createHash('sha256').update(text).digest('hex')
  let source, policy
  try {
    source = read()
    if (source === null && override) throw new Error('missing explicit policy')
    policy = schema.parse(source === null ? {} : JSON.parse(source))
  } catch {
    throw new Error('Не удалось загрузить правила записи: ' + path + '. Проверьте путь, доступ и формат JSON по ' + filename.replace('.json', '.example.json') + '.')
  }
  const fingerprint = digest(source)
  function diagnostics() {
    let currentStatus, changedSinceStart
    try {
      const current = read()
      currentStatus = current === null ? 'missing' : 'present'
      changedSinceStart = digest(current) !== fingerprint
    } catch { currentStatus = 'unreadable'; changedSinceStart = true }
    return {
      path, loaded: source !== null, currentStatus, changedSinceStart,
      restartRequired: changedSinceStart,
      writeEnabled: !changedSinceStart && enabled(policy),
      permissions: policy,
      note: 'Правила загружаются при старте. После их изменения перезапустите MCP-сервер и создайте новый предпросмотр.',
    }
  }
  return { policy, diagnostics, assertCurrent() {
    if (diagnostics().changedSinceStart) throw new Error('Файл правил записи изменился или недоступен. Перезапустите MCP-сервер и создайте новый предпросмотр.')
  } }
}
