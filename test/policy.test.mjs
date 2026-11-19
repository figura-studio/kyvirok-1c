import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadWritePolicy } from '../policy.mjs'

test('policy diagnostics track missing, loaded, changed and removed files without secrets', t => {
  const dir = mkdtempSync(join(tmpdir(),'kyvirok-policy-'))
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const file = join(dir,'write-policy.json')
  const reader = loadWritePolicy(dir, '')
  assert.equal(reader.diagnostics().loaded,false)
  assert.equal(reader.diagnostics().path,file)
  assert.equal(reader.diagnostics().writeEnabled,false)
  const permissions = {demo:{Catalog_Номенклатура:{create:['Description']}}}
  writeFileSync(file,'\uFEFF'+JSON.stringify(permissions))
  assert.throws(reader.assertCurrent,/Перезапустите/)
  const writer = loadWritePolicy(dir, '')
  assert.equal(writer.diagnostics().loaded,true)
  assert.equal(writer.diagnostics().writeEnabled,true)
  assert.deepEqual(writer.diagnostics().permissions,permissions)
  writeFileSync(file,'{"password":"must-not-appear-in-errors"}')
  assert.equal(writer.diagnostics().restartRequired,true)
  assert.throws(()=>loadWritePolicy(dir,''),error=>!error.message.includes('must-not-appear-in-errors'))
  rmSync(file)
  assert.equal(writer.diagnostics().currentStatus,'missing')
  assert.throws(writer.assertCurrent,/Перезапустите/)
  assert.throws(()=>loadWritePolicy(dir,file),/Не удалось загрузить/)
  assert.throws(()=>loadWritePolicy(dir,'relative.json'),/абсолютным/)
})
