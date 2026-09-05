export const SYNC_TOKEN_HEADER = 'x-kobo-synctoken'

export interface SyncToken {
  koboToken?: string
  lastSync?: string
  [key: string]: unknown
}

export function parseSyncToken(header: string | string[] | undefined): SyncToken {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return {}
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    return parsed && typeof parsed === 'object' ? (parsed as SyncToken) : {}
  } catch {
    return {}
  }
}

export function serialiseSyncToken(token: SyncToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64')
}

export function nextSyncToken(previous: SyncToken, now = new Date()): string {
  return serialiseSyncToken({ ...previous, lastSync: now.toISOString() })
}
