/**
 * Bundle the browser half into `lib/client.js` in the DSH client module format:
 * `window.__ModuleLoader__.load({ id, factory(require) })`, whose factory returns the plugin's `{ inject, apply }`.
 * React comes from the host page through `require`; everything else is bundled.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

/** Modules the host page provides to plugin factories; this bundle uses only these. */
const HOST_MODULES = ['react', 'react/jsx-runtime']

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const result = await build({
  entryPoints: [new URL('../src/client/index.tsx', import.meta.url).pathname],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: HOST_MODULES,
  write: false,
  logLevel: 'warning',
})
const body = result.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(manifest.name)},
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
${body}
    return module.exports
  },
})
`
await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await writeFile(new URL('../lib/client.js', import.meta.url), wrapped)
console.log(`lib/client.js: ${Buffer.byteLength(wrapped)} bytes`)
