import { randomUUID } from 'node:crypto'
import { z } from 'zod'

const name = /^[\p{L}_][\p{L}\p{N}_]*$/u
const reserved = new Set(['Ref_Key', 'DataVersion', 'Posted', 'DeletionMark', 'Predefined', 'PredefinedDataName',
  '__proto__', 'constructor', 'prototype'])
const fields = z.array(z.string().regex(name))
export const nativeActionNames = ['post', 'unpost', 'mark_deletion', 'unmark_deletion']
export const policySchema = z.record(z.string(), z.record(z.string(),
  z.strictObject({ create: fields.optional(), update: fields.optional(),
    actions: z.array(z.enum(nativeActionNames)).optional() })))

const ttl = 5 * 60_000
const maxReviewBytes = 16_000

const confirmationFailures = {
  decline: 'Клиент вернул отказ. Проверьте, разрешён ли показ форм MCP в активном режиме чата.',
  cancel: 'Клиент сообщил о закрытии формы.',
  unchecked: 'Форма принята, но галочка «Записать именно эти изменения в 1С» не установлена.',
  unsupported: 'Клиент MCP не поддерживает форму подтверждения. Используйте клиент с поддержкой elicitation form.',
  error: 'Клиент не вернул подтверждение формы. Проверьте настройки показа форм MCP.',
}

export function shortReview(entitySet, key, current, payload) {
  const values = { ...current, ...payload }
  const summary = {
    действие: key ? 'Изменение' : 'Создание',
    наименованиеИлиНомер: values.Description ?? values.Number ?? 'Назначит 1С',
  }
  if (!entitySet.startsWith('Document_')) return summary
  summary.покупатель = values.Контрагент?.Description ?? values.Партнер?.Description ??
    (values.Контрагент_Key ? 'Ключ контрагента: ' + values.Контрагент_Key :
      values.Партнер_Key ? 'Ключ партнёра: ' + values.Партнер_Key : 'Не указан в предпросмотре')
  summary.дата = values.Date ?? 'Не указана; значение определит 1С'
  summary.проведение = values.Posted === true ? 'Проведён' : values.Posted === false ? 'Не проведён' :
    'Создание черновика; статус проверить после записи'
  summary.суммаДокумента = values.СуммаДокумента ?? 'Не передана; проверить после записи'
  summary.НДС = values.СуммаНДС ?? 'См. ставки и суммы в строках; проверить после записи'
  summary.суммаВключаетНДС = values.СуммаВключаетНДС ?? 'Не указано'
  summary.табличныеЧасти = Object.fromEntries(Object.entries(values).filter(([, v]) => Array.isArray(v))
    .map(([field, rows]) => [field, { всегоСтрок: rows.length, первыеСтроки: rows.slice(0, 10).map(row => Object.fromEntries(
      ['Номенклатура_Key', 'Содержание', 'Количество', 'ЕдиницаИзмерения_Key', 'Цена', 'Сумма', 'СтавкаНДС', 'СуммаНДС']
        .filter(column => row && Object.hasOwn(row, column)).map(column => [column, row[column]]))) }]))
  return summary
}

// 1C may add server-managed columns to rows; every submitted value must still match.
function matchesSubmitted(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected)
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value, i) => matchesSubmitted(actual[i], value))
  return actual !== null && typeof actual === 'object' && Object.entries(expected)
    .every(([key, value]) => Object.hasOwn(actual, key) && matchesSubmitted(actual[key], value))
}

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
  return 'Проверьте сводку и полный набор полей. Для записи установите галочку ' +
    '«Записать именно эти изменения в 1С» и примите форму. Указанные таблицы заменяются целиком.\n\n' +
    '```json\n' + escaped + '\n```'
}

export function makeReviews(pool, policy, assertPolicyCurrent = () => {}) {
  const pending = new Map()
  return {
    async preview({ connection, entitySet, operation, key, fields: proposed }) {
      assertPolicyCurrent()
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
      const now = Date.now()
      for (const [id, draft] of pending) if (draft.expires <= now) pending.delete(id)
      if (pending.size >= 100) throw new Error('Достигнут лимит активных предпросмотров.')
      const reviewId = randomUUID()
      const overview = shortReview(entitySet, key, current, payload)
      const fullMessage = reviewText({ сводка: overview, ...review })
      pending.set(reviewId, { client, entitySet, key, payload, version, message: fullMessage, expires: now + ttl })
      return { summary: 'Предпросмотр на пять минут. Для записи отметьте галочку в форме подтверждения.',
        data: { reviewId, overview, review } }
    },
    async apply(id, confirm) {
      const draft = pending.get(id)
      pending.delete(id) // Consume before the first await, including on cancellation or transport failure.
      if (!draft || draft.expires <= Date.now()) throw new Error('Предпросмотр истёк или уже использован.')
      assertPolicyCurrent()
      const answer = await confirm(draft.message)
      if (!(answer?.action === 'accept' && answer.content?.confirm === true)) {
        const reason = answer?.action === 'accept' ? 'unchecked' :
          (Object.hasOwn(confirmationFailures, answer?.action) ? answer.action : 'error')
        return { summary: confirmationFailures[reason] + ' Запись не выполнялась.',
          data: { state: 'cancelled', reason } }
      }
      if (draft.expires <= Date.now()) throw new Error('Время подтверждения истекло. Подготовьте новый просмотр.')
      assertPolicyCurrent()
      const { client, entitySet, key, payload, version } = draft
      let saved
      try {
        // The client also rereads DataVersion immediately before PATCH. If-Match
        // lets deployments supporting conditional updates guard the write on the server.
        saved = key
          ? await client.entity(entitySet, key).withHeader('If-Match', version).patch(payload, { expectVersion: version, retry: false })
          : await client.entity(entitySet).create(payload, { retry: false })
      } catch (err) {
        if (err?.status >= 400 && err.status < 500) throw err
        throw new Error('Результат записи не подтверждён. Проверьте объект в 1С перед повторной попыткой.', { cause: err })
      }
      const savedKey = saved?.Ref_Key ?? key
      const base = { state: 'saved', entitySet, key: savedKey, ...(saved?.Number ? { number: saved.Number } : {}) }
      let confirmed
      try {
        if (!savedKey) throw new Error('1С не вернула ключ')
        confirmed = await client.entity(entitySet, savedKey).get()
        if (!confirmed || typeof confirmed !== 'object' || Array.isArray(confirmed)) throw new Error('Неверный ответ контрольного чтения')
      } catch {
        return { summary: '1С подтвердила запись, но повторное чтение не удалось. Проверьте объект по ключу.',
          data: { ...base, verification: { state: 'unavailable' } } }
      }
      const differentFields = Object.keys(payload).filter(field =>
        !matchesSubmitted(confirmed[field], payload[field]))
      if (confirmed.Ref_Key !== savedKey) differentFields.push('Ref_Key')
      if (entitySet.startsWith('Document_') && confirmed.Posted !== false) differentFields.push('Posted')
      return { summary: differentFields.length ? 'Запись прочитана обратно. Проверьте отличия значений, возвращённых 1С.' :
        '1С подтвердила запись. Объект прочитан обратно.',
        data: { ...base, verification: { state: differentFields.length ? 'differences' : 'verified',
          differentFields, overview: shortReview(entitySet, key, confirmed, {}),
          fields: Object.fromEntries(Object.keys(payload).map(field => [field, confirmed[field]])),
          ...(entitySet.startsWith('Document_') ? { posted: confirmed.Posted } : {}) } } }
    },
  }
}
