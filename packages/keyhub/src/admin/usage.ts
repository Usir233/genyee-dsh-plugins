/** Token usage observed in DeepSeek Messages responses without altering the forwarded bytes. */
import { createParser } from 'eventsource-parser'

/** Token counts of one completed request, in Anthropic Messages terms. */
export interface TokenUsage {
  /** Input tokens that missed the cache and were not written to it. */
  inputTokens: number
  /** Input tokens served from the cache (`cache_read_input_tokens`). */
  cacheReadTokens: number
  /** Input tokens written to the cache (`cache_creation_input_tokens`). */
  cacheWriteTokens: number
  outputTokens: number
}

const USAGE_FIELDS = {
  input_tokens: 'inputTokens',
  cache_read_input_tokens: 'cacheReadTokens',
  cache_creation_input_tokens: 'cacheWriteTokens',
  output_tokens: 'outputTokens',
} as const satisfies Record<string, keyof TokenUsage>

/**
 * Merge one usage object into the running totals.
 * Messages usage values are cumulative, so a present field replaces the previous value.
 * @param usage - the running totals, updated in place.
 * @param raw - a `usage` object from a response or stream event.
 */
function mergeUsage(usage: TokenUsage, raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const fields = raw as Record<string, unknown>
  for (const [wire, local] of Object.entries(USAGE_FIELDS)) {
    const value = fields[wire]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[local] = value
  }
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
}

/** Incremental observer of one response body. */
export interface UsageTap {
  /**
   * Observe the next forwarded chunk.
   * @param chunk - bytes exactly as forwarded to the employee.
   */
  push(chunk: Buffer): void
  /**
   * Finish observation.
   * @returns the usage the response reported, or `undefined` when it reported none.
   */
  finish(): TokenUsage | undefined
}

/**
 * Observe an SSE Messages stream (`message_start` and `message_delta` events).
 * @returns a tap fed with the raw stream bytes.
 */
export function streamUsageTap(): UsageTap {
  const usage = emptyUsage()
  let reported = false
  const decoder = new TextDecoder()
  const parser = createParser({
    onEvent(event) {
      let data: unknown
      try { data = JSON.parse(event.data) }
      catch (_nonJsonEvent) { return } // Only JSON events carry usage.
      if (typeof data !== 'object' || data === null) return
      const fields = data as Record<string, unknown>
      if (fields.type === 'message_start' && typeof fields.message === 'object' && fields.message !== null) {
        mergeUsage(usage, (fields.message as Record<string, unknown>).usage)
        reported = true
      } else if (fields.type === 'message_delta' && fields.usage !== undefined) {
        mergeUsage(usage, fields.usage)
        reported = true
      }
    },
  })
  return {
    push(chunk) { parser.feed(decoder.decode(chunk, { stream: true })) },
    finish() {
      parser.feed(decoder.decode())
      return reported ? usage : undefined
    },
  }
}

/**
 * Observe a non-streaming JSON Messages response.
 * @param limitBytes - bytes retained for parsing; a larger body reports no usage.
 * @returns a tap fed with the raw response bytes.
 */
export function jsonUsageTap(limitBytes: number): UsageTap {
  const chunks: Buffer[] = []
  let size = 0
  return {
    push(chunk) {
      size += chunk.length
      if (size <= limitBytes) chunks.push(chunk)
    },
    finish() {
      if (size > limitBytes) return undefined
      let data: unknown
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
      catch (_nonJsonBody) { return undefined } // An unparsable body reports no usage.
      if (typeof data !== 'object' || data === null || !('usage' in data)) return undefined
      const usage = emptyUsage()
      mergeUsage(usage, data.usage)
      return usage
    },
  }
}
