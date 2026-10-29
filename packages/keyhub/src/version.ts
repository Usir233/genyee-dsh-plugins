/** Version of this plugin package, read from its manifest; the relay reports it to employees. */
import { readFileSync } from 'node:fs'

/** The `version` of `@genyee/dsh-keyhub`'s package.json; `src/` and `lib/` both sit one level below it. */
export const PLUGIN_VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
