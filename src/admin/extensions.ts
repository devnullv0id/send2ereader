import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import type { ToolAvailability } from '../convert/index.js'
import { refreshTools } from '../convert/index.js'

// Where the root agent leaves its work: the data volume is the one place the
// unprivileged server and the privileged agent can both reach.
const DATA_DIR = config.dataDir

export interface ExtensionSpec {
  id: string
  label: string
  stages: readonly string[]
  installed: (tools: ToolAvailability) => boolean
  requires?: string
}

// calibre first, because the other two are useless without it: pdfCropMargins
// is only offered for a PDF, and KFX is a calibre plugin driving a Windows
// program.
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

const STATE_DIR = join(DATA_DIR, 'extensions')
const REQUEST_FILE = join(STATE_DIR, 'request')
const ENABLED_FILE = join(STATE_DIR, 'enabled')
const RUNNING_FILE = join(STATE_DIR, 'running')
const SPOOL_FILE = join(STATE_DIR, 'spool')

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

    // A removal touches only some of the stages, so "every stage is done" can
    // never decide whether a run has finished — it left the page saying
    // "running" ten minutes after the work was over. The script says so itself.
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

// What the agent took on, and what is still waiting for it. The agent moves the
// whole request file aside the moment it starts, so appending here can never
// tread on a line it is part-way through reading.
async function running(): Promise<string | null> {
  return (await readOrEmpty(RUNNING_FILE)).trim() || null
}

// Two files, because the agent moves the request file aside the moment it
// starts on it. What is left in the spool is still waiting, and saying
// otherwise would offer an install that is already coming.
async function queued(): Promise<string[]> {
  const [asked, spooled] = await Promise.all([readOrEmpty(REQUEST_FILE), readOrEmpty(SPOOL_FILE)])
  return [...spooled.split('\n'), ...asked.split('\n')].map((line) => line.trim()).filter(Boolean)
}

async function askFor(request: string): Promise<void> {
  const waiting = await queued()
  await write(REQUEST_FILE, `${[...waiting, request].join('\n')}\n`)
}

// The assistant asks for all three at once, so calibre is still in the queue
// when KFX is checked. Waiting for it counts as having it.
function blockedNow(spec: ExtensionSpec, tools: ToolAvailability, coming: string[]): string | null {
  const blocked = blockedBy(spec, tools)
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
    return reply.code(401).send({ ok: false, error: 'Not signed in' })
  }
  if (!req.server.repos.users.canAdmin(user.id)) {
    return reply.code(404).send({ ok: false, error: 'Not found' })
  }
  return undefined
}

// What a missing dependency means, said the same way everywhere: the page
// greys the card with it, and the route refuses with it.
export function blockedBy(spec: ExtensionSpec, tools: ToolAvailability): string | null {
  if (!spec.requires) return null
  const needed = specFor(spec.requires)
  if (!needed || needed.installed(tools)) return null
  return `${spec.label} needs ${needed.label}, which is not installed yet`
}

export type Finishes = Map<string, string>

// One mark per extension, empty until its run says it is over. Watching the
// files for any change instead would re-detect all the way through a download.
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

// Whether anything has finished that the running server has not accounted for.
// The first look back is against the moment detection ran, so a run that ended
// while the server was still starting counts as news.
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

// The assistant queues an install and walks away, so nothing is watching the
// progress when the agent finishes. Without this the formats stayed refused
// until somebody opened the Converters page or restarted the server. It lives
// outside the accounts plugin because a server with no accounts still converts,
// and still has an agent that can be asked to install something.
//
// It reacts to a run saying it is over rather than to the queue going quiet:
// the assistant asks for all three at once, and calibre being installed is a
// fact the moment its own run ends, not when KFX finishes twenty minutes later.
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
  const stateOf = async (spec: ExtensionSpec, busy: string[], enabled: string[]) => {
    const progress = parseProgress(await readOrEmpty(progressFile(spec.id)), spec.stages)
    return {
      id: spec.id,
      label: spec.label,
      installed: spec.installed(app.tools),
      enabled: enabled.includes(spec.id),
      pending: busy.includes(`install ${spec.id}`) || busy.includes(`remove ${spec.id}`),
      blocked: blockedNow(spec, app.tools, busy),
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
    const extensions = []
    for (const spec of EXTENSIONS) extensions.push(await stateOf(spec, busy, enabled))

    return reply.send({ ok: true, extensions, busy: busy.length > 0 })
  })

  app.post<{ Params: { id: string } }>('/api/admin/extensions/:id', async (req, reply) => {
    const refused = requireAdmin(req, reply)
    if (refused) return refused

    const spec = specFor(req.params.id)
    if (!spec) return reply.code(404).send({ ok: false, error: 'No such extension' })

    const busy = [await running(), ...(await queued())].filter((one) => one !== null)
    if (busy.some((one) => one.endsWith(` ${spec.id}`))) {
      return reply.code(409).send({ ok: false, error: `${spec.label} is already on its way` })
    }
    if (spec.installed(app.tools)) {
      return reply.code(409).send({ ok: false, error: `${spec.label} is already installed` })
    }
    const blocked = blockedNow(spec, app.tools, busy)
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
    if (!spec) return reply.code(404).send({ ok: false, error: 'No such extension' })

    const busy = [await running(), ...(await queued())].filter((one) => one !== null)
    if (busy.some((one) => one.endsWith(` ${spec.id}`))) {
      return reply.code(409).send({ ok: false, error: `${spec.label} is already on its way` })
    }

    // Taking calibre away takes everything built on it, so say so rather than
    // leaving a plugin behind with nothing to drive it.
    const dependants = EXTENSIONS.filter(
      (one) => one.requires === spec.id && one.installed(app.tools)
    )
    if (dependants.length > 0) {
      return reply.code(409).send({
        ok: false,
        error: `Remove ${dependants.map((one) => one.label).join(' and ')} first — it needs ${spec.label}`,
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
      if (!spec) return reply.code(404).send({ ok: false, error: 'No such extension' })
      const busy = [await running(), ...(await queued())].filter((one) => one !== null)
      if (busy.length > 0) {
        return reply.code(409).send({ ok: false, error: 'Something is running right now' })
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
      if (!spec) return reply.code(404).send({ ok: false, error: 'No such extension' })

      const progress = parseProgress(await readOrEmpty(progressFile(spec.id)), spec.stages)
      const state = runState(progress)

      const from = Number(req.query.from ?? 0)
      const log = await readOrEmpty(logFile(spec.id))
      const offset = Number.isFinite(from) && from > 0 && from <= log.length ? from : 0

      // The run has stopped and the agent has taken its request file away, so
      // whatever it did to the filesystem is finished. Detection is what decides
      // what the Convert page offers, and it is cheap enough to redo here rather
      // than making anybody restart.
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
        blocked: blockedNow(spec, app.tools, busy),
        pending: mine.length > 0,
        busy: busy.length > 0,
        chunk: log.slice(offset),
        offset: log.length,
      })
    }
  )
}
