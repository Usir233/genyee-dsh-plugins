import { describe, expect, it } from 'vitest'
import { decodeAccessCode, encodeAccessCode, generateToken, normalizeFingerprint } from '../src/access-code.ts'
import { assertTimeZone, formatYuan, parsePrice, parseYuan, periodStart, requestCostMicros } from '../src/admin/money.ts'
import { rewriteMessagesBody } from '../src/admin/rewrite.ts'
import { jsonUsageTap, streamUsageTap } from '../src/admin/usage.ts'
import { stripDshExtensions } from '../src/dsh-extensions.ts'

const FINGERPRINT = 'ab'.repeat(32)

describe('access codes', () => {
  it('round-trips HTTPS codes and keeps only the origin', () => {
    const token = generateToken()
    const code = encodeAccessCode({ relayURL: 'https://10.0.0.8:8443', fingerprint: FINGERPRINT, token })
    expect(code.startsWith('gkh1.')).toBe(true)
    expect(decodeAccessCode(`  ${code}\n`)).toEqual({ relayURL: 'https://10.0.0.8:8443', fingerprint: FINGERPRINT, token })
  })

  it('accepts plain HTTP codes without a fingerprint', () => {
    const token = generateToken()
    expect(decodeAccessCode(encodeAccessCode({ relayURL: 'http://10.0.0.8:8080', fingerprint: undefined, token })).fingerprint).toBeUndefined()
  })

  it('rejects HTTPS codes without a fingerprint, bad tokens, and foreign text', () => {
    const token = generateToken()
    expect(() => decodeAccessCode(encodeAccessCode({ relayURL: 'https://10.0.0.8', fingerprint: undefined, token }))).toThrow('指纹')
    expect(() => decodeAccessCode(encodeAccessCode({ relayURL: 'https://10.0.0.8', fingerprint: FINGERPRINT, token: 'sk-123' }))).toThrow('授权码')
    expect(() => decodeAccessCode('sk-123')).toThrow('gkh1.')
    expect(() => decodeAccessCode('gkh1.!!!')).toThrow('无法解析')
    expect(() => decodeAccessCode(encodeAccessCode({ relayURL: 'ftp://10.0.0.8', fingerprint: undefined, token }))).toThrow('http')
  })

  it('normalizes colon-separated fingerprints', () => {
    expect(normalizeFingerprint('AB:CD:EF')).toBe('abcdef')
  })
})

describe('money', () => {
  it('rounds one request cost to micro-yuan', () => {
    const price = { inputCacheHit: parsePrice('0.2'), inputCacheMiss: parsePrice('2'), output: parsePrice('3') }
    // 1e6 hit × 0.2 + (5e5 + 5e5) miss × 2 + 1e6 out × 3 = 5.2 元
    expect(requestCostMicros({ cacheReadTokens: 1_000_000, inputTokens: 500_000, cacheWriteTokens: 500_000, outputTokens: 1_000_000 }, price)).toBe(5_200_000)
    // 1 output token × 3 元/M = 3 micro-yuan; 1 hit × 0.2 = 0.2 → rounds to 0.
    expect(requestCostMicros({ cacheReadTokens: 0, inputTokens: 0, cacheWriteTokens: 0, outputTokens: 1 }, price)).toBe(3)
    expect(requestCostMicros({ cacheReadTokens: 1, inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, price)).toBe(0)
    expect(requestCostMicros({ cacheReadTokens: 3, inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, price)).toBe(1)
  })

  it('parses yuan amounts and prices exactly', () => {
    expect(parseYuan('100')).toBe(100_000_000)
    expect(parseYuan('0.000001')).toBe(1)
    expect(parsePrice('0.2')).toBe(2_000)
    expect(() => parseYuan('-1')).toThrow('格式不正确')
    expect(() => parseYuan('1.0000001')).toThrow('格式不正确')
    expect(() => parsePrice('1.00001')).toThrow('格式不正确')
  })

  it('formats sub-fen amounts with 4 decimals', () => {
    expect(formatYuan(1_234_567)).toBe('¥1.23')
    expect(formatYuan(131)).toBe('¥0.0001')
    expect(formatYuan(0)).toBe('¥0.00')
  })
})

describe('periodStart', () => {
  // 2026-10-28 (Wednesday) 01:30 in Shanghai = 2026-10-27T17:30Z.
  const now = Date.parse('2026-10-27T17:30:00Z')

  it('uses the Shanghai calendar, with weeks from Monday', () => {
    expect(new Date(periodStart('day', now, 'Asia/Shanghai')!).toISOString()).toBe('2026-10-27T16:00:00.000Z')
    expect(new Date(periodStart('week', now, 'Asia/Shanghai')!).toISOString()).toBe('2026-10-25T16:00:00.000Z')
    expect(new Date(periodStart('month', now, 'Asia/Shanghai')!).toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(new Date(periodStart('year', now, 'Asia/Shanghai')!).toISOString()).toBe('2025-12-31T16:00:00.000Z')
    expect(periodStart('total', now, 'Asia/Shanghai')).toBeUndefined()
  })

  it('handles a Sunday and a zone with daylight saving time', () => {
    const sunday = Date.parse('2026-11-01T10:00:00Z')
    expect(new Date(periodStart('week', sunday, 'Asia/Shanghai')!).toISOString()).toBe('2026-10-25T16:00:00.000Z')
    // New York leaves DST on 2026-11-01; that day's midnight is still EDT (UTC-4).
    expect(new Date(periodStart('day', Date.parse('2026-11-01T18:00:00Z'), 'America/New_York')!).toISOString()).toBe('2026-11-01T04:00:00.000Z')
    expect(new Date(periodStart('month', Date.parse('2026-11-15T12:00:00Z'), 'America/New_York')!).toISOString()).toBe('2026-11-01T04:00:00.000Z')
  })

  it('rejects unknown time zones', () => {
    expect(() => assertTimeZone('Mars/Base')).toThrow(RangeError)
  })
})

describe('rewriteMessagesBody', () => {
  it('creates metadata when the request has none', () => {
    const result = rewriteMessagesBody(Buffer.from('{"model":"m"}'), 'emp_a')
    expect(result.ok && JSON.parse(result.body.toString())).toEqual({ model: 'm', metadata: { user_id: 'emp_a' } })
  })

  it('replaces non-object metadata', () => {
    const result = rewriteMessagesBody(Buffer.from('{"metadata":"x"}'), 'emp_a')
    expect(result.ok && JSON.parse(result.body.toString())).toEqual({ metadata: { user_id: 'emp_a' } })
  })
})

describe('usage taps', () => {
  it('reads cumulative usage from SSE split across chunks', () => {
    const tap = streamUsageTap()
    const stream = ': keep-alive\n\nevent: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":2,"output_tokens":1}}}\n\n'
      + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n'
    const bytes = Buffer.from(stream)
    for (let offset = 0; offset < bytes.length; offset += 7) tap.push(bytes.subarray(offset, offset + 7))
    expect(tap.finish()).toEqual({ usage: { inputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 9 }, estimated: false })
  })

  it('estimates output from streamed text when the final usage never arrives', () => {
    const tap = streamUsageTap()
    tap.push(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":4,"output_tokens":1}}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好世界"}}\n\n'
      + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":1}"}}\n\n'))
    // 12 bytes of text and 7 of JSON at 4 bytes per token.
    expect(tap.finish()).toEqual({ usage: { inputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 5 }, estimated: true })
  })

  it('reports nothing for a stream without usage', () => {
    const tap = streamUsageTap()
    tap.push(Buffer.from('event: ping\ndata: {}\n\n'))
    expect(tap.finish()).toBeUndefined()
  })

  it('reads usage from a JSON body within the limit', () => {
    const tap = jsonUsageTap(1000)
    tap.push(Buffer.from('{"usage":{"input_tokens":1,"output_tokens":2}}'))
    expect(tap.finish()).toEqual({ usage: { inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 }, estimated: false })
    const large = jsonUsageTap(4)
    large.push(Buffer.from('{"usage":{}}'))
    expect(large.finish()).toBeUndefined()
  })
})

describe('stripDshExtensions', () => {
  it('removes only dsh_ fields and leaves other bodies untouched', () => {
    expect(JSON.parse(stripDshExtensions(Buffer.from('{"model":"m","dsh_session_log":{},"dshx":1}')).toString())).toEqual({ model: 'm', dshx: 1 })
    const plain = Buffer.from('{"model":"m"}')
    expect(stripDshExtensions(plain)).toBe(plain)
    const broken = Buffer.from('{not json')
    expect(stripDshExtensions(broken)).toBe(broken)
  })
})
