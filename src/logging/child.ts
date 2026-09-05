import type { FastifyBaseLogger } from 'fastify'

const PROGRESS = /^\d{1,3}%/
const GPU =
  /vulkan|libGL|MESA|gbm|swrast|DRI3|\bGPU\b|qt\.qpa|QStandardPaths|Fontconfig|software rendering/i
const RING_SIZE = 50

export class ChildOutput {
  readonly #log: FastifyBaseLogger
  readonly #ring: string[] = []
  #gpuReported = false

  constructor(log: FastifyBaseLogger) {
    this.#log = log
  }

  line(raw: string): void {
    const text = raw.trim()
    if (!text) return

    this.#ring.push(text)
    if (this.#ring.length > RING_SIZE) this.#ring.shift()

    if (PROGRESS.test(text)) return

    if (GPU.test(text)) {
      if (this.#gpuReported) return
      this.#gpuReported = true
      this.#log.warn('no GPU — falling back to software rendering')
      return
    }

    if (text.startsWith('{') && text.endsWith('}')) {
      const hoisted = this.#hoist(text)
      if (hoisted) return
    }

    this.#log.debug(text)
  }

  #hoist(text: string): boolean {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text) as Record<string, unknown>
    } catch {
      return false
    }
    if (parsed === null || typeof parsed !== 'object') return false

    const { error, ...rest } = parsed
    if (typeof error === 'string' && error.length > 0) {
      this.#log.warn(`step failed: ${error}`)
      this.#log.debug(rest, 'step detail')
      return true
    }
    this.#log.debug(rest, 'step finished')
    return true
  }

  flush(): void {
    if (this.#ring.length === 0) return
    this.#log.error({ output: this.#ring.join('\n') }, 'last output before it failed')
  }
}
