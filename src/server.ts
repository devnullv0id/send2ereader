import { readFileSync } from 'node:fs'
import closeWithGrace from 'close-with-grace'
import { applyPendingRestore } from './admin/restore.js'
import { buildApp } from './app.js'
import { WEAK_SECRET_LENGTH } from './auth/secret.js'
import {
  config,
  provisionSessionSecret,
  sessionSecretIsWeak,
  sessionSecretOrigin,
} from './config.js'
import { prepareUploadDir } from './files.js'
import { DeliveryQueue } from './kobo/queue.js'
import { Library } from './library.js'

function ownVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

const version = ownVersion()

function bootLogger() {
  const say = (level: string) => (fields: object, message: string) => {
    console.error(`${new Date().toISOString()} ${level.toUpperCase()} restore ${message}`, fields)
  }
  return { info: say('info'), error: say('error') }
}

async function main(): Promise<void> {
  await prepareUploadDir(config.cleanUploadDirOnBoot)
  await DeliveryQueue.prepare()
  await Library.prepare()

  const restored = await applyPendingRestore(bootLogger())

  const secret = provisionSessionSecret()

  const app = await buildApp()

  if (restored) {
    const said = restored.ok
      ? `a backup was restored at boot — ${restored.books} books came with it`
      : `a restore was asked for and failed: ${restored.error}`
    app.log[restored.ok ? 'warn' : 'error']({ scope: 'server' }, said)
  }

  app.log.info({ scope: 'server', version, env: process.env.NODE_ENV ?? 'development' }, 'starting')

  if (secret.created) {
    app.log.warn(
      { scope: 'server', path: secret.path },
      'no SESSION_SECRET set — generated one (losing it signs everyone out and makes stored ' +
        'Kobo tokens and two-factor secrets unreadable)'
    )
  } else if (sessionSecretOrigin() === 'generated') {
    app.log.info({ scope: 'server', path: secret.path }, 'using the generated session key on disk')
  }

  if (sessionSecretIsWeak()) {
    app.log.warn(
      { scope: 'server', length: WEAK_SECRET_LENGTH },
      'SESSION_SECRET is shorter than the recommended length. It signs every session and ' +
        'encrypts stored Kobo tokens and two-factor secrets, so a guessable one undoes both.'
    )
  }

  const have = Object.entries(app.tools)
    .filter(([, available]) => available)
    .map(([tool]) => tool)
  const missing = Object.entries(app.tools)
    .filter(([, available]) => !available)
    .map(([tool]) => tool)
  app.log.info(
    { scope: 'server', have: have.join(','), missing: missing.join(',') },
    'converters ready'
  )

  closeWithGrace({ delay: 15_000 }, async ({ err, signal }) => {
    if (err) app.log.error({ scope: 'server', err }, 'shutting down after an unhandled error')
    else app.log.info({ scope: 'server', signal }, 'shutting down')
    await app.close()
  })

  await app.listen({
    host: config.httpAddr,
    port: config.httpPort,
    listenTextResolver: () => '',
  })

  app.log.info(
    {
      scope: 'server',
      addr: app
        .addresses()
        .map((entry) => `${entry.address}:${entry.port}`)
        .join(','),
    },
    'listening'
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
