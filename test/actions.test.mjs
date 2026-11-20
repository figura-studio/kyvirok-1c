import assert from 'node:assert/strict'
import test from 'node:test'
import { makeApprovalQueue } from '../approval.mjs'
import { makeActions } from '../actions.mjs'
import { policySchema } from '../changes.mjs'

const key = 'e653f2d7-8a8e-4611-a839-c51aa596822f'
const entitySet = 'Document_Заказ'
const accept = async () => ({ action: 'accept', content: { confirm: true } })
function fixture() {
  const state = { writes: [], current: { Ref_Key: key, DataVersion: 'v1', Posted: false, DeletionMark: false,
    Number: '000125', СуммаДокумента: '6283.49', Контрагент_Key: key }, revoked: false }
  const policy = policySchema.parse({ demo: { [entitySet]: { actions: ['post', 'unpost', 'mark_deletion', 'unmark_deletion'] } } })
  const handle = { async get() { return structuredClone(state.current) }, withHeader(name, value) {
    assert.equal(name, 'If-Match'); assert.equal(value, state.current.DataVersion); return this
  }, async patch(data, options) {
    assert.equal(options.retry, false)
    state.writes.push({ data, options }); Object.assign(state.current, data, { DataVersion: 'new' })
  } }
  const entry = { client: { baseUrl: 'http://local/demo/odata/standard.odata', entity: () => handle,
    async transportPost(url, body, options, set, headers) {
      assert.equal(body, undefined); assert.equal(options.retry, false); assert.equal(headers['If-Match'], state.current.DataVersion)
      state.writes.push({ url })
      if (state.failWrite) throw new Error('dropped reply')
      state.current.Posted = url.includes('/Post?'); state.current.DataVersion += 'x'
    } }, index: { entitySetToType: { [entitySet]: entitySet }, schemas: {
    [entitySet]: { properties: { DeletionMark: { type: 'Edm.Boolean' } } } } },
    edmx: { entityContainer: { functionImports: ['Post', 'Unpost'].map(name => ({ name, httpMethod: 'POST',
      isBindable: true, parameters: [{ name: 'bindingParameter', type: 'StandardODATA.' + entitySet }] })) } } }
  const pool = { async get() { return entry } }
  const queue = makeApprovalQueue()
  const actions = makeActions(pool, policy, queue, () => { if (state.revoked) throw new Error('revoked') })
  const preview = action => actions.preview({ connection: 'demo', entitySet, key, action })
  return { state, entry, actions, queue, preview }
}

test('post/unpost and deletion flags each need a new approval and verify the resulting state', async () => {
  const { state, preview, queue } = fixture()
  for (const action of ['post', 'unpost', 'mark_deletion', 'unmark_deletion']) {
    const before = state.writes.length
    const plan = await preview(action)
    assert.equal(state.writes.length, before)
    const result = await queue.apply(plan.data.reviewId, async text => {
      assert.match(text, /6283.49/); assert.match(text, /000125/)
      return accept()
    })
    assert.equal(result.data.verification.state, 'verified')
    assert.equal(state.writes.length, before + 1)
    await assert.rejects(queue.apply(plan.data.reviewId, accept), /использован/)
  }
  assert.match(state.writes[0].url, /\/Post\?PostingModeOperational=false$/)
  assert.match(state.writes[1].url, /\/Unpost$/)
})

test('native actions reject absent permission, absent metadata, changed version, changed policy and refusals', async () => {
  const { state, entry, actions, preview, queue } = fixture()
  await assert.rejects(actions.preview({ connection: 'other', entitySet, key, action: 'post' }), /не разрешено/)
  await assert.rejects(actions.preview({ connection: 'demo', entitySet, key, action: 'delete' }), /не разрешено/)
  for (const answer of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }, { action: 'unsupported' }]) {
    const plan = await preview('post')
    assert.equal((await queue.apply(plan.data.reviewId, async () => answer)).data.state, 'cancelled')
  }
  let plan = await preview('post')
  await assert.rejects(queue.apply(plan.data.reviewId, async () => { state.current.DataVersion = 'changed'; return accept() }), /изменился/)
  plan = await preview('post')
  await assert.rejects(queue.apply(plan.data.reviewId, async () => { state.revoked = true; return accept() }), /revoked/)
  state.revoked = false
  entry.edmx.entityContainer.functionImports = []
  await assert.rejects(preview('post'), /метаданных/)
  assert.equal(state.writes.length, 0)
})

test('posting never repeats an uncertain write and refuses automatic repost or marking posted documents', async () => {
  const { state, preview, queue } = fixture()
  state.failWrite = true
  const plan = await preview('post')
  assert.equal((await queue.apply(plan.data.reviewId, accept)).data.state, 'unknown')
  assert.equal(state.writes.length, 1)
  state.current.Posted = true
  await assert.rejects(preview('post'), /непроведённый/)
  await assert.rejects(preview('mark_deletion'), /отмените проведение/)
})

test('approval expires while the human waits and cannot be raced by concurrent apply calls', async () => {
  const queue = makeApprovalQueue(); let count = 0
  const item = { review: { action: 'test' }, check() {}, execute() { count++; return { data: {} } } }
  let plan = queue.add({ ...item, expiresAt: Date.now() + 20 })
  await assert.rejects(queue.apply(plan.data.reviewId, async () => {
    await new Promise(resolve => setTimeout(resolve, 35)); return accept()
  }), /истёк/)
  plan = queue.add(item)
  const results = await Promise.allSettled([queue.apply(plan.data.reviewId, accept), queue.apply(plan.data.reviewId, accept)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(count, 1)
})
