import { i18n } from './i18n.js'
import type { DeviceKind } from './types.js'

export function detectDevice(userAgent: string | undefined): DeviceKind {
  const agent = userAgent ?? ''
  if (agent.includes('Kobo')) return 'kobo'
  if (agent.includes('Kindle') || agent.includes('Silk')) return 'kindle'
  if (agent.toLowerCase().includes('tolino') || agent.includes('eReader')) return 'tolino'
  return 'generic'
}

export function isEreader(userAgent: string | undefined): boolean {
  return detectDevice(userAgent) !== 'generic'
}

export function deviceLabel(device: DeviceKind, lang = 'en'): string {
  switch (device) {
    case 'kobo':
      return i18n.translate(lang, 'a Kobo device')
    case 'kindle':
      return i18n.translate(lang, 'a Kindle device')
    case 'tolino':
      return i18n.translate(lang, 'a Tolino device')
    default:
      return i18n.translate(lang, 'a device')
  }
}
