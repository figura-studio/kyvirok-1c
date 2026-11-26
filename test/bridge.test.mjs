import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { makeBridge, hashRequest, createBridgeTransport, bridgePolicySchema } from '../bridge.mjs'
import { makeApprovalQueue } from '../approval.mjs'
import { makeArtifacts } from '../artifacts.mjs'
import { loadBridgePolicy } from '../policy.mjs'

const accept = async () => ({ action: 'accept', content: { confirm: true } })
const bytes = Buffer.from('%PDF-1.4\nTest fixture, not a real UPD\n%%EOF')
const file = { id: randomUUID(), name: 'document.pdf', mimeType: 'application/pdf', size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }
const sender = { id: 'org', name: 'Тестовая организация', inn: '0000000000' }
const recipient = { id: 'customer', name: 'Тестовый покупатель', inn: '1111111111' }
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-bridge-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = { executions: 0, previews: [], revoked: false, plans: new Map(), replies: new Map() }
  const policy = bridgePolicySchema.parse({ demo: { servicePath: '/demo/hs/kyvirok/v1',
    operations: ['print.document', 'edo.send', 'edo.sign'], defaultEdoProvider: 'diadok', edoProviders: ['1c-edo', 'diadok', 'sbis'] } })
  const request = async (path, body) => {
    if (path === 'capabilities') return { protocol: 'kyvirok-bridge/1', configuration: { name: 'Test', version: '1' },
      operations: ['print.document', 'edo.send', 'edo.sign'].map(name => ({ name, title: name, available: true,
        kind: name === 'print.document' ? 'print' : name === 'edo.send' ? 'edo_send' : 'edo_sign',
        inputSchema: { type: 'object' }, providers: ['1c-edo', 'diadok', 'sbis'] })) }
    if (path === 'plans') {
      state.previews.push(structuredClone(body))
      const plan = { planId: randomUUID(), requestHash: body.requestHash, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        review: { title: 'Операция', effects: [body.operation], changes: [], sourceVersions: { doc: 'v1' },
          details: { ...body.parameters }, files: [file], ...(body.provider ? { edo: { provider: body.provider,
            sender, recipient, senderBoxId: 'box-a', recipientBoxId: 'box-b',
            documents: [{ id: 'doc', number: '25', date: '2026-11-20', total: '6283.49', currency: 'RUB', files: [file] }],
            signature: { required: true, state: body.operation === 'edo.sign' ? 'not_signed' : 'signed',
              certificateThumbprint: 'AA:BB', signer: 'Тестовый сотрудник' } } } : {}) } }
      if (state.mutatePlan) state.mutatePlan(plan)
      state.plans.set(plan.planId, structuredClone(plan))
      return plan
    }
    if (path.endsWith('/execute')) {
      const id = path.split('/')[1]; const plan = state.plans.get(id)
      assert.equal(body.requestHash, plan.requestHash); assert.equal(body.reviewHash, hashRequest(plan.review))
      state.executions++
      const result = { planId: id, requestHash: body.requestHash, state: 'completed',
        message: 'Test adapter completed', receiptId: 'receipt-1', verification: { confirmed: true }, files: [file] }
      state.replies.set(id, result)
      if (state.dropReply) throw new Error('reply lost')
      return result
    }
    if (path.endsWith('/status')) return state.replies.get(path.split('/')[1])
    if (path.startsWith('files/')) return state.corruptFile ? Buffer.from('bad') : bytes
    throw new Error('unexpected ' + path)
  }
  const settings = { policy, assertCurrent() { if (state.revoked) throw new Error('revoked') } }
  const queue = makeApprovalQueue(), artifacts = makeArtifacts(dir)
  const bridge = makeBridge({ async get() { return {} } }, settings, queue, artifacts, () => request)
  return { state, bridge, queue, artifacts, dir }
}

test('all three EDI providers use an immutable recipient/file/signature review and one explicit approval', async t => {
  const { state, bridge, queue, artifacts } = await fixture(t)
  for (const provider of ['1c-edo', 'diadok', 'sbis']) {
    const parameters = { documentId: 'doc' }
    const before = state.executions
    const plan = await bridge.preview({ connection: 'demo', operation: 'edo.send', provider, parameters })
    assert.equal(state.executions, before)
    parameters.documentId = 'different'
    const result = await queue.apply(plan.data.reviewId, async text => {
      assert.match(text, /Тестовый покупатель/); assert.match(text, /6283.49/); assert.match(text, /AA:BB/)
      assert.match(text, new RegExp(file.sha256)); assert.doesNotMatch(text, /different/)
      return accept()
    })
    assert.equal(state.executions, before + 1)
    assert.equal(result.data.state, 'completed')
    assert.deepEqual(await readFile(result.data.files[0].localPath), bytes)
    const resource = await artifacts.read(result.data.files[0].uri.split('/').at(-1))
    assert.equal(resource.contents[0].blob, bytes.toString('base64'))
    await assert.rejects(queue.apply(plan.data.reviewId, accept), /использован/)
  }
  const defaultPlan = await bridge.preview({ connection: 'demo', operation: 'edo.send', parameters: {} })
  assert.equal(defaultPlan.data.review.edo.provider, 'diadok')
})

test('refusal, revocation, wrong operator, wrong request hash or missing signer cannot send', async t => {
  const { state, bridge, queue } = await fixture(t)
  const input = { connection: 'demo', operation: 'edo.send', provider: 'sbis', parameters: {} }
  let plan = await bridge.preview(input)
  assert.equal((await queue.apply(plan.data.reviewId, async () => ({ action: 'accept', content: { confirm: false } }))).data.state, 'cancelled')
  plan = await bridge.preview(input)
  await assert.rejects(queue.apply(plan.data.reviewId, async () => { state.revoked = true; return accept() }), /revoked/)
  state.revoked = false
  state.mutatePlan = p => { p.review.edo.provider = 'diadok' }
  await assert.rejects(bridge.preview(input), /оператор/)
  state.mutatePlan = p => { p.requestHash = '0'.repeat(64) }
  await assert.rejects(bridge.preview(input), /другой операции/)
  state.mutatePlan = p => { delete p.review.edo.signature }
  await assert.rejects(bridge.preview(input), /сертификате/)
  state.mutatePlan = p => { p.review.edo.signature.state = 'not_signed' }
  await assert.rejects(bridge.preview(input), /отдельно подпишите/)
  assert.equal(state.executions, 0)
})

test('a lost EDI reply is checked by plan ID without resending; corrupt artifact is not delivered', async t => {
  const { state, bridge, queue } = await fixture(t)
  state.dropReply = true
  const plan = await bridge.preview({ connection: 'demo', operation: 'edo.send', parameters: {} })
  const result = await queue.apply(plan.data.reviewId, accept)
  assert.equal(result.data.state, 'unknown')
  state.corruptFile = true
  const status = await bridge.status({ planId: result.data.planId })
  assert.equal(status.data.state, 'completed')
  assert.equal(status.data.files.length, 0)
  assert.equal(status.data.unavailableFiles.length, 1)
  assert.equal(state.executions, 1)
})

test('bridge policy rejects unknown providers, defaults off and detects settings changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-bridge-policy-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const empty = loadBridgePolicy(dir, '')
  assert.equal(empty.diagnostics().writeEnabled, false)
  assert.throws(() => bridgePolicySchema.parse({ demo: { servicePath: '/demo/hs/kyvirok/v1', operations: [], edoProviders: ['other'] } }))
  await writeFile(join(dir, 'bridge-policy.json'), JSON.stringify({ demo: { servicePath: '/demo/hs/kyvirok/v1', operations: ['print.document'] } }))
  assert.throws(empty.assertCurrent, /Перезапустите/)
})

test('HTTP bridge never forwards credentials on redirects and enforces publication and response size', async t => {
  let mode = 'ok', calls = 0
  const http = createServer((req, res) => {
    calls++; assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('test:secret').toString('base64'))
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); return res.end() }
    if (mode === 'large') { res.setHeader('Content-Length', '900000'); return res.end('x') }
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => http.close(resolve)))
  const entry = { connection: { baseUrl: 'http://127.0.0.1:' + http.address().port + '/demo/odata/standard.odata',
    auth: { username: 'test', password: 'secret' } } }
  const request = createBridgeTransport(entry, { servicePath: '/demo/hs/kyvirok/v1' })
  assert.deepEqual(await request('capabilities'), { ok: true })
  mode = 'redirect'; await assert.rejects(request('capabilities'), /HTTP 302/); assert.equal(calls, 2)
  mode = 'large'; await assert.rejects(request('capabilities'), /слишком велик/)
  assert.throws(() => createBridgeTransport(entry, { servicePath: '/other/hs/kyvirok/v1' }), /той же публикации/)
  await assert.rejects(request('https://outside.example/'), /маршрут/)
})
