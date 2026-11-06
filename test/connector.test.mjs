import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const key = 'e653f2d7-8a8e-4611-a839-c51aa596822f'
const set = 'Document_Заказ'
const xml = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0">
<edmx:DataServices xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" m:DataServiceVersion="3.0">
<Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA">
<EntityType Name="Document_Заказ"><Key><PropertyRef Name="Ref_Key"/></Key>
<Property Name="Ref_Key" Type="Edm.Guid"/><Property Name="DataVersion" Type="Edm.String"/>
<Property Name="Posted" Type="Edm.Boolean"/><Property Name="DeletionMark" Type="Edm.Boolean"/>
<Property Name="Комментарий" Type="Edm.String"/><Property Name="Товары" Type="Collection(StandardODATA.Line)"/>
</EntityType><ComplexType Name="Line"><Property Name="Количество" Type="Edm.Int32"/></ComplexType>
<EntityContainer Name="StandardODATA" m:IsDefaultEntityContainer="true">
<EntitySet Name="Document_Заказ" EntityType="StandardODATA.Document_Заказ"/>
</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`

test('stdio MCP → preview → manager → HTTP OData, including refusals and conflicts', async (t) => {
  let record = { Ref_Key: key, DataVersion: 'v1', Posted: false, DeletionMark: false,
    Комментарий: 'старый', Товары: [{ Количество: 20 }] }
  const writes = []
  const http = createServer(async (req, res) => {
    const url = decodeURIComponent(req.url)
    if (url.includes('$metadata')) { res.setHeader('content-type','application/xml'); return res.end(xml) }
    res.setHeader('content-type', 'application/json')
    if (!url.includes(set)) { res.statusCode = 404; return res.end('{}') }
    if (req.method === 'GET') return res.end(JSON.stringify(record))
    if (req.method === 'PATCH' && req.headers['if-match'] !== record.DataVersion) {
      res.statusCode = 412; return res.end('{}')
    }
    const chunks = []
    for await (const part of req) chunks.push(part)
    const body = JSON.parse(Buffer.concat(chunks))
    writes.push({ method: req.method, body, version: req.headers['if-match'] })
    record = { ...record, ...body, DataVersion: 'v' + (writes.length + 1) }
    res.statusCode = req.method === 'POST' ? 201 : 200
    res.end(JSON.stringify(record))
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  const dir = await mkdtemp(join(tmpdir(), 'kyvirok-test-'))
  t.after(async () => { await new Promise(resolve => http.close(resolve)); await rm(dir,{ recursive:true, force:true }) })
  const baseUrl = 'http://127.0.0.1:' + http.address().port + '/demo/odata/standard.odata'
  await writeFile(join(dir,'config.json'), JSON.stringify({ connections: { demo: { baseUrl, login: 'test', serverTimezone: 'UTC' } } }))
  const rules = join(dir, 'rules.json')
  await writeFile(rules, JSON.stringify({ demo: { [set]: { create: ['Комментарий','Товары'], update: ['Комментарий','Товары'] } } }))
  const client = new Client({name:'test',version:'1'}, {capabilities:{elicitation:{form:{}}}})
  let result = { action: 'decline' }, shown = '', prompts = 0
  client.setRequestHandler(ElicitRequestSchema, async (req) => { shown = req.params.message; prompts++; return result })
  const launch = (policy) => new StdioClientTransport({ command: process.execPath,
    args:[fileURLToPath(new URL('../plugins/kyvirok-1c/server.mjs',import.meta.url))],
    env: { ONEC_MCP_DATA_DIR: dir, ONEC_DEMO_PASSWORD: 'fixture', ...(policy ? {KYVIROK_1C_POLICY:rules} : {}) } })
  await client.connect(launch(true))
  t.after(() => client.close())
  const planArgs = { connection:'demo', entitySet:set, operation:'update', key, fields:{ Товары:[{ Количество:12 }] } }
  const preview = (args = planArgs) => client.callTool({name:'preview_change',arguments:args})
  const apply = (reviewId) => client.callTool({name:'apply_reviewed_change',arguments:{reviewId}})
  const makeId = async () => { const p = await preview(); assert.ok(!p.isError, p.content[0].text); return p.structuredContent.reviewId }
  const list = await client.listTools()
  assert.ok(list.tools.some(t => t.name === 'query'))
  const first = await preview()
  assert.ok(!first.isError, first.content[0].text)
  assert.deepEqual(first.structuredContent.review.изменения[0], {поле:'Товары',было:[{Количество:20}],станет:[{Количество:12}]})
  assert.equal(writes.length,0)
  assert.equal((await apply(first.structuredContent.reviewId)).structuredContent.state,'cancelled')
  assert.equal((await apply(first.structuredContent.reviewId)).isError,true)
  result = { action:'accept',content:{confirm:false} }
  assert.equal((await apply(await makeId())).structuredContent.state,'cancelled')
  result = { action:'accept',content:{confirm:true} }
  const stale = await makeId()
  record.DataVersion = 'v100'
  assert.equal((await apply(stale)).isError,true)
  assert.equal(writes.length,0)
  const id = await makeId()
  const concurrent = await Promise.all([apply(id),apply(id)])
  assert.equal(concurrent.filter(r=>r.structuredContent?.state === 'saved').length,1)
  assert.deepEqual(writes, [{ method:'PATCH',body:planArgs.fields,version:'v100' }])
  assert.match(shown,/20/); assert.match(shown,/12/)
  const create = await preview({connection:'demo',entitySet:set,operation:'create',fields:{Комментарий:'образец'}})
  assert.equal((await apply(create.structuredContent.reviewId)).structuredContent.state,'saved')
  assert.equal(writes[1].method,'POST')
  const baselinePrompts = prompts
  assert.equal((await preview({...planArgs, fields:{Posted:true}})).isError,true)
  record.Posted = true
  assert.equal((await preview()).isError,true)
  assert.equal(prompts,baselinePrompts)
  const reader = new Client({name:'reader',version:'1'})
  await reader.connect(launch(false))
  try { assert.equal((await reader.callTool({name:'preview_change',arguments:planArgs})).isError,true) }
  finally { await reader.close() }
  // Even when writes are configured, a client without a human form fails closed.
  record.Posted = false
  const headless = new Client({name:'headless',version:'1'})
  await headless.connect(launch(true))
  try {
    const p = await headless.callTool({name:'preview_change',arguments:planArgs})
    assert.equal((await headless.callTool({name:'apply_reviewed_change',arguments:{reviewId:p.structuredContent.reviewId}})).isError,true)
  } finally { await headless.close() }
  assert.equal(writes.length,2)
})
