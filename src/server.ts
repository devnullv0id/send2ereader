import { readFileSync } from 'node:fs'
import closeWithGrace from 'close-with-grace'
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

async function main(): Promise<void> {
  await prepareUploadDir(config.cleanUploadDirOnBoot)
  await DeliveryQueue.prepare()
  await Library.prepare()

  const secret = provisionSessionSecret()

  const app = await buildApp()

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
