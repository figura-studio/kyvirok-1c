import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const name = /^[\p{L}_][\p{L}\p{N}_]*$/u
const reserved = new Set(['Ref_Key', 'DataVersion', 'Posted', 'DeletionMark', 'Predefined', 'PredefinedDataName',
  '__proto__', 'constructor', 'prototype'])
const fields = z.array(z.string().regex(name))
export const policySchema = z.record(z.string(), z.record(z.string(),
  z.strictObject({ create: fields.optional(), update: fields.optional() })))

const ttl = 5 * 60_000
const maxReviewBytes = 16_000

function checkedFields(index, entitySet, values, allowed) {
  if (!Object.hasOwn(index.entitySetToType, entitySet)) throw new Error('Объект отсутствует в опубликованных метаданных.')
  const schema = index.schemas[index.entitySetToType[entitySet]]
  for (const [field, value] of Object.entries(values)) {
    if (!allowed.includes(field) || reserved.has(field) || !Object.hasOwn(schema.properties, field)) {
      throw new Error('Поле запрещено правилами записи или отсутствует в 1С: ' + field)
    }
    const type = schema.properties[field].type
    const table = /^Collection\((?:[^.]+\.)?([^.)]+)\)$/.exec(type)
    if (table) {
      const row = index.schemas[table[1]]
      if (!row || !Array.isArray(value)) throw new Error('Неверная структура табличной части: ' + field)
      for (const line of value) {
        if (!line || Array.isArray(line) || typeof line !== 'object' || !Object.keys(line).length) {
          throw new Error('Пустая или неверная строка таблицы: ' + field)
        }
        for (const [column, cell] of Object.entries(line)) {
          if (reserved.has(column) || !name.test(column) || !Object.hasOwn(row.properties, column) ||
              (cell !== null && typeof cell === 'object')) throw new Error('Недопустимое поле строки: ' + column)
        }
      }
    } else if (value !== null && typeof value === 'object') {
      throw new Error('Ожидалось простое значение: ' + field)
    }
  }
}

// Escape data that might reformat the confirmation or visually reorder its labels.
function reviewText(data) {
  const json = JSON.stringify(data, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)
  const escaped = json.replace(/[`<>\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
    ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  if (Buffer.byteLength(escaped) > maxReviewBytes) throw new Error('Изменение слишком велико для полного просмотра.')
  return 'Проверьте базу, объект и каждое поле. Указанные таблицы заменяются целиком.\n\n' +
    '```json\n' + escaped + '\n```'
}

export function makeReviews(pool, policy) {
  const pending = new Map()
  return {
    async preview({ connection, entitySet, operation, key, fields: proposed }) {
      if (!/^(Catalog|Document)_[\p{L}\p{N}_]+$/u.test(entitySet) || !Object.hasOwn(policy, connection) ||
          !Object.hasOwn(policy[connection], entitySet)) throw new Error('Этот объект не разрешён для записи.')
      const allowed = policy[connection][entitySet][operation]
      if (!allowed?.length || !Object.keys(proposed).length) throw new Error('Операция недоступна или поля пусты.')
      if ((operation === 'update') !== Boolean(key)) throw new Error('Ключ обязателен только для изменения существующего объекта.')
      const { index, client } = await pool.get(connection)
      const payload = structuredClone(proposed)
      checkedFields(index, entitySet, payload, allowed)
      const current = key ? await client.entity(entitySet, key).get() : undefined
      if (current && (current.Posted || current.DeletionMark)) throw new Error('Объект проведён или помечен на удаление.')
      const version = current?.DataVersion
      if (key && (typeof version !== 'string' || !version || version === '*' || /[\r\n]/.test(version))) {
        throw new Error('1С не вернула версию объекта для проверки перед записью.')
      }
      const changes = Object.entries(payload).map(([field, after]) => {
        if (current && !Object.hasOwn(current, field)) throw new Error('1С не вернула исходное поле: ' + field)
        return current ? { поле: field, было: current[field], станет: after } : { поле: field, значение: after }
      })
      const review = { база: connection, объект: entitySet, операция: key ? 'Изменить' : 'Создать',
        ...(key ? { ключ: key, наименованиеИлиНомер: current.Description ?? current.Number ?? key } : {}),
        изменения: changes }
      const message = reviewText(review)
      const now = Date.now()
      for (const [id, draft] of pending) if (draft.expires <= now) pending.delete(id)
      if (pending.size >= 100) throw new Error('Достигнут лимит активных предпросмотров.')
      const reviewId = randomUUID()
      pending.set(reviewId, { client, entitySet, key, payload, version, message, expires: now + ttl })
      return { summary: 'Предпросмотр на пять минут. Данные в 1С ещё не записаны.', data: { reviewId, review } }
    },
    async apply(id, confirm) {
      const draft = pending.get(id)
      pending.delete(id) // Consume before the first await, including on cancellation or transport failure.
      if (!draft || draft.expires <= Date.now()) throw new Error('Предпросмотр истёк или уже использован.')
      if (await confirm(draft.message) !== true) return { summary: 'Отменено. Записи в 1С не было.', data: { state: 'cancelled' } }
      if (draft.expires <= Date.now()) throw new Error('Время подтверждения истекло. Подготовьте новый просмотр.')
      const { client, entitySet, key, payload, version } = draft
      let saved
      try {
        // The client also rereads DataVersion immediately before PATCH. If-Match
        // lets deployments supporting conditional updates guard the write on the server.
        saved = key
          ? await client.entity(entitySet, key).withHeader('If-Match', version).patch(payload, { expectVersion: version })
          : await client.entity(entitySet).create(payload)
      } catch (err) {
        if (err?.status >= 400 && err.status < 500) throw err
        throw new Error('Результат записи не подтверждён. Проверьте объект в 1С перед повторной попыткой.', { cause: err })
      }
      return { summary: '1С подтвердила запись.', data: { state: 'saved', entitySet, key: saved?.Ref_Key ?? key,
        ...(saved?.Number ? { number: saved.Number } : {}) } }
    },
  }
}
