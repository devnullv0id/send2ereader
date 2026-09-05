import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Device } from '../db/repositories.js'
import { settings } from '../settings.js'

const FORWARD_REQUEST = [
  'authorization',
  'accept',
  'accept-language',
  'content-type',
  'user-agent',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'range',
  'x-kobo-affiliatename',
  'x-kobo-appversion',
  'x-kobo-carriername',
  'x-kobo-deviceid',
  'x-kobo-devicemodel',
  'x-kobo-deviceos',
  'x-kobo-deviceosversion',
  'x-kobo-platformid',
  'x-kobo-synctoken',
  'x-kobo-userkey',
]

const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
  'set-cookie',
])

function forwardableHeaders(req: FastifyRequest): Headers {
  const headers = new Headers()
  for (const name of FORWARD_REQUEST) {
    const value = req.headers[name]
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return headers
}

function requestBody(req: FastifyRequest): Buffer | string | undefined {
  const body = req.body
  if (body === undefined || body === null) return undefined
  if (Buffer.isBuffer(body)) return body.length > 0 ? body : undefined
  if (typeof body === 'string') return body.length > 0 ? body : undefined
  return JSON.stringify(body)
}

export interface ProxyLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

export async function proxyToStore(
  req: FastifyRequest,
  reply: FastifyReply,
  device: Device,
  rest: string,
  log: ProxyLogger
): Promise<FastifyReply> {
  if (!device.proxyStore) {
    return reply.code(404).send({ error: 'Store access is disabled for this device' })
  }

  const base = settings.str('KOBO_STORE_URL').replace(/\/+$/, '')
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const target = `${base}${rest}${query}`

  const body = requestBody(req)

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: forwardableHeaders(req),
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.int('KOBO_PROXY_TIMEOUT_MS')),
    })

    log.info({ status: upstream.status, path: rest }, 'Proxied to the Kobo store')

    reply.code(upstream.status)
    upstream.headers.forEach((value, name) => {
      if (!STRIP_RESPONSE.has(name.toLowerCase())) reply.header(name, value)
    })

    const payload = Buffer.from(await upstream.arrayBuffer())
    return reply.send(payload)
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message
    log.warn({ path: rest, reason }, 'Could not reach the Kobo store')
    return reply.code(502).send({ error: 'The Kobo store could not be reached' })
  }
}
