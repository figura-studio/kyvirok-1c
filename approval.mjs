import { randomUUID } from 'node:crypto'

export const reviewTTL = 5 * 60_000
export function confirmationText(review) {
  const text = JSON.stringify(review, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)
    .replace(/[`<>\u202a-\u202e\u2066-\u2069\u2028\u2029]/g,
      ch => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
  if (Buffer.byteLength(text) > 24_000) throw new Error('Предпросмотр слишком велик. Уменьшите объём одной операции.')
  return 'Проверьте действие и все данные. Галочка разрешает только эту операцию, один раз.\n\n```json\n' + text + '\n```'
}

// Only this process owns execution closures. The agent receives an opaque ID,
// never a boolean parameter that could stand in for a human approval.
export function makeApprovalQueue() {
  const pending = new Map()
  return {
    add({ review, check, execute, expiresAt = Date.now() + reviewTTL }) {
      const now = Date.now()
      for (const [id, item] of pending) if (item.expiresAt <= now) pending.delete(id)
      if (pending.size >= 100) throw new Error('Достигнут лимит предпросмотров.')
      expiresAt = Math.min(expiresAt, now + reviewTTL)
      if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Предпросмотр уже истёк.')
      const reviewId = randomUUID()
      const snapshot = structuredClone(review)
      const message = confirmationText(snapshot)
      pending.set(reviewId, { message, check, execute, expiresAt })
      return { summary: 'Покажите полный предпросмотр. Выполнение требует отдельной формы подтверждения.',
        data: { reviewId, expiresAt: new Date(expiresAt).toISOString(), review: snapshot } }
    },
    async apply(id, confirm) {
      const item = pending.get(id)
      pending.delete(id)
      if (!item || item.expiresAt <= Date.now()) throw new Error('Предпросмотр истёк или уже использован.')
      await item.check()
      let answer
      try { answer = await confirm(item.message) } catch { answer = { action: 'error' } }
      if (answer?.action !== 'accept' || answer.content?.confirm !== true) {
        const reason = answer?.action === 'accept' ? 'unchecked' :
          ['decline', 'cancel', 'unsupported', 'error'].includes(answer?.action) ? answer.action : 'error'
        return { summary: 'Явное подтверждение формы не получено. Операция не выполнялась.',
          data: { state: 'cancelled', reason } }
      }
      if (item.expiresAt <= Date.now()) throw new Error('Предпросмотр истёк во время ожидания подтверждения.')
      await item.check()
      if (item.expiresAt <= Date.now()) throw new Error('Предпросмотр истёк во время проверки.')
      return item.execute(() => {
        if (item.expiresAt <= Date.now()) throw new Error('Предпросмотр истёк до выполнения.')
      })
    },
  }
}
