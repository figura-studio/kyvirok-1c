import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeExternalEdo, createDiadocTransport, edoPolicySchema, makeEdoSecrets } from '../edo.mjs'
import { loadEdoPolicy } from '../policy.mjs'
import { makeApprovalQueue } from '../approval.mjs'
import { makeArtifacts } from '../artifacts.mjs'
import { buildServer } from '../server.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const box = randomUUID(), messageId = randomUUID(), entityId = randomUUID()
const input = { account: 'demo_diadok', messageId, entityId }
const pdf = Buffer.from('%PDF-1.7\nFake test PDF only\n%%EOF')
const accept = async () => ({ action: 'accept', content: { confirm: true } })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-edo-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = { revoked: false, printCalls: 0, calls: [], pending: false, corrupt: false,
    doc: { MessageId: messageId, EntityId: entityId, IndexKey: 'opaque+/=cursor', DocumentNumber: '25',
      DocflowStatus: { PrimaryStatus: { StatusText: 'Ожидается подпись контрагента' } },
      UniversalTransferDocumentMetadata: { Total: '6283.49', Currency: 643 },
      LastModificationTimestampTicks: '639065725178753287', Content: { Data: 'never return this' } } }
  const settings = { policy: edoPolicySchema.parse({ demo_diadok: { provider: 'diadok', boxId: box,
    operations: ['documents.read', 'document.print'] } }), assertCurrent() { if (state.revoked) throw new Error('revoked') } }
  const fetcher = async (url, options) => {
    state.calls.push({ url: String(url), ...options })
    assert.equal(url.origin, 'https://diadoc-api.kontur.ru')
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, 'Bearer test-token')
    assert.equal(url.searchParams.get('boxId'), box)
    const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/GetBox') return reply({ BoxIdGuid: box, Title: 'Demo', Organization: { FullName: 'Demo', Inn: '0000000000' } })
    if (url.pathname === '/V4/GetDocuments') {
      assert.equal(options.method, 'POST')
      return reply({ TotalCount: 2, Documents: [structuredClone(state.doc)] })
    }
    if (url.pathname === '/V3/GetDocument') {
      assert.equal(url.searchParams.get('injectEntityContent'), 'false')
      return reply(structuredClone(state.doc))
    }
    if (url.pathname === '/GeneratePrintForm') {
      state.printCalls++
      assert.equal(url.searchParams.get('documentId'), entityId)
      if (state.changeDuringPrint) state.doc.DocumentNumber = 'changed'
      if (state.pending) return new Response('', { headers: { 'retry-after': '1' } })
      return new Response(state.corrupt ? 'not pdf' : pdf)
    }
    throw new Error('Unexpected route')
  }
  const factory = secret => createDiadocTransport(secret, fetcher)
  const queue = makeApprovalQueue(), artifacts = makeArtifacts(dir)
  const secret = async () => 'test-token'
  const edo = makeExternalEdo(settings, queue, artifacts, secret, factory)
  return { edo, queue, settings, factory, secret, state, dir, artifacts }
}

test('separate Diadoc reads use V4 filters/pagination; never expose content or claim a signature integration', async t => {
  const { edo, state } = await fixture(t)
  assert.equal(edo.connections().data.accounts[0].sendingAvailable, false)
  const result = await edo.list({ account: input.account, category: 'Incoming', count: 1,
    fromDate: '2026-11-01', toDate: '2026-11-24', documentNumbers: ['25'], departmentIds: [box] })
  assert.equal(result.data.documents[0].UniversalTransferDocumentMetadata.Total, '6283.49')
  assert.equal(result.data.documents[0].Content, undefined)
  assert.equal(result.data.nextAfterIndexKey, 'opaque+/=cursor')
  assert.equal(result.data.mayHaveMore, true)
  const body = JSON.parse(state.calls[0].body)
  assert.equal(body.FromDocumentDate, '01.11.2026'); assert.deepEqual(body.DocumentNumbers, ['25'])
  assert.deepEqual(body.Departments, [{ DepartmentId: box, ExcludeSubdepartments: false }])
  await assert.rejects(edo.list({ account: input.account, category: 'Incoming', count: 1, afterIndexKey: 'opaque+/=cursor' }), /ключ страницы/)
  assert.equal((await edo.diagnose(input.account)).data.readVerified, true)
  assert.equal(state.calls.some(c => c.url.includes('GetMyOrganizations')), false)
  await assert.rejects(edo.list({ account: input.account, category: 'Incoming', fromDate: '2026-12-01', toDate: '2026-11-01' }), /позже/)
})

test('PDF requires exact one-use approval, refusal/revocation and changed document stop printing', async t => {
  const { edo, queue, state, artifacts } = await fixture(t)
  let plan = await edo.previewPrint(input)
  assert.equal(state.printCalls, 0)
  assert.equal((await queue.apply(plan.data.reviewId, async () => ({ action: 'accept', content: { confirm: false } }))).data.state, 'cancelled')
  assert.equal(state.printCalls, 0)
  plan = await edo.previewPrint(input)
  await assert.rejects(queue.apply(plan.data.reviewId, async () => { state.revoked = true; return accept() }), /revoked/)
  state.revoked = false
  plan = await edo.previewPrint(input)
  state.doc.DocumentNumber = '26'
  await assert.rejects(queue.apply(plan.data.reviewId, accept), /изменился/)
  assert.equal(state.printCalls, 0)
  plan = await edo.previewPrint(input)
  const result = await queue.apply(plan.data.reviewId, async text => {
    assert.match(text, /6283.49/); assert.match(text, /26/); assert.match(text, /PDF/); return accept()
  })
  assert.deepEqual(await readFile(result.data.files[0].localPath), pdf)
  const resource = await artifacts.read(result.data.files[0].uri.split('/').at(-1))
  assert.equal(resource.contents[0].blob, pdf.toString('base64'))
  await assert.rejects(queue.apply(plan.data.reviewId, accept), /использован/)
  state.changeDuringPrint = true
  plan = await edo.previewPrint(input)
  await assert.rejects(queue.apply(plan.data.reviewId, accept), /во время печати/)
})

test('pending PDF respects Retry-After, survives only within its approved request and rejects non-PDF', async t => {
  const { edo, queue, state } = await fixture(t)
  state.pending = true
  const plan = await edo.previewPrint(input)
  const result = await queue.apply(plan.data.reviewId, accept)
  assert.equal(result.data.state, 'pending')
  assert.equal((await edo.printStatus(result.data.requestId)).data.state, 'pending')
  assert.equal(state.printCalls, 1)
  await assert.rejects(edo.printStatus(randomUUID()), /отсутствует/)
  // Test the clock boundary without waiting in real time.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 2000
    state.pending = false; state.corrupt = true
    await assert.rejects(edo.printStatus(result.data.requestId), /не вернул PDF/)
    state.corrupt = false
    assert.equal((await edo.printStatus(result.data.requestId)).data.state, 'completed')
  } finally { Date.now = realNow }
  await assert.rejects(edo.printStatus(result.data.requestId), /отсутствует/)
})

test('transport denies unknown routes and redirects; redacts errors; enforces byte limits and exact 64-bit JSON', async () => {
  let calls = 0, mode = 'redirect'
  const request = createDiadocTransport(async () => 'do-not-print-secret', async (url, options) => {
    calls++; assert.equal(options.redirect, 'manual')
    if (mode === 'redirect') return new Response('do-not-print-secret', { status: 302, headers: { location: 'https://outside.example/' } })
    if (mode === '401') return new Response('do-not-print-secret', { status: 401 })
    if (mode === 'large') return new Response('x', { headers: { 'content-length': '99999999' } })
    if (mode === 'chunked') return new Response('x'.repeat(2 * 1024 * 1024 + 1))
    if (mode === 'network') throw new Error('do-not-print-secret')
    return new Response('{"ticks":639065725178753287}')
  })
  await assert.rejects(request('/PostMessage', {}, {}), /Недопустимая/)
  await assert.rejects(request('https://evil.example', {}), /Недопустимая/)
  assert.equal(calls, 0)
  for (const code of ['redirect', '401', 'large', 'chunked', 'network']) {
    mode = code
    await assert.rejects(request('/GetBox', {}), error => { assert.doesNotMatch(error.message, /do-not-print-secret/); return true })
  }
  assert.equal(calls, 5)
  mode = 'ok'; assert.equal((await request('/GetBox', {})).ticks, '639065725178753287')
})

test('operator policy is opt-in and invalidation blocks use; 1C passwords never substitute for tokens', async t => {
  const { dir } = await fixture(t)
  const policy = loadEdoPolicy(dir, '')
  assert.deepEqual(policy.policy, {})
  assert.throws(() => edoPolicySchema.parse({ demo: { provider: 'diadok', boxId: box, operations: ['edo.send'] } }))
  assert.throws(() => edoPolicySchema.parse({ demo: { provider: 'diadok', boxId: box, baseUrl: 'http://outside.example' } }))
  await writeFile(join(dir, 'edo-policy.json'), '{}')
  assert.throws(policy.assertCurrent, /Перезапустите/)
  await assert.rejects(makeEdoSecrets(dir)('missing_test_account'), /токен в чат/)
})

test('MCP tools → Diadoc transport → human confirmation → PDF resource, independent of an OData pool', async t => {
  const { settings, factory, secret, state, dir } = await fixture(t)
  const server = buildServer({}, {}, undefined, { edoState: settings, edoTransport: factory, edoSecret: secret, artifactDir: dir })
  const client = new Client({ name: 'edo-test', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  let answer = { action: 'decline' }
  client.setRequestHandler(ElicitRequestSchema, async request => {
    assert.equal(request.params.requestedSchema.properties.confirm.default, false)
    assert.match(request.params.message, /6283.49/); return answer
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport); await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, undefined, JSON.stringify(result)); return result
  }
  assert.equal((await call('get_edo_connections')).structuredContent.accounts.length, 1)
  await call('diagnose_edo_connection', { account: input.account })
  await call('list_edo_documents', { account: input.account, category: 'Outgoing' })
  let plan = (await call('preview_edo_print', input)).structuredContent
  assert.equal((await call('apply_reviewed_operation', { reviewId: plan.reviewId })).structuredContent.state, 'cancelled')
  assert.equal(state.printCalls, 0)
  answer = await accept(); plan = (await call('preview_edo_print', input)).structuredContent
  const result = await call('apply_reviewed_operation', { reviewId: plan.reviewId })
  const link = result.content.find(c => c.type === 'resource_link')
  assert.equal(link.mimeType, 'application/pdf')
  assert.equal((await client.readResource({ uri: link.uri })).contents[0].blob, pdf.toString('base64'))
})
