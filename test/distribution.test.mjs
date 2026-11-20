import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const run = promisify(execFile)
test('complete ZIP contains sources and policy example; its bundled MCP runs without dependencies',
  {skip:process.platform !== 'win32'}, async t => {
    const dir = await mkdtemp(join(tmpdir(),'kyvirok-dist-'))
    t.after(()=>rm(dir,{recursive:true,force:true}))
    const script = fileURLToPath(new URL('../package-release.ps1',import.meta.url))
    const manifest = JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'))
    const options = {windowsHide:true,timeout:30000}
    await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned',
      '-File',script,'-OutputDirectory',dir],options)
    const archive = join(dir,`kyvirok-1c-${manifest.version}.zip`)
    const extract = join(dir,'unpacked')
    const result = await run('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; ' +
      '$zip=[IO.Compression.ZipFile]::OpenRead($env:TEST_ARCHIVE); ' +
      'try { ConvertTo-Json -InputObject @($zip.Entries.FullName) -Compress } finally { $zip.Dispose() }; ' +
      '[IO.Compression.ZipFile]::ExtractToDirectory($env:TEST_ARCHIVE,$env:TEST_EXTRACT)'],
      {...options,env:{...process.env,TEST_ARCHIVE:archive,TEST_EXTRACT:extract}})
    const paths = JSON.parse(result.stdout)
    const prefix = `kyvirok-1c-${manifest.version}/`
    for (const path of ['write-policy.example.json','build.mjs','server.mjs','changes.mjs','policy.mjs',
      'approval.mjs','actions.mjs','bridge.mjs','artifacts.mjs','bridge-policy.example.json','BRIDGE.md','OPERATIONS.md',
      'test/connector.test.mjs','test/distribution.test.mjs','vendor/mcp/src/internal.ts',
      'plugins/kyvirok-1c/plugin.json','plugins/kyvirok-1c/server.mjs','.agents/plugins/marketplace.json']) {
      assert.ok(paths.includes(prefix+path), 'Missing '+path)
    }
    assert.ok(paths.every(path=>!/(node_modules|\.dpapi|\/config\.json|\/write-policy\.json|HANDOFF)/.test(path)))
    const root = join(extract,`kyvirok-1c-${manifest.version}`)
    const bundle = join(root,'plugins','kyvirok-1c','server.mjs')
    const env = {ONEC_MCP_DATA_DIR:join(dir,'no-settings'), KYVIROK_1C_POLICY:''}
    const diagnosis = JSON.parse((await run(process.execPath,[bundle,'--diagnose'],{...options,cwd:root,env})).stdout)
    assert.equal(diagnosis.version,manifest.version)
    assert.equal(diagnosis.loaded,false)
    const client = new Client({name:'unpacked-release-test',version:'1'})
    await client.connect(new StdioClientTransport({command:process.execPath,args:[bundle],env,cwd:root}))
    try {
      assert.equal(client.getServerVersion().version,manifest.version)
      assert.ok((await client.listTools()).tools.some(tool=>tool.name==='apply_reviewed_change'))
      for (const name of ['get_capabilities','preview_document_action','preview_business_operation','apply_reviewed_operation','get_operation_status']) {
        assert.ok((await client.listTools()).tools.some(tool=>tool.name===name))
      }
      assert.equal((await client.callTool({name:'get_write_policy',arguments:{}})).structuredContent.writeEnabled,false)
    } finally { await client.close() }
  })
