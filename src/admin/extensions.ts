import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import type { ToolAvailability } from '../convert/index.js'
import { refreshTools } from '../convert/index.js'
import { i18n } from '../i18n.js'
import { requestLanguage, say } from '../language.js'

const DATA_DIR = config.dataDir

export interface ExtensionSpec {
  id: string
  label: string
  stages: readonly string[]
  installed: (tools: ToolAvailability) => boolean
  requires?: string
}

export const EXTENSIONS: readonly ExtensionSpec[] = [
  {
    id: 'calibre',
    label: 'calibre',
    stages: ['packages', 'download', 'install', 'plugins', 'verify'],
    installed: (tools) => tools.calibre,
  },
  {
    id: 'pdfcrop',
    label: 'PDF margin cropping',
    stages: ['packages', 'install', 'verify'],
    installed: (tools) => tools.pdfcropmargins,
  },
  {
    id: 'kfx',
    label: 'KFX',
    stages: ['packages', 'download', 'prefix', 'previewer', 'wire', 'verify'],
    installed: (tools) => tools.kfxOutput,
    requires: 'calibre',
  },
]

export const KFX_STAGES = EXTENSIONS.find((one) => one.id === 'kfx')?.stages ?? []

export function specFor(id: string): ExtensionSpec | undefined {
  return EXTENSIONS.find((one) => one.id === id)
}

export type StageState = 'waiting' | 'running' | 'done' | 'failed'

export interface Stage {
  name: string
  state: StageState
  percent: number | null
  detail: string
}

export interface Progress {
  kind: 'install' | 'remove' | null
  terminal: 'done' | 'failed' | null
  stages: Stage[]
}

// The data volume is the one place the unprivileged server and the root agent both reach.
const STATE_DIR = join(DATA_DIR, 'extensions')
const REQUEST_FILE = join(STATE_DIR, 'request')
const ENABLED_FILE = join(STATE_DIR, 'enabled')
const RUNNING_FILE = join(STATE_DIR, 'running')
const SPOOL_FILE = join(STATE_DIR, 'spool')
const AGENT_FILE = join(STATE_DIR, 'agent')
const AGENT_FRESH_MS = 60_000

const NO_AGENT = 'Only the Docker image can install converters, and this server runs without it'

const progressFile = (id: string): string => join(DATA_DIR, id, `${id}.progress`)
const logFile = (id: string): string => join(DATA_DIR, id, `${id}.log`)

export function parseProgress(text: string, stageNames: readonly string[] = KFX_STAGES): Progress {
  const stages: Stage[] = stageNames.map((name) => ({
    name,
    state: 'waiting',
    percent: null,
    detail: '',
  }))
  const byName = new Map(stages.map((stage) => [stage.name, stage]))

  let kind: Progress['kind'] = null
  let terminal: Progress['terminal'] = null

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const [name, state, ...rest] = trimmed.split(' ')

    if (name === 'run') {
      if (state === 'install' || state === 'remove') kind = state
      if (state === 'done' || state === 'failed') terminal = state
      continue
    }

    const stage = byName.get(name ?? '')
    if (!stage) continue
    if (state !== 'running' && state !== 'done' && state !== 'failed') continue

    stage.state = state
    const tail = rest.join(' ').trim()
    if (state === 'running' && /^\d+$/.test(tail)) stage.percent = Number(tail)
    else if (tail) stage.detail = tail.replace(/^'|'$/g, '')
    if (state === 'done') stage.percent = null
  }

  return { kind, terminal, stages }
}

// A removal touches only some stages, so "every stage done" can never decide that a run finished.
export function runState(progress: Progress): 'idle' | 'running' | 'done' | 'failed' {
  if (progress.terminal) return progress.terminal
  if (progress.stages.some((stage) => stage.state === 'failed')) return 'failed'
  if (progress.stages.every((stage) => stage.state === 'waiting')) return 'idle'
  return 'running'
}

async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function running(): Promise<string | null> {
  return (await readOrEmpty(RUNNING_FILE)).trim() || null
}

async function agentPresent(): Promise<boolean> {
  if (await running()) return true
  try {
    const mark = await stat(AGENT_FILE)
    return Date.now() - mark.mtimeMs < AGENT_FRESH_MS
  } catch {
    return false
  }
}

export interface InstallingNow {
  id: string
  label: string
  kind: 'install' | 'remove'
  stage: string | null
  percent: number | null
  queued: number
}

export async function installingNow(): Promise<InstallingNow | null> {
  const active = await running()
  const waiting = await queued()
  const line = active ?? waiting[0]
  if (!line) return null

  const [verb, id] = line.split(' ')
  const spec = specFor(id ?? '')
  if (!spec || (verb !== 'install' && verb !== 'remove')) return null

  const progress = parseProgress(await readOrEmpty(progressFile(spec.id)), spec.stages)
  const current = progress.stages.find((stage) => stage.state === 'running')

  return {
    id: spec.id,
    label: spec.label,
    kind: verb,
    stage: current?.name ?? null,
    percent: current?.percent ?? null,
    queued: waiting.filter((one) => one !== line).length,
  }
}

// The agent moves the request file aside the moment it starts, so what is waiting lives in two files.
async function queued(): Promise<string[]> {
  const [asked, spooled] = await Promise.all([readOrEmpty(REQUEST_FILE), readOrEmpty(SPOOL_FILE)])
  return [...spooled.split('\n'), ...asked.split('\n')].map((line) => line.trim()).filter(Boolean)
}

async function askFor(request: string): Promise<void> {
  const waiting = await queued()
  await write(REQUEST_FILE, `${[...waiting, request].join('\n')}\n`)
}

function blockedNow(
  spec: ExtensionSpec,
  tools: ToolAvailability,
  coming: string[],
  lang = 'en'
): string | null {
  const blocked = blockedBy(spec, tools, lang)
  if (!blocked) return null
  return coming.includes(`install ${spec.requires}`) ? null : blocked
}

async function enabledIds(): Promise<string[]> {
  const text = await readOrEmpty(ENABLED_FILE)
  return EXTENSIONS.filter((one) => text.includes(one.id)).map((one) => one.id)
}

async function write(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, body, 'utf8')
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): FastifyReply | undefined {
  const user = req.user
  if (!user) {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html')
    if (wantsHtml) return reply.redirect('/login?next=%2Fadmin%2Fextensions')
    return reply.code(401).send({ ok: false, error: say(req, 'Not signed in') })
  }
  if (!req.server.repos.users.canAdmin(user.id)) {
    return reply.code(404).send({ ok: false, error: say(req, 'Not found') })
  }
  return undefined
}

export function blockedBy(
  spec: ExtensionSpec,
  tools: ToolAvailability,
  lang = 'en'
): string | null {
  if (!spec.requires) return null
  const needed = specFor(spec.requires)
  if (!needed || needed.installed(tools)) return null
  return i18n.translate(lang, '{label} needs {needed}, which is not installed yet', {
    label: spec.label,
    needed: needed.label,
  })
}

export type Finishes = Map<string, string>

// Watching the files for any change instead would re-detect all the way through a download.
async function finishesOfRuns(): Promise<Finishes> {
  const marks: Finishes = new Map()
  for (const spec of EXTENSIONS) {
    const path = progressFile(spec.id)
    try {
      const found = await stat(path)
      const progress = parseProgress(await readFile(path, 'utf8'), spec.stages)
      marks.set(spec.id, progress.terminal ? `${progress.terminal}@${found.mtimeMs}` : '')
    } catch {
      marks.set(spec.id, '')
    }
  }
  return marks
}

export function newlyFinished(before: Finishes | null, now: Finishes, detectedAt: number): boolean {
  if (before === null) {
    for (const mark of now.values()) {
      const at = Number(mark.split('@')[1])
      if (mark && Number.isFinite(at) && at > detectedAt) return true
    }
    return false
  }
  for (const [id, mark] of now) {
    if (mark !== before.get(id)) return true
  }
  return false
}

// The assistant queues installs and walks away, so finished runs are noticed here. It lives outside the accounts plugin because a server without accounts still converts.
export function watchExtensionRuns(app: FastifyInstance): void {
  const detectedAt = Date.now()
  let seen: Finishes | null = null
  app.log.debug({ scope: 'server' }, `watching ${STATE_DIR} for extension runs`)
  const watch = setInterval(() => {
    void (async () => {
      const now = await finishesOfRuns()
      const changed = newlyFinished(seen, now, detectedAt)
      seen = now
      if (!changed) return

      await refreshTools(app.tools)
      app.log.info({ scope: 'server' }, 'an extension finished; converters re-detected')
    })()
  }, 5000)
  watch.unref()
  app.addHook('onClose', async () => clearInterval(watch))
}

export async function extensionRoutes(app: FastifyInstance): Promise<void> {
  const stateOf = async (
    spec: ExtensionSpec,
    busy: string[],
    enabled: string[],
    agent: boolean,
    lang: string
  ) => {
    const progress = parseProgress(await readOrEmpty(progressFile(spec.id)), spec.stages)
    return {
      id: spec.id,
      label: spec.label,
      installed: spec.installed(app.tools),
      enabled: enabled.includes(spec.id),
      pending: busy.includes(`install ${spec.id}`) || busy.includes(`remove ${spec.id}`),
      blocked: agent ? blockedNow(spec, app.tools, busy, lang) : i18n.translate(lang, NO_AGENT),
      state: runState(progress),
      kind: progress.kind,
      stages: progress.stages,
    }
  }

  app.get('/admin/extensions', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused
    return reply.page('extensions.html')
  })

  app.get('/api/admin/extensions', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const busy = [await running(), ...(await queued())].filter((one) => one !== null)
    const enabled = await enabledIds()
    const agent = await agentPresent()
    const lang = requestLanguage(req)
    const extensions = []
    for (const spec of EXTENSIONS) extensions.push(await stateOf(spec, busy, enabled, agent, lang))

    return reply.send({ ok: true, extensions, busy: busy.length > 0, agent })
  })

  app.post<{ Params: { id: string } }>('/api/admin/extensions/:id', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const spec = specFor(req.params.id)
    if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such extension') })

    if (!(await agentPresent())) {
      return reply.code(409).send({ ok: false, error: say(req, NO_AGENT) })
    }
    const busy = [await running(), ...(await queued())].filter((one) => one !== null)
    if (busy.some((one) => one.endsWith(` ${spec.id}`))) {
      return reply.code(409).send({
        ok: false,
        error: say(req, '{label} is already on its way', { label: spec.label }),
      })
    }
    if (spec.installed(app.tools)) {
      return reply
        .code(409)
        .send({ ok: false, error: say(req, '{label} is already installed', { label: spec.label }) })
    }
    const blocked = blockedNow(spec, app.tools, busy, requestLanguage(req))
    if (blocked) return reply.code(409).send({ ok: false, error: blocked })

    await write(progressFile(spec.id), '')
    await write(logFile(spec.id), '')
    await askFor(`install ${spec.id}`)
    req.log.warn({ scope: 'server', by: req.user?.id }, `an admin asked for ${spec.label}`)

    return reply.send({ ok: true })
  })

  app.delete<{ Params: { id: string } }>('/api/admin/extensions/:id', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const spec = specFor(req.params.id)
    if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such extension') })

    if (!(await agentPresent())) {
      return reply.code(409).send({ ok: false, error: say(req, NO_AGENT) })
    }
    const busy = [await running(), ...(await queued())].filter((one) => one !== null)
    if (busy.some((one) => one.endsWith(` ${spec.id}`))) {
      return reply.code(409).send({
        ok: false,
        error: say(req, '{label} is already on its way', { label: spec.label }),
      })
    }

    // The queue is worked in order, so "install kfx, remove calibre" would strand the plugin it just built.
    const dependants = EXTENSIONS.filter(
      (one) =>
        one.requires === spec.id && (one.installed(app.tools) || busy.includes(`install ${one.id}`))
    )
    if (dependants.length > 0) {
      return reply.code(409).send({
        ok: false,
        error: say(req, 'Remove {dependants} first — it needs {label}', {
          dependants: dependants.map((one) => one.label).join(' and '),
          label: spec.label,
        }),
      })
    }

    await write(progressFile(spec.id), '')
    await write(logFile(spec.id), '')
    await askFor(`remove ${spec.id}`)
    req.log.warn({ scope: 'server', by: req.user?.id }, `an admin asked to remove ${spec.label}`)

    return reply.send({ ok: true })
  })

  app.delete<{ Params: { id: string } }>(
    '/api/admin/extensions/:id/progress',
    async (req, reply) => {
      const refused = requireAdmin(req, reply)
      if (refused) return refused

      const spec = specFor(req.params.id)
      if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such extension') })
      const busy = [await running(), ...(await queued())].filter((one) => one !== null)
      if (busy.length > 0) {
        return reply
          .code(409)
          .send({ ok: false, error: say(req, 'Something is running right now') })
      }

      await write(progressFile(spec.id), '')
      await write(logFile(spec.id), '')
      return reply.send({ ok: true })
    }
  )

  app.get<{ Params: { id: string }; Querystring: { from?: string } }>(
    '/api/admin/extensions/:id/progress',
    async (req, reply) => {
      const refused = requireAdmin(req, reply)
      if (refused) return refused

      const spec = specFor(req.params.id)
      if (!spec) return reply.code(404).send({ ok: false, error: say(req, 'No such extension') })

      const progress = parseProgress(await readOrEmpty(progressFile(spec.id)), spec.stages)
      const state = runState(progress)

      const from = Number(req.query.from ?? 0)
      const log = await readOrEmpty(logFile(spec.id))
      const offset = Number.isFinite(from) && from > 0 && from <= log.length ? from : 0

      const busy = [await running(), ...(await queued())].filter((one) => one !== null)
      const mine = busy.filter((one) => one.endsWith(` ${spec.id}`))
      if (mine.length === 0 && (state === 'done' || state === 'failed')) {
        await refreshTools(app.tools)
      }

      return reply.send({
        ok: true,
        id: spec.id,
        state,
        kind: progress.kind,
        stages: progress.stages,
        installed: spec.installed(app.tools),
        blocked: (await agentPresent()) ? blockedNow(spec, app.tools, busy) : NO_AGENT,
        pending: mine.length > 0,
        busy: busy.length > 0,
        chunk: log.slice(offset),
        offset: log.length,
      })
    }
  )
}
