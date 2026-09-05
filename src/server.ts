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

async function main(): Promise<void> {
  await prepareUploadDir(config.cleanUploadDirOnBoot)
  await DeliveryQueue.prepare()
  await Library.prepare()

  const secret = provisionSessionSecret()

  const app = await buildApp()

  if (secret.created) {
    app.log.info(
      { path: secret.path },
      'No SESSION_SECRET was given, so one was generated and written. Keep this file: ' +
        'losing it signs everyone out and makes stored Kobo tokens and two-factor secrets unreadable.'
    )
  } else if (sessionSecretOrigin() === 'generated') {
    app.log.info({ path: secret.path }, 'Using the generated session key on disk')
  }

  if (sessionSecretIsWeak()) {
    app.log.warn(
      { length: WEAK_SECRET_LENGTH },
      'SESSION_SECRET is shorter than the recommended length. It signs every session and ' +
        'encrypts stored Kobo tokens and two-factor secrets, so a guessable one undoes both.'
    )
  }

  app.log.info(
    {
      kepubify: app.tools.kepubify,
      calibre: app.tools.calibre,
      pdfcropmargins: app.tools.pdfcropmargins,
    },
    'Converter availability'
  )
  for (const [tool, available] of Object.entries(app.tools)) {
    if (!available) app.log.warn({ tool }, 'Converter not found on PATH — related options disabled')
  }

  closeWithGrace({ delay: 15_000 }, async ({ err, signal }) => {
    if (err) app.log.error({ err }, 'Shutting down after an unhandled error')
    else app.log.info({ signal }, 'Shutting down')
    await app.close()
  })

  await app.listen({ host: config.httpAddr, port: config.httpPort })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
