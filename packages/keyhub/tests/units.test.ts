import { describe, expect, it } from 'vitest'
import { decodeAccessCode, encodeAccessCode, generateToken, normalizeFingerprint } from '../src/access-code.ts'
import { admit, hashToken, parseDirectory } from '../src/admin/directory.ts'
import { rewriteMessagesBody } from '../src/admin/rewrite.ts'
import { jsonUsageTap, streamUsageTap } from '../src/admin/usage.ts'

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

describe('directory', () => {
  const token = generateToken()
  const valid = `
departments:
  - { id: sales, name: 销售部, keyRef: KEY_SALES }
employees:
  - { userId: emp_a, name: A, department: sales, tokenSha256: ${hashToken(token)} }
`

  it('admits a listed token and defaults entries to enabled', () => {
    const admission = admit(parseDirectory(valid, 'd.yml'), token)
    expect(admission?.employee.userId).toBe('emp_a')
    expect(admission?.department.keyRef).toBe('KEY_SALES')
    expect(admit(parseDirectory(valid, 'd.yml'), generateToken())).toBeUndefined()
  })

  it('names the first invalid entry', () => {
    expect(() => parseDirectory(valid.replace('department: sales', 'department: hr'), 'd.yml')).toThrow('employees[0].department "hr"')
    expect(() => parseDirectory(valid.replace('userId: emp_a', 'userId: 张三'), 'd.yml')).toThrow('employees[0].userId must match')
    expect(() => parseDirectory(valid.replace(hashToken(token), 'abc'), 'd.yml')).toThrow('tokenSha256 must be a hex SHA-256 digest')
    expect(() => parseDirectory(`${valid}  - { userId: emp_a, name: B, department: sales, tokenSha256: ${hashToken(generateToken())} }\n`, 'd.yml')).toThrow('duplicated')
    expect(() => parseDirectory('departments: 3', 'd.yml')).toThrow('must be a list')
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
    expect(tap.finish()).toEqual({ inputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 9 })
  })

  it('reports nothing for a stream without usage', () => {
    const tap = streamUsageTap()
    tap.push(Buffer.from('event: ping\ndata: {}\n\n'))
    expect(tap.finish()).toBeUndefined()
  })

  it('reads usage from a JSON body within the limit', () => {
    const tap = jsonUsageTap(1000)
    tap.push(Buffer.from('{"usage":{"input_tokens":1,"output_tokens":2}}'))
    expect(tap.finish()).toEqual({ inputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 2 })
    const large = jsonUsageTap(4)
    large.push(Buffer.from('{"usage":{}}'))
    expect(large.finish()).toBeUndefined()
  })
})
