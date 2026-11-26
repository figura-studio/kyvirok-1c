import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { hashRequest } from '../bridge.mjs'

test('bundled stdio MCP → real HTTP: Post/Unpost, bridge preview, confirmation and PDF resource', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-operations-'))
  const entitySet = 'Document_Заказ', key = randomUUID()
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="3.0">
<Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA">
<EntityType Name="${entitySet}"><Key><PropertyRef Name="Ref_Key"/></Key>
<Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="DataVersion" Type="Edm.String"/>
<Property Name="Posted" Type="Edm.Boolean"/><Property Name="DeletionMark" Type="Edm.Boolean"/>
<Property Name="Number" Type="Edm.String"/></EntityType>
<EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
<EntitySet Name="${entitySet}" EntityType="StandardODATA.${entitySet}"/>
${['Post','Unpost'].map(name => `<FunctionImport Name="${name}" IsBindable="true" IsSideEffecting="true">
<Parameter Name="bindingParameter" Type="StandardODATA.${entitySet}"/>
<Parameter Name="PostingModeOperational" Type="Edm.Boolean"/></FunctionImport>`).join('')}
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`
  const record = { Ref_Key: key, DataVersion: 'v1', Posted: false, DeletionMark: false, Number: '25' }
  let writes = 0, executeCount = 0, shown = '', response = { action: 'decline' }
  const pdf = Buffer.from('%PDF-1.4\nLocal test only\n%%EOF')
  const file = { id: randomUUID(), name: 'test.pdf', mimeType: 'application/pdf', size: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex') }
  const plans = new Map()
  const http = createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url)
      assert.equal(req.headers.authorization, 'Basic ' + Buffer.from('test:dummy').toString('base64'))
      res.setHeader('Content-Type', 'application/json')
      if (url.includes('$metadata')) { res.setHeader('Content-Type', 'application/xml'); return res.end(xml) }
      if (url.includes('/odata/')) {
        if (req.method === 'GET') return res.end(JSON.stringify(record))
        assert.equal(req.method, 'POST'); assert.equal(req.headers['if-match'], record.DataVersion)
        assert.ok(url.endsWith('/Post?PostingModeOperational=false') || url.endsWith('/Unpost'))
        writes++; record.Posted = url.includes('/Post?'); record.DataVersion += 'x'
        res.statusCode = 204; return res.end()
      }
      if (url.endsWith('/capabilities')) return res.end(JSON.stringify({ protocol: 'kyvirok-bridge/1',
        configuration: { name: 'Fake 1C', version: '1' }, operations: [{ name: 'print.document',
          title: 'Test print', kind: 'print', available: true, inputSchema: { type: 'object' } }] }))
      let body
      if (req.method === 'POST') { const parts = []; for await (const part of req) parts.push(part); body = JSON.parse(Buffer.concat(parts)) }
      if (url.endsWith('/plans')) {
        const { requestHash, ...input } = body
        assert.equal(requestHash, hashRequest(input))
        const plan = { planId: randomUUID(), requestHash, expiresAt: new Date(Date.now() + 60000).toISOString(),
          review: { title: 'Test print', effects: ['Create PDF'], changes: [], sourceVersions: { [key]: record.DataVersion },
            details: { number: '25' }, files: [] } }
        plans.set(plan.planId, plan); return res.end(JSON.stringify(plan))
      }
      if (url.endsWith('/execute')) {
        const id = url.split('/').at(-2), plan = plans.get(id)
        assert.equal(body.requestHash, plan.requestHash); assert.equal(body.reviewHash, hashRequest(plan.review))
        executeCount++
        return res.end(JSON.stringify({ planId: id, requestHash: plan.requestHash, state: 'completed', message: 'Test PDF',
          verification: { sourceUnchanged: true }, files: [file] }))
      }
      if (url.endsWith('/files/' + file.id)) { res.setHeader('Content-Type', 'application/pdf'); return res.end(pdf) }
      res.statusCode = 404; res.end('{}')
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })) }
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise(resolve => http.close(resolve)); await rm(dir, { recursive: true, force: true }) })
  await writeFile(join(dir, 'config.json'), JSON.stringify({ connections: { demo: { login: 'test', serverTimezone: 'UTC',
    baseUrl: 'http://127.0.0.1:' + http.address().port + '/demo/odata/standard.odata' } } }))
  await writeFile(join(dir, 'write-policy.json'), JSON.stringify({ demo: { [entitySet]: { actions: ['post', 'unpost'] } } }))
  await writeFile(join(dir, 'bridge-policy.json'), JSON.stringify({ demo: { servicePath: '/demo/hs/kyvirok/v1',
    operations: ['print.document'], edoProviders: [] } }))
  const client = new Client({ name: 'operations-integration', version: '1' }, { capabilities: { elicitation: { form: {} } } })
  client.setRequestHandler(ElicitRequestSchema, async req => { shown = req.params.message; return response })
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../plugins/kyvirok-1c/server.mjs', import.meta.url))],
    env: { ONEC_MCP_DATA_DIR: dir, KYVIROK_1C_POLICY: '', KYVIROK_1C_BRIDGE_POLICY: '', ONEC_DEMO_PASSWORD: 'dummy' } }))
  t.after(() => client.close())
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    return result.structuredContent
  }
  const cap = await call('get_capabilities', { connection: 'demo' })
  assert.equal(cap.native[entitySet].actions[0].available, true)
  assert.equal(cap.extension.operations[0].available, true)
  for (const action of ['post', 'unpost']) {
    let plan = await call('preview_document_action', { connection: 'demo', entitySet, key, action })
    const before = writes
    assert.equal((await call('apply_reviewed_operation', { reviewId: plan.reviewId })).state, 'cancelled')
    assert.equal(writes, before)
    response = { action: 'accept', content: { confirm: true } }
    plan = await call('preview_document_action', { connection: 'demo', entitySet, key, action })
    assert.equal((await call('apply_reviewed_operation', { reviewId: plan.reviewId })).verification.state, 'verified')
    assert.match(shown, /25/); assert.equal(writes, before + 1)
    response = { action: 'decline' }
  }
  let plan = await call('preview_business_operation', { connection: 'demo', operation: 'print.document', parameters: { documentId: key } })
  await call('apply_reviewed_operation', { reviewId: plan.reviewId }); assert.equal(executeCount, 0)
  response = { action: 'accept', content: { confirm: true } }
  plan = await call('preview_business_operation', { connection: 'demo', operation: 'print.document', parameters: { documentId: key } })
  const print = await call('apply_reviewed_operation', { reviewId: plan.reviewId })
  assert.equal(executeCount, 1)
  assert.equal(print.files.length, 1)
  const resource = await client.readResource({ uri: print.files[0].uri })
  assert.equal(resource.contents[0].blob, pdf.toString('base64'))
})
