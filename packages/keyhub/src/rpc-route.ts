/**
 * One JSON command route on the DSH Connection API channel. DSH's Connection answers 403 to every caller but the owner
 * (the person at this DSH) before an exact Fetch route runs, so handlers behind it need no principal check of their own.
 */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'

/** A command answer in the Connection result format. */
export type RpcAnswer =
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false, readonly error: { readonly code: string, readonly message: string, readonly details: object } }

/** Handles one command. */
export type RpcHandler = (endpoint: string, payload: unknown) => Promise<RpcAnswer>

/**
 * Build a `POST` route that takes `{ endpoint, payload }` JSON and answers the handler's result as JSON.
 * @param path - absolute route path below `/api`.
 * @param handler - the command handler.
 * @returns the route to register with `ctx.connection.fetch.register`.
 */
export function rpcRoute(path: string, handler: RpcHandler): ConnectionFetchRoute {
  return {
    path,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body: unknown
      try { body = await request.json() }
      catch (_malformedJson) {
        return Response.json({ ok: false, error: { code: 'keyhub/invalid', message: 'request body is not JSON', details: {} } }, { status: 400 })
      }
      const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
      if (typeof fields.endpoint !== 'string') {
        return Response.json({ ok: false, error: { code: 'keyhub/invalid', message: 'request body names no endpoint', details: {} } }, { status: 400 })
      }
      return Response.json(await handler(fields.endpoint, fields.payload))
    },
  }
}
