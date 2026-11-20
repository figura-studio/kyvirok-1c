import { nativeActionNames, shortReview } from './changes.mjs'

const labels = {
  post: 'Провести документ', unpost: 'Отменить проведение документа',
  mark_deletion: 'Установить пометку удаления', unmark_deletion: 'Снять пометку удаления',
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function validateState(entitySet, action, record, key) {
  if (!record || record.Ref_Key !== key || typeof record.DeletionMark !== 'boolean' ||
      (entitySet.startsWith('Document_') && typeof record.Posted !== 'boolean')) {
    throw new Error('1С не вернула однозначное состояние объекта.')
  }
  if (typeof record.DataVersion !== 'string' || !record.DataVersion || record.DataVersion === '*' ||
      /[\r\n]/.test(record.DataVersion)) throw new Error('Нет версии объекта для проверки.')
  if (action === 'post' && (record.Posted || record.DeletionMark)) throw new Error('Проводить можно только непроведённый документ без пометки удаления.')
  if (action === 'unpost' && !record.Posted) throw new Error('Документ уже не проведён.')
  if (action === 'mark_deletion' && (record.Posted || record.DeletionMark)) throw new Error('Сначала отдельно отмените проведение; повторная пометка не нужна.')
  if (action === 'unmark_deletion' && !record.DeletionMark) throw new Error('Пометка удаления уже снята.')
}

export function supportsAction(entry, entitySet, action) {
  if (!Object.hasOwn(entry.index.entitySetToType, entitySet)) return false
  if (action === 'post' || action === 'unpost') {
    const method = action === 'post' ? 'Post' : 'Unpost'
    return entitySet.startsWith('Document_') && entry.edmx?.entityContainer.functionImports.some(fn =>
      fn.name === method && fn.httpMethod === 'POST' && fn.isBindable === true &&
      (fn.entitySetPath === entitySet || fn.parameters.some(p => p.name === 'bindingParameter' &&
        p.type.split('.').at(-1) === entry.index.entitySetToType[entitySet]))) === true
  }
  const type = entry.index.schemas[entry.index.entitySetToType[entitySet]]
  return /^(Catalog|Document)_/u.test(entitySet) && type?.properties.DeletionMark?.type === 'Edm.Boolean'
}

export function makeActions(pool, policy, queue, assertPolicyCurrent = () => {}) {
  function permitted(connection, entitySet, action) {
    assertPolicyCurrent()
    if (!nativeActionNames.includes(action) || !/^(Catalog|Document)_[\p{L}\p{N}_]+$/u.test(entitySet) ||
        !Object.hasOwn(policy, connection) || !Object.hasOwn(policy[connection], entitySet) ||
        !policy[connection][entitySet].actions?.includes(action)) throw new Error('Действие не разрешено правилами записи.')
  }
  return {
    async capabilities(connection) {
      assertPolicyCurrent()
      const entry = await pool.get(connection)
      const entities = Object.hasOwn(policy, connection) ? policy[connection] : {}
      return Object.fromEntries(Object.entries(entities).map(([entitySet, rule]) => [entitySet, {
        create: rule.create ?? [], update: rule.update ?? [],
        actions: (rule.actions ?? []).map(action => ({ action, available: supportsAction(entry, entitySet, action) })),
      }]))
    },
    async preview({ connection, entitySet, key, action }) {
      permitted(connection, entitySet, action)
      if (!uuid.test(key)) throw new Error('Неверный ключ объекта.')
      const entry = await pool.get(connection)
      if (!supportsAction(entry, entitySet, action)) throw new Error('Действие отсутствует в опубликованных метаданных 1С.')
      const { client } = entry
      const current = await client.entity(entitySet, key).get()
      validateState(entitySet, action, current, key)
      const version = current.DataVersion
      const posting = action === 'post' || action === 'unpost'
      const field = posting ? 'Posted' : 'DeletionMark'
      const target = action === 'post' || action === 'mark_deletion'
      const review = { база: connection, действие: labels[action], объект: entitySet, ключ: key,
        сводка: shortReview(entitySet, key, current, {}),
        изменение: { поле: field, было: current[field], станет: target },
        последствия: posting ? '1С изменит учётные движения по правилам конфигурации. Перечень проводок заранее не рассчитан.' :
          'Меняется только флаг данного объекта; физического удаления и каскадной обработки нет.',
        контрольВерсии: posting ? 'Повторное чтение перед действием. OData не гарантирует атомарную проверку If-Match для Post/Unpost; не редактируйте документ параллельно.' :
          'If-Match: сервер отклоняет изменение устаревшей версии.',
        ...(action === 'post' ? { режимПроведения: 'Неоперативный (PostingModeOperational=false)' } : {}),
        данныеДокумента: current }
      return queue.add({ review,
        check: () => permitted(connection, entitySet, action),
        execute: async assertFresh => {
          const latest = await client.entity(entitySet, key).get()
          if (latest?.DataVersion !== version) throw new Error('Документ изменился. Подготовьте новый предпросмотр.')
          validateState(entitySet, action, latest, key)
          permitted(connection, entitySet, action)
          assertFresh()
          try {
            if (posting) {
              const url = `${client.baseUrl}/${entitySet}(guid'${key}')/${action === 'post' ? 'Post?PostingModeOperational=false' : 'Unpost'}`
              await client.transportPost(url, undefined, { retry: false }, entitySet, { 'If-Match': version })
            } else {
              await client.entity(entitySet, key).withHeader('If-Match', version)
                .patch({ [field]: target }, { expectVersion: version, retry: false })
            }
          } catch (error) {
            // Even an HTTP error from an intermediary can follow a committed operation.
            return { summary: 'Нет подтверждённого результата. Сначала прочитайте объект в 1С; не повторяйте автоматически.',
              data: { state: 'unknown', connection, entitySet, key, action } }
          }
          let saved
          try { saved = await client.entity(entitySet, key).get() } catch {}
          const verified = saved?.Ref_Key === key && saved?.[field] === target
          return { summary: verified ? '1С выполнила действие. Состояние объекта прочитано обратно.' :
            '1С приняла действие; контрольное состояние требует проверки.',
            data: { state: 'executed', connection, entitySet, key, action,
              verification: { state: !saved ? 'unavailable' : verified ? 'verified' : 'differences',
                expected: { [field]: target }, actual: saved ? { [field]: saved[field] } : null,
                ...(posting ? { accountingEntriesChecked: false } : {}) } } }
        },
      })
    },
  }
}
