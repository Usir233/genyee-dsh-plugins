/**
 * Run the headless end-to-end test against every published `@deepseek-ai/dsh` release that `engines.dsh` admits.
 * Each release's CLI is installed into its own directory under the system temporary directory, which is removed
 * afterwards. Usage: `pnpm test:compat` (builds first), optionally with release versions as arguments to limit the run.
 * Exits non-zero when any release fails.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import semver from 'semver'

const packageDir = new URL('..', import.meta.url).pathname
const range = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).engines.dsh
const published = JSON.parse(execFileSync('npm', ['view', '@deepseek-ai/dsh', 'versions', '--json'], { encoding: 'utf8' }))
// DSH checks engines.dsh with prereleases included, so this run does too.
const supported = published.filter(version => semver.satisfies(version, range, { includePrerelease: true }))
const versions = process.argv.length > 2 ? process.argv.slice(2) : supported
console.log(`engines.dsh ${range}: ${versions.join(', ')}`)

const root = mkdtempSync(join(tmpdir(), 'keyhub-compat-'))
const results = []
try {
  for (const version of versions) {
    const prefix = join(root, version)
    const install = spawnSync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${version}`], { encoding: 'utf8' })
    if (install.status !== 0) {
      results.push({ version, result: 'install failed', detail: install.stderr.trim().split('\n').at(-1) })
      continue
    }
    const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.e2e.config.ts'], {
      cwd: packageDir,
      encoding: 'utf8',
      env: { ...process.env, KEYHUB_DSH_BIN: join(prefix, 'node_modules/.bin/dsh') },
    })
    const summary = (run.stdout + run.stderr).split('\n').find(line => /Tests\s+\d/u.test(line))?.trim() ?? ''
    results.push({ version, result: run.status === 0 ? 'passed' : 'FAILED', detail: summary })
    console.log(`${version}: ${run.status === 0 ? 'passed' : 'FAILED'} ${summary}`)
    if (run.status !== 0) console.log(run.stdout.split('\n').filter(line => /Error|×|expected|keyhub/u.test(line)).slice(0, 12).join('\n'))
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.table(results)
process.exitCode = results.every(entry => entry.result === 'passed') ? 0 : 1
