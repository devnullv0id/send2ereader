import type { FastifyRequest } from 'fastify'
import { i18n } from './i18n.js'
import { settings } from './settings.js'

declare module 'fastify' {
  interface FastifyRequest {
    resolvedLanguage?: string
  }
}

export function cookieLanguage(req: FastifyRequest): string | null {
  const header = req.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== 's2e_lang') continue
    const value = decodeURIComponent(rest.join('=')).toLowerCase()
    return i18n.isInstalled(value) ? value : null
  }
  return null
}

export function defaultLanguage(): string {
  const chosen = settings.str('LANGUAGE').toLowerCase()
  return i18n.isInstalled(chosen) ? chosen : 'en'
}

export function userLanguage(user: { language?: string | null } | null | undefined): string {
  const chosen = user?.language
  if (chosen && i18n.isInstalled(chosen)) return chosen
  return defaultLanguage()
}

export function requestLanguage(req: FastifyRequest): string {
  if (req.resolvedLanguage) return req.resolvedLanguage
  const user = (req as FastifyRequest & { user?: { language?: string | null } | null }).user
  const chosen = user?.language
  const resolved =
    chosen && i18n.isInstalled(chosen) ? chosen : (cookieLanguage(req) ?? defaultLanguage())
  req.resolvedLanguage = resolved
  return resolved
}

export function say(
  req: FastifyRequest,
  text: string,
  params?: Record<string, string | number>
): string {
  return i18n.translate(requestLanguage(req), text, params)
}
