import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEdoDrafts, validateDraftBody } from '../edo-drafts.mjs'
import { createDiadocTransport, edoPolicySchema } from '../edo.mjs'
import { makeApprovalQueue } from '../approval.mjs'
import { buildServer } from '../server.mjs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Deliberately fictional fixture, not an FNS-valid production document.
const xml = '<?xml version="1.0" encoding="UTF-8"?><Файл ИдФайл="DEMO"><Документ><СвСчФакт НомерДок="TEST-17" ДатаДок="26.11.2026"><СвПрод><ИдСв><СвЮЛУч ИННЮЛ="0000000000" КПП="000000000" НаимОрг="Demo seller"/></ИдСв></СвПрод><СвПокуп><ИдСв><СвЮЛУч ИННЮЛ="1111111111" КПП="111111111" НаимОрг="Demo buyer"/></ИдСв></СвПокуп></СвСчФакт></Документ></Файл>'
const accept = async () => ({ action: 'accept', content: { confirm: true } })
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-draft-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const importDirectory = join(dir, 'imports'), journal = join(dir, '.edo-drafts')
  await mkdir(importDirectory); await writeFile(join(importDirectory, 'demo.xml'), xml)
  const from = randomUUID(), to = randomUUID(), messageId = randomUUID(), entityId = randomUUID()
  const data = { calls: [], revoked: false, mode: 'ok', titleIndex: 0 }
  const settings = { policy: edoPolicySchema.parse({ office: { provider: 'diadok', boxId: from,
    operations: ['documents.read', 'draft.create'], importDirectory } }), assertCurrent() { if (data.revoked) throw new Error('revoked') } }
  const fetcher = async (url, options) => {
    data.calls.push({ url, ...options })
    assert.equal(url.origin, 'https://diadoc-api.kontur.ru')
    const json = value => new Response(JSON.stringify(value))
    if (url.pathname === '/GetBox') {
      const sender = url.searchParams.get('boxId') === from
      return json({ BoxIdGuid: sender ? from : to, Organization: { FullName: sender ? 'Demo seller' : 'Demo buyer',
        Inn: data.wrongInn ? '9999999999' : sender ? '0000000000' : '1111111111', Kpp: sender ? '000000000' : '111111111' } })
    }
    if (url.pathname === '/DetectDocumentTitles') {
      assert.equal(options.headers['Content-Type'], 'application/octet-stream')
      assert.equal(options.body.toString(), xml)
      if (data.changeAfterDetect) await writeFile(join(importDirectory, 'demo.xml'), xml.replace('TEST-17', 'CHANGED'))
      return json({ DocumentTitles: [{ TypeNamedId: 'UniversalTransferDocument', Function: 'СЧФДОП', Version: 'demo', TitleIndex: data.titleIndex }] })
    }
    if (url.pathname === '/V3/PostMessage') {
      const body = JSON.parse(options.body)
      validateDraftBody(body)
      assert.equal(Buffer.from(body.DocumentAttachments[0].SignedContent.Content, 'base64').toString(), xml)
      assert.equal(body.IsDraft, true); assert.equal(body.StrictDraftValidation, true)
      assert.equal(body.DocumentAttachments[0].SignedContent.Signature, undefined)
      assert.match(url.searchParams.get('operationId'), /^[0-9a-f-]{36}$/)
      if (data.mode === 'timeout') throw new Error('network error with secret')
      if (data.mode === 'pending') return new Response(null, { status: 204, headers: { 'Retry-After': '10' } })
      return json({ MessageId: messageId, FromBoxId: from, ToBoxId: to,
        MessageType: data.mode === 'wrong-response' ? 'Letter' : 'Draft', Entities: [{ EntityId: entityId }] })
    }
    throw new Error('Forbidden route')
  }
  const secret = async () => 'demo-token', factory = getToken => createDiadocTransport(getToken, fetcher)
  const queue = makeApprovalQueue(), drafts = makeEdoDrafts(settings, queue, journal, secret, factory)
  const input = { account: 'office', fileName: 'demo.xml', recipientBoxId: to }
  return { dir, journal, importDirectory, settings, data, factory, queue, drafts, input, secret, messageId }
}
const uploads = f => f.data.calls.filter(c => c.url.pathname !== '/GetBox')
const writes = f => f.data.calls.filter(c => c.url.pathname === '/V3/PostMessage')

test('draft preview is local + box reads; declined approval never uploads XML', async t => {
  const f = await fixture(t), plan = await f.drafts.preview(f.input)
  assert.equal(plan.data.review.xml, xml); assert.equal(uploads(f).length, 0)
  assert.equal((await f.queue.apply(plan.data.reviewId, async () => ({ action: 'decline' }))).data.state, 'cancelled')
  assert.equal(uploads(f).length, 0)
  await assert.rejects(f.queue.apply(plan.data.reviewId, accept), /использован/)
})

test('approval imports exact bytes once; durable receipt prevents duplicate after restart', async t => {
  const f = await fixture(t), plan = await f.drafts.preview(f.input)
  const result = await f.queue.apply(plan.data.reviewId, async text => {
    assert.match(text, /TEST-17/); assert.match(text, /Demo buyer/); assert.match(text, /sha256/); return accept()
  })
  assert.equal(result.data.state, 'created'); assert.equal(result.data.messageId, f.messageId)
  assert.equal(result.data.signingPerformed, false); assert.equal(result.data.sendingPerformed, false)
  assert.equal(writes(f).length, 1)
  const restarted = makeEdoDrafts(f.settings, makeApprovalQueue(), f.journal, f.secret, f.factory)
  await assert.rejects(restarted.preview(f.input), /уже пытались/)
  const receipt = await restarted.receipt({ account: 'office', operationId: result.data.operationId })
  assert.equal(receipt.data.state, 'created'); assert.equal(writes(f).length, 1)
  const log = await readFile(join(f.journal, 'office-' + result.data.operationId + '.json'), 'utf8')
  assert.doesNotMatch(log, /demo-token|<Файл|SignedContent/)
})

test('mutation, changed policy and mismatched parties stop import', async t => {
  const f = await fixture(t)
  let plan = await f.drafts.preview(f.input)
  await writeFile(join(f.importDirectory, 'demo.xml'), xml.replace('TEST-17', 'changed'))
  await assert.rejects(f.queue.apply(plan.data.reviewId, accept), /изменились/)
  assert.equal(uploads(f).length, 0)
  await writeFile(join(f.importDirectory, 'demo.xml'), xml)
  plan = await f.drafts.preview(f.input); f.data.revoked = true
  await assert.rejects(f.queue.apply(plan.data.reviewId, accept), /revoked/)
  f.data.revoked = false; f.data.wrongInn = true
  await assert.rejects(f.drafts.preview(f.input), /ИНН/)
  f.data.wrongInn = false; f.data.changeAfterDetect = true
  plan = await f.drafts.preview(f.input)
  await assert.rejects(f.queue.apply(plan.data.reviewId, accept), /изменились/)
  assert.equal(writes(f).length, 0)
})

test('unknown POST outcomes are recorded before transport and cannot be retried', async t => {
  for (const mode of ['timeout', 'pending', 'wrong-response']) {
    const f = await fixture(t); f.data.mode = mode
    const plan = await f.drafts.preview(f.input)
    const result = await f.queue.apply(plan.data.reviewId, accept)
    assert.equal(result.data.state, 'unknown'); assert.equal(writes(f).length, 1)
    await assert.rejects(f.drafts.preview(f.input), /уже пытались/)
    assert.equal((await f.drafts.receipt({ account: 'office', operationId: result.data.operationId })).data.state, 'unknown')
    assert.equal(writes(f).length, 1)
  }
})

test('reject traversal, DTD, non-XML, large review and buyer title; import permission is explicit', async t => {
  const f = await fixture(t)
  await assert.rejects(f.drafts.preview({ ...f.input, fileName: '../demo.xml' }))
  for (const content of ['<!DOCTYPE Файл [<!ENTITY x SYSTEM "file:///private">]>' + xml, '%PDF-1.7', xml.repeat(500)]) {
    await writeFile(join(f.importDirectory, 'demo.xml'), content)
    await assert.rejects(f.drafts.preview(f.input))
  }
  await writeFile(join(f.importDirectory, 'demo.xml'), xml.replace('</Документ>', '<Описание>' + 'x'.repeat(25000) + '</Описание></Документ>'))
  await assert.rejects(f.drafts.preview(f.input), /слишком велик/)
  await writeFile(join(f.importDirectory, 'demo.xml'), xml)
  f.data.titleIndex = 1
  const plan = await f.drafts.preview(f.input)
  await assert.rejects(f.queue.apply(plan.data.reviewId, accept), /титул продавца/)
  assert.equal(writes(f).length, 0)
  f.settings.policy.office.operations = ['documents.read']
  await assert.rejects(f.drafts.preview(f.input), /выключен/)
  assert.throws(() => edoPolicySchema.parse({ office: { provider: 'diadok', boxId: randomUUID(), operations: ['draft.create'] } }))
})

test('transport rejects send/sign flags and arbitrary fields before fetching', async () => {
  let calls = 0
  const request = createDiadocTransport(async () => 'demo', async () => { calls++; return new Response('{}') })
  const body = { FromBoxId: randomUUID(), ToBoxId: randomUUID(), IsDraft: true, LockDraft: false, StrictDraftValidation: true,
    DocumentAttachments: [{ TypeNamedId: 'Invoice', Function: 'default', Version: 'demo', SignedContent: { Content: 'eA==' } }] }
  for (const malicious of [{ ...body, IsDraft: false }, { ...body, DelaySend: true }, { ...body, StrictDraftValidation: false },
    { ...body, DocumentAttachments: [{ ...body.DocumentAttachments[0], SignedContent: { Content: 'eA==', Signature: 'eA==' } }] }]) {
    await assert.rejects(request('/V3/PostMessage', { operationId: randomUUID() }, malicious))
  }
  await assert.rejects(request('/SendDraft', {}, body)); assert.equal(calls, 0)
})

test('Windows-1251 preview preserves Cyrillic; concurrent approvals cannot create two drafts', async t => {
  const f = await fixture(t)
  const cpText = xml.replace('UTF-8', 'windows-1251')
  const cpBytes = Buffer.from([...cpText].map(c => {
    const code = c.charCodeAt(0)
    return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code
  }))
  await writeFile(join(f.importDirectory, 'demo.xml'), cpBytes)
  const cpPlan = await f.drafts.preview(f.input)
  assert.equal(cpPlan.data.review.xml, cpText)
  await writeFile(join(f.importDirectory, 'demo.xml'), xml)
  const first = await f.drafts.preview(f.input), second = await f.drafts.preview(f.input)
  const results = await Promise.allSettled([f.queue.apply(first.data.reviewId, accept), f.queue.apply(second.data.reviewId, accept)])
  assert.equal(results.filter(r => r.status === 'fulfilled' && r.value.data.state === 'created').length, 1)
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  assert.equal(writes(f).length, 1)
})

test('MCP preview → mandatory human form → unsigned draft and local receipt', async t => {
  const f = await fixture(t)
  const server = buildServer({}, {}, undefined, { edoState: f.settings, edoTransport: f.factory, edoSecret: f.secret, artifactDir: f.dir })
  const client = new Client({ name: 'draft-test', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  client.setRequestHandler(ElicitRequestSchema, async req => {
    assert.equal(req.params.requestedSchema.properties.confirm.default, false)
    assert.match(req.params.message, /TEST-17/); return accept()
  })
  const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct)
  t.after(async () => { await client.close(); await server.close() })
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent
  }
  const plan = await call('preview_edo_draft', f.input)
  assert.equal(uploads(f).length, 0)
  const result = await call('apply_reviewed_operation', { reviewId: plan.reviewId })
  assert.equal(result.state, 'created')
  assert.equal((await call('get_edo_draft_receipt', { account: 'office', operationId: result.operationId })).messageId, f.messageId)
})
