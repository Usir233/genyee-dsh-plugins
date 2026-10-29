/**
 * The parts of the DSH client plugin context this bundle uses, typed locally: the client packages are provided
 * by the host page at runtime (see `dsh.client` in package.json), not bundled.
 */
import type { ComponentType } from 'react'

/** Answer of one command route. */
export type RpcResult =
  | { readonly ok: true, readonly value: unknown }
  | { readonly ok: false, readonly error: { readonly code: string, readonly message: string } }

/** Translate one key of this plugin's locale namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** The client plugin context. */
export interface ClientContext {
  effect(execute: () => (() => void) | void, label?: string): () => void
  readonly slots: {
    inject(name: string, callback: () => () => void): void
    register(options: object, component: ComponentType<never>): () => void
  }
  readonly locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
    bind(namespace: string): Translate
  }
}

/** Calls one command route; failures become thrown errors carrying the server's message. */
export type ChannelCall = <T>(endpoint: string, payload?: object) => Promise<T>

/** A route did not answer with a command result: it is not registered, or the Host is unreachable. */
export class RouteUnavailableError extends Error {}

/**
 * Send one command to a route of the page's own Host. The page's authenticated session carries the request.
 * @param path - the route path below the application root, such as `api/genyee-keyhub/admin`.
 * @param endpoint - the command.
 * @param payload - its payload.
 * @returns the route's answer.
 * @throws RouteUnavailableError when the route answers without a command result.
 */
export async function postCommand(path: string, endpoint: string, payload: object): Promise<RpcResult> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) {
    throw new RouteUnavailableError(`${path} answered HTTP ${response.status}`)
  }
  return await response.json() as RpcResult
}

/**
 * Bind a command route.
 * @param path - the route path below the application root.
 * @returns a caller that resolves with the value or throws an Error with the server's message.
 */
export function channel(path: string): ChannelCall {
  return async <T>(endpoint: string, payload: object = {}): Promise<T> => {
    const result = await postCommand(path, endpoint, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as T
  }
}
