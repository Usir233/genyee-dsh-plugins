/** A local stand-in for the DeepSeek Anthropic endpoint that records what it receives. */
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One request the mock received. */
export interface ReceivedRequest {
  readonly method: string | undefined
  readonly path: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** Answers one received request; the default streams a short Messages reply. */
export type Responder = (request: ReceivedRequest, res: ServerResponse) => void | Promise<void>

/** A running mock endpoint. */
export interface MockDeepSeek {
  /** Anthropic-compatible base URL, ending in `/anthropic`. */
  readonly baseURL: string
  readonly received: ReceivedRequest[]
  /** Replace how later requests are answered. */
  respond(responder: Responder): void
  close(): Promise<void>
}

/** Usage the default reply reports. */
export const REPLY_USAGE = { input_tokens: 11, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 5 }

/**
 * Write one SSE event.
 * @param res - the open response.
 * @param event - event name.
 * @param data - JSON payload.
 */
export function sseEvent(res: ServerResponse, event: string, data: object): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/**
 * Stream a complete Messages reply with the given text.
 * @param res - the response to write.
 * @param text - assistant text.
 * @param model - model id echoed in `message_start`.
 */
export function streamReply(res: ServerResponse, text: string, model = 'deepseek-flash'): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(': keep-alive\n\n')
  sseEvent(res, 'message_start', {
    type: 'message_start',
    message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], stop_reason: null, usage: { input_tokens: REPLY_USAGE.input_tokens, cache_read_input_tokens: REPLY_USAGE.cache_read_input_tokens, cache_creation_input_tokens: 0, output_tokens: 1 } },
  })
  sseEvent(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
  sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: REPLY_USAGE.output_tokens } })
  sseEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function readAll(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.once('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.once('error', reject)
  })
}

/**
 * Start the mock on an OS-assigned loopback port.
 * @returns the running mock.
 */
export async function startMockDeepSeek(): Promise<MockDeepSeek> {
  const received: ReceivedRequest[] = []
  let responder: Responder = (_request, res) => { streamReply(res, 'pong') }
  const server: Server = createServer((req, res) => {
    void readAll(req).then(async (body) => {
      const request = { method: req.method, path: req.url, headers: req.headers, body }
      received.push(request)
      await responder(request, res)
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${port}/anthropic`,
    received,
    respond(next) { responder = next },
    async close() {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
    },
  }
}
