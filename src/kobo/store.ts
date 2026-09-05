import { config } from '../config.js'
import type { Device } from '../db/repositories.js'

export interface ImageRequest {
  ImageId: string
  Width: string
  Height: string
  IsGreyscale: string
  Quality?: string
}

export type IncomingHeaders = Record<string, string | string[] | undefined>

const FORWARDED_TO_STORE = [
  'authorization',
  'user-agent',
  'accept-language',
  'x-kobo-affiliatename',
  'x-kobo-appversion',
  'x-kobo-carriername',
  'x-kobo-deviceid',
  'x-kobo-devicemodel',
  'x-kobo-deviceos',
  'x-kobo-deviceosversion',
  'x-kobo-platformid',
]

function storeHeaders(incoming: IncomingHeaders): Headers {
  const headers = new Headers({ 'User-Agent': 'Kobo' })
  for (const name of FORWARDED_TO_STORE) {
    const value = incoming[name]
    if (typeof value === 'string' && value.length > 0) headers.set(name, value)
  }
  return headers
}

function fallbackTemplate(image: ImageRequest): string {
  const base = `${config.kobo.imageBaseUrl.replace(/\/+$/, '')}/{ImageId}/{Width}/{Height}`
  return image.Quality ? `${base}/{Quality}/{IsGreyscale}/image.jpg` : `${base}/false/image.jpg`
}

export interface StoreLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

interface CachedResources {
  resources: Record<string, unknown>
  fetchedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const RETRY_AFTER_FAILURE_MS = 60 * 1000

export class KoboStore {
  #byDevice = new Map<string, CachedResources>()

  constructor(private readonly log: StoreLogger) {}

  get baseUrl(): string {
    return config.kobo.storeUrl.replace(/\/+$/, '')
  }

  cachedResources(device: Device): Record<string, unknown> {
    return this.#byDevice.get(device.id)?.resources ?? {}
  }

  async imageUrl(device: Device, image: ImageRequest): Promise<string | null> {
    if (!device.proxyStore) return null

    const resources = this.cachedResources(device)
    const key = image.Quality ? 'image_url_quality_template' : 'image_url_template'
    const advertised = resources[key]
    const template =
      typeof advertised === 'string' && advertised ? advertised : fallbackTemplate(image)
    if (!template) return null

    const url = template.replace(/\{(\w+)\}/g, (whole, name: string) => {
      const value = image[name as keyof ImageRequest]
      return value === undefined ? whole : encodeURIComponent(value)
    })

    return url.startsWith('https://') ? url : null
  }

  async initializationResources(
    device: Device,
    incoming: IncomingHeaders = {}
  ): Promise<Record<string, unknown>> {
    if (!device.proxyStore) return {}

    this.#sweep()
    const cached = this.#byDevice.get(device.id)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.resources

    try {
      const res = await fetch(`${this.baseUrl}/v1/initialization`, {
        headers: storeHeaders(incoming),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`store returned ${res.status}`)

      const body = (await res.json()) as { Resources?: Record<string, unknown> }
      const resources = body.Resources ?? {}
      this.#byDevice.set(device.id, { resources, fetchedAt: Date.now() })
      this.log.info({ count: Object.keys(resources).length }, 'Fetched Kobo store resources')
      return resources
    } catch (err) {
      const resources = cached?.resources ?? {}
      this.#byDevice.set(device.id, {
        resources,
        fetchedAt: Date.now() - CACHE_TTL_MS + RETRY_AFTER_FAILURE_MS,
      })
      this.log.warn(
        { err: (err as Error).message },
        'Could not reach the Kobo store — falling back to the native resource list'
      )
      return resources
    }
  }

  #sweep(): void {
    const oldest = Date.now() - CACHE_TTL_MS
    for (const [id, entry] of this.#byDevice) {
      if (entry.fetchedAt < oldest) this.#byDevice.delete(id)
    }
  }
}
