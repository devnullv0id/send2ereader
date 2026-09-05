import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { publicUrl } from '../config.js'
import type { User } from '../db/repositories.js'
import { decodeOriginalName, safeUnlink, tempFilePath } from '../files.js'
import { i18n } from '../i18n.js'
import { requestLanguage, say } from '../language.js'
import {
  boundsFor,
  isLocked,
  isReadOnly,
  originOf,
  problemWith,
  SETTING_GROUPS,
  SETTING_SPECS,
  settings,
  specFor,
} from '../settings.js'
import { backupContents, makeBackup } from './backup.js'
import { detectContainer, restarter } from './restart.js'
import {
  discard as discardRestore,
  request as requestRestore,
  staged as stagedRestore,
  stage as stageRestore,
} from './restore.js'

const RESTORE_LIMIT = 32 * 1024 * 1024 * 1024

export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '•••'

  const name = email.slice(0, at)
  const host = email.slice(at + 1)
  if (!host) return '•••'

  const dot = host.lastIndexOf('.')
  const label = dot > 0 ? host.slice(0, dot) : host
  const tail = dot > 0 ? host.slice(dot) : ''

  return `${name[0]}•••@${label[0] ?? ''}•••${tail}`
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const user = req.user
  if (!user) {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html')
    if (wantsHtml) return reply.redirect('/login?next=%2Fadmin')
    return reply.code(401).send({ ok: false, error: say(req, 'Not signed in') })
  }
  if (!req.server.repos.users.canAdmin(user.id)) {
    return reply.code(404).send({ ok: false, error: say(req, 'Not found') })
  }
  return undefined
}

function addressPending(): boolean {
  const wanted = settings.str('DOMAIN')
  if (!wanted) return false
  return publicUrl() !== `${settings.str('PROTOCOL') || 'http'}://${wanted}`.replace(/\/+$/, '')
}

const ADDRESS_KEYS = new Set(['DOMAIN', 'PROTOCOL'])

function settingsPayload(app: FastifyInstance, lang = 'en') {
  const names = new Map<string, string>()
  for (const user of app.repos.users.listAll()) {
    const named = `${user.firstName} ${user.lastName}`.trim()
    names.set(user.id, named || maskEmail(user.email))
  }

  const changedBy = (key: string) => {
    const change = settings.changedBy(key)
    if (!change) return null
    return {
      at: change.at,
      by: change.by
        ? (names.get(change.by) ?? i18n.translate(lang, 'an account since deleted'))
        : i18n.translate(lang, 'the environment'),
    }
  }

  return {
    groups: SETTING_GROUPS.map((group) => ({
      id: group.id,
      title: i18n.translate(lang, group.title),
      intro: i18n.translate(lang, group.intro),
    })),
    addressPending: addressPending(),
    runningAddress: publicUrl(),
    settings: SETTING_SPECS.map((spec) => ({
      key: spec.key,
      group: spec.group,
      label: i18n.translate(lang, spec.label),
      note: spec.note ? i18n.translate(lang, spec.note) : '',
      kind: spec.kind,
      min: boundsFor(spec).min,
      max: boundsFor(spec).max,
      unit: spec.unit ? i18n.translate(lang, spec.unit) : '',
      placeholder: spec.placeholder ?? '',
      inlineWith: spec.inlineWith ?? '',
      choices: spec.choices
        ? spec.choices.map((choice) => ({
            value: choice.value,
            label: i18n.translate(lang, choice.label),
          }))
        : null,
      restart: spec.restart === true,
      locked: isLocked(spec.key),
      readOnly: isReadOnly(spec.key),
      origin: originOf(spec.key),
      overridden: settings.isOverridden(spec.key),
      changed: changedBy(spec.key),
      value: spec.kind === 'secret' ? '' : settings.raw(spec.key),
      isSet: spec.kind === 'secret' ? settings.raw(spec.key).length > 0 : null,
      envValue: spec.kind === 'secret' ? '' : settings.envValue(spec.key),
      envIsSet: spec.kind === 'secret' ? settings.envValue(spec.key).length > 0 : null,
    })),
  }
}

function adminUser(user: User, founderId: string | null, counts: Map<string, number>) {
  return {
    id: user.id,
    email: maskEmail(user.email),
    firstName: user.firstName,
    lastName: user.lastName,
    emailVerified: user.emailVerified,
    isAdmin: user.isAdmin || user.id === founderId,
    isFounder: user.id === founderId,
    hasPassword: user.passwordHash !== null,
    totpEnabled: user.totpEnabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    books: counts.get(user.id) ?? 0,
  }
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  if (!detectContainer().inContainer) {
    app.log.info('Not running in a container — the admin restart button stays hidden')
  }

  app.get('/admin', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused
    return reply.page('admin.html')
  })

  app.get('/api/admin/settings', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused
    return reply.send({
      ok: true,
      canRestart: restarter.canRestart,
      backup: backupContents(app.db),
      restore: await stagedRestore(),
      ...settingsPayload(app, requestLanguage(req)),
    })
  })

  app.get('/api/admin/backup', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const backup = await makeBackup(app.db, new Date())
    req.log.warn({ by: req.user!.id }, 'An admin downloaded a backup')

    return reply
      .header('content-type', 'application/gzip')
      .header('content-disposition', `attachment; filename="${backup.filename}"`)
      .header('cache-control', 'no-store')
      .send(backup.stream)
  })

  app.post('/api/admin/restore', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused
    if (!req.isMultipart()) {
      return reply
        .code(415)
        .send({ ok: false, error: say(req, 'Expected a multipart/form-data body') })
    }

    const part = await req.file({ limits: { fileSize: RESTORE_LIMIT, files: 1 } })
    if (!part) return reply.code(400).send({ ok: false, error: say(req, 'No archive selected') })

    const temp = tempFilePath('.tar.gz')
    await pipeline(part.file, createWriteStream(temp))
    if (part.file.truncated) {
      await safeUnlink(temp)
      return reply
        .code(413)
        .send({ ok: false, error: say(req, 'That archive is too large to take') })
    }

    const name = decodeOriginalName(part.filename ?? 'backup.tar.gz')
    if (!/\.tar\.gz$|\.tgz$/i.test(name)) {
      await safeUnlink(temp)
      return reply.code(415).send({
        ok: false,
        error: say(req, 'That is not a .tar.gz — use the archive this page downloads'),
      })
    }

    const held = await stageRestore(name, temp)
    req.log.warn({ by: req.user!.id, name, size: held.size }, 'An admin staged a restore')
    return reply.send({ ok: true, staged: held })
  })

  app.delete('/api/admin/restore', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    await discardRestore()
    req.log.warn({ by: req.user!.id }, 'An admin threw a staged restore away')
    return reply.send({ ok: true, staged: null })
  })

  app.post('/api/admin/restore/confirm', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const held = await stagedRestore()
    if (!held) {
      return reply.code(409).send({ ok: false, error: say(req, 'There is no archive waiting') })
    }

    await requestRestore(req.user!.id)
    req.log.warn({ by: req.user!.id, name: held.name }, 'An admin confirmed a restore')

    if (!restarter.canRestart) {
      return reply.send({ ok: true, restarting: false })
    }

    reply.raw.once('finish', () => {
      setTimeout(() => restarter.restart(), 100).unref()
    })
    return reply.send({ ok: true, restarting: true })
  })

  app.post('/api/admin/restart', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    if (!restarter.canRestart) {
      return reply.code(409).send({
        ok: false,
        error: say(
          req,
          'This server is not running in a container, so nothing would bring it back'
        ),
      })
    }

    req.log.warn({ by: req.user!.id }, 'An admin asked the server to restart')
    reply.raw.once('finish', () => {
      setTimeout(() => restarter.restart(), 100).unref()
    })
    return reply.send({ ok: true })
  })

  app.put<{ Body: { key?: string; value?: string; passkeysUnderstood?: boolean } }>(
    '/api/admin/settings',
    {
      schema: {
        body: {
          type: 'object',
          required: ['key', 'value'],
          properties: {
            key: { type: 'string', maxLength: 64 },
            value: { type: 'string', maxLength: 4096 },
            passkeysUnderstood: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      const refused = requireAdmin(req, reply)
      if (refused) return refused

      const spec = specFor(req.body.key!)
      if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such setting') })
      if (isLocked(spec.key)) {
        return reply
          .code(409)
          .send({ ok: false, error: say(req, 'That one is locked in the environment') })
      }
      if (isReadOnly(spec.key)) {
        return reply.code(409).send({
          ok: false,
          error: say(req, '{key} is set in the environment, not from here', { key: spec.key }),
        })
      }

      const problem = problemWith(spec, req.body.value!, requestLanguage(req))
      if (problem) return reply.code(400).send({ ok: false, error: problem })

      const movesAddress = ADDRESS_KEYS.has(spec.key) && req.body.value !== settings.raw(spec.key)
      const holders = movesAddress ? app.repos.passkeys.userIdsWithAny() : []

      if (holders.length > 0 && req.body.passkeysUnderstood !== true) {
        return reply.code(409).send({
          ok: false,
          error: say(req, 'Changing the address invalidates every passkey on this server'),
          passkeysAffected: holders.length,
          needsPasskeyConfirmation: true,
        })
      }

      settings.set(spec.key, req.body.value!, req.user!.id)

      if (holders.length > 0) {
        const from = publicUrl()
        const removed = app.repos.passkeys.removeAll()
        app.repos.users.notePasskeysCleared(holders, from)
        req.log.warn(
          { removed, accounts: holders.length, from, by: req.user!.id },
          'The address moved, so every passkey was removed'
        )
      }
      req.log.warn({ key: spec.key, by: req.user!.id }, 'An admin changed a setting')
      return reply.send({ ok: true, ...settingsPayload(app, requestLanguage(req)) })
    }
  )

  app.delete<{ Params: { key: string } }>('/api/admin/settings/:key', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const spec = specFor(req.params.key)
    if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such setting') })
    if (isLocked(spec.key)) {
      return reply
        .code(409)
        .send({ ok: false, error: say(req, 'That one is locked in the environment') })
    }
    if (isReadOnly(spec.key)) {
      return reply.code(409).send({
        ok: false,
        error: say(req, '{key} is set in the environment, not from here', { key: spec.key }),
      })
    }

    settings.clear(spec.key)
    req.log.warn({ key: spec.key, by: req.user!.id }, 'An admin reset a setting to the environment')
    return reply.send({ ok: true, ...settingsPayload(app, requestLanguage(req)) })
  })

  app.get('/api/admin/users', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const founderId = app.repos.users.founderId()
    const counts = app.repos.books.countByUser()
    return reply.send({
      ok: true,
      users: app.repos.users.listAll().map((user) => adminUser(user, founderId, counts)),
    })
  })

  app.post<{ Params: { id: string }; Body: { isAdmin?: boolean } }>(
    '/api/admin/users/:id/admin',
    {
      schema: {
        body: {
          type: 'object',
          required: ['isAdmin'],
          properties: { isAdmin: { type: 'boolean' } },
        },
      },
    },
    async (req, reply) => {
      const refused = requireAdmin(req, reply)
      if (refused) return refused

      const target = app.repos.users.byId(req.params.id)
      if (!target) return reply.code(404).send({ ok: false, error: say(req, 'No such account') })

      if (!app.repos.users.setAdmin(target.id, req.body.isAdmin === true)) {
        return reply
          .code(409)
          .send({ ok: false, error: say(req, 'The first account always keeps admin') })
      }

      req.log.warn(
        { target: target.id, isAdmin: req.body.isAdmin, by: req.user!.id },
        'An admin changed who is an admin'
      )
      return reply.send({ ok: true })
    }
  )

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const target = app.repos.users.byId(req.params.id)
    if (!target) return reply.code(404).send({ ok: false, error: say(req, 'No such account') })

    if (target.id === req.user!.id) {
      return reply
        .code(409)
        .send({ ok: false, error: say(req, 'Delete your own account in Settings, not here') })
    }
    if (app.repos.users.isFounder(target.id)) {
      return reply
        .code(409)
        .send({ ok: false, error: say(req, 'The first account cannot be deleted here') })
    }

    for (const device of app.repos.devices.listForUser(target.id)) {
      await app.deliveries.removeForDevice(device.id)
    }
    const forgotten = await app.library.forgetUser(target.id)
    const promoted = app.repos.users.remove(target.id)

    req.log.warn(
      { target: target.id, books: forgotten, by: req.user!.id },
      'An admin deleted an account'
    )
    if (promoted) {
      req.log.warn({ userId: promoted }, 'No admin was left, so the oldest account became one')
    }
    return reply.send({ ok: true })
  })
}
