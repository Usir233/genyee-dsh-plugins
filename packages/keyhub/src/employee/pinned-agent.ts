/** HTTPS agent that trusts exactly one certificate, identified by its SHA-256 fingerprint. */
import type { ClientRequestArgs } from 'node:http'
import { Agent } from 'node:https'
import type { Duplex } from 'node:stream'
import type { AgentOptions } from 'node:https'
import { connect } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { normalizeFingerprint } from '../access-code.ts'

/** Raised when the relay presents a certificate other than the pinned one. */
export class FingerprintMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`relay certificate fingerprint ${actual} does not match the access code (${expected})`)
    this.name = 'FingerprintMismatchError'
  }
}

/**
 * Agent whose connections are handed to requests only after the peer certificate matches the pin,
 * so no request byte reaches an impostor. Chain and host-name validation are replaced by the pin.
 */
export class PinnedAgent extends Agent {
  private readonly pin: string

  /**
   * @param fingerprint - expected SHA-256 fingerprint, with or without colons.
   * @param options - ordinary agent options such as `keepAlive`.
   */
  constructor(fingerprint: string, options?: AgentOptions) {
    super(options)
    this.pin = normalizeFingerprint(fingerprint)
  }

  override createConnection(options: ClientRequestArgs, callback?: (error: Error | null, socket: Duplex) => void): undefined {
    const socket: TLSSocket = connect({ ...options as object, rejectUnauthorized: false })
    const fail = (error: Error): void => {
      socket.destroy()
      callback?.(error, socket)
    }
    socket.once('error', fail)
    socket.once('secureConnect', () => {
      socket.off('error', fail)
      const actual = normalizeFingerprint(socket.getPeerCertificate().fingerprint256 ?? '')
      if (actual !== this.pin) {
        // Destroy without an error argument: the socket has no 'error' listener any more.
        socket.destroy()
        callback?.(new FingerprintMismatchError(this.pin, actual), socket)
        return
      }
      callback?.(null, socket)
    })
    // The agent receives the socket through the callback only after verification.
    return undefined
  }
}
