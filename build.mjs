import { build } from 'esbuild'
import { readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'

await build({
  entryPoints: { upstream: 'vendor/mcp/src/internal.ts', admin: 'vendor/mcp/src/cli.ts' },
  bundle: true, platform: 'node', target: 'node24', format: 'esm',
  outdir: 'dist', outExtension: { '.js': '.mjs' },
  external: ['@modelcontextprotocol/*', '@napi-rs/*', 'commander', 'fast-xml-parser', 'zod'],
  alias: { '@1c-odata/client/filter': './vendor/client/src/filter.ts',
    '@1c-odata/client/internal': './vendor/client/src/internal.ts',
    '@1c-odata/client': './vendor/client/src/index.ts',
    '@1c-odata/metadata': './vendor/metadata/src/index.ts' },
})

const output = 'plugins/kyvirok-1c'
const bundle = await build({
  entryPoints: ['server.mjs'], outfile: output + '/server.mjs', platform: 'node', target: 'node24',
  bundle: true, format: 'esm', minify: true, legalComments: 'eof', metafile: true,
  external: ['@napi-rs/keyring'],
  banner: { js: "import { createRequire as _kyvRequire } from 'node:module'; const require = _kyvRequire(import.meta.url);" },
})
const licenses = new Map()
for (const source of Object.keys(bundle.metafile.inputs).filter(p => p.includes('node_modules/'))) {
  let root = dirname(realpathSync(source))
  while (basename(root) !== 'node_modules' && dirname(root) !== root) {
    const files = readdirSync(root)
    const manifest = files.includes('package.json') && JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
    if (manifest?.name && manifest.version) {
      const key = manifest.name + '@' + manifest.version
      const license = files.find(f => /^(license|licence|copying)(\..*)?$/i.test(f))
      if (license) { licenses.set(key, readFileSync(join(root,license),'utf8')); break }
    }
    root = dirname(root)
  }
}
licenses.set('1c-odata',readFileSync(resolve('vendor/LICENSE'),'utf8'))
writeFileSync(output+'/THIRD-PARTY-NOTICES.txt', [...licenses].sort(([a],[b])=>a.localeCompare(b))
  .map(([key, value])=>key+'\n\n'+value).join('\n\n---\n\n'))
