import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const run = promisify(execFile)
const installer = fileURLToPath(new URL('../setup-windows.ps1', import.meta.url))
const bundle = fileURLToPath(new URL('../plugins/kyvirok-1c/server.mjs', import.meta.url))
const driver = `
  $ErrorActionPreference = 'Stop'
  function Read-Host([string]$Prompt, [switch]$AsSecureString) {
    if ($AsSecureString) { return ConvertTo-SecureString 'fixture' -AsPlainText -Force }
    switch -Wildcard ($Prompt) {
      'Connection alias*' { return 'demo' }
      '*root URL*' { return $env:TEST_ODATA_URL }
      'Your 1C username' { return 'fixture-user' }
      'IANA timezone*' { return 'UTC' }
      default { throw "Unexpected installer prompt: $Prompt" }
    }
  }
  & $env:TEST_INSTALLER
`

test('Windows installer and packaged MCP support LAN HTTP and canonical HTTPS', {skip: process.platform !== 'win32'}, async t => {
  const scratch = await mkdtemp(join(tmpdir(), 'kyvirok-setup-'))
  const probes = []
  const metadataAuth = []
  const service = createServer((req, res) => {
    if (req.url.endsWith('/$metadata')) {
      metadataAuth.push(req.headers.authorization)
      res.setHeader('Content-Type', 'application/xml')
      return res.end('<edmx:Edmx xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" Version="1.0"><edmx:DataServices><Schema xmlns="http://schemas.microsoft.com/ado/2009/11/edm" Namespace="StandardODATA"><EntityType Name="Catalog_Item"><Key><PropertyRef Name="Ref_Key"/></Key><Property Name="Ref_Key" Type="Edm.Guid"/></EntityType><EntityContainer Name="Container"><EntitySet Name="Catalog_Item" EntityType="StandardODATA.Catalog_Item"/></EntityContainer></Schema></edmx:DataServices></edmx:Edmx>')
    }
    probes.push({path: req.url, auth: req.headers.authorization})
    if (req.url === '/upgrade') res.writeHead(301, {Location: 'https://127.0.0.1:9443/upgrade/'})
    else if (req.url === '/other') res.writeHead(302, {Location: 'https://elsewhere.invalid/other'})
    else if (req.url === '/odata') res.writeHead(308, {Location: '/odata/'})
    else res.writeHead(401)
    res.end()
  })
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => service.close(resolve))
    await rm(scratch, {recursive:true, force:true})
  })
  const root = 'http://127.0.0.1:' + service.address().port
  async function setup(folder, url) {
    const dir = join(scratch, folder)
    await run('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-Command',driver], {
      env: {...process.env, ONEC_MCP_DATA_DIR: dir, TEST_INSTALLER: installer, TEST_ODATA_URL: url},
      windowsHide: true, timeout: 25000,
    })
    const config = JSON.parse(await readFile(join(dir,'config.json'),'utf8'))
    return config.connections.demo.baseUrl
  }
  const oldConnection = {baseUrl:'https://legacy.example.invalid/base',login:'reader',serverTimezone:'UTC'}
  const existingConfig = join(scratch,'lan','config.json')
  await mkdir(join(scratch,'lan'))
  await writeFile(existingConfig, JSON.stringify({connections:{legacy:oldConnection}}))
  assert.equal(await setup('lan', root+'/odata'), root+'/odata')
  assert.deepEqual(JSON.parse(await readFile(existingConfig,'utf8')).connections.legacy, oldConnection)
  const client = new Client({name:'setup-test',version:'1'})
  await client.connect(new StdioClientTransport({command:process.execPath, args:[bundle],
    env:{ONEC_MCP_DATA_DIR:join(scratch,'lan')}}))
  try {
    const result = await client.callTool({name:'list_entities', arguments:{connection:'demo',name:'Item'}})
    assert.ok(!result.isError, result.content[0].text)
    assert.equal(result.structuredContent.total, 1)
    assert.equal(metadataAuth[0], 'Basic '+Buffer.from('fixture-user:fixture').toString('base64'))
  } finally { await client.close() }
  assert.equal(await setup('upgrade', root+'/upgrade'), 'https://127.0.0.1:9443/upgrade')
  assert.equal(await setup('https','https://example.invalid/base'), 'https://example.invalid/base')
  await assert.rejects(setup('new-host', root+'/other'), /redirect changes/)
  await assert.rejects(setup('public-http','http://192.0.2.1/base'), /private LAN/)
  await assert.rejects(setup('embedded-login','http://user@127.0.0.1/base'), /without credentials/)
  assert.deepEqual(probes.map(p=>p.path), ['/odata','/odata/','/upgrade','/other'])
  assert.ok(probes.every(p=>p.auth === undefined))
})
