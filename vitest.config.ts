import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    env: {
      ENV_FILE: 'test/no-such.env',
      LOG_LEVEL: 'silent',
      UPLOAD_DIR: 'uploads-test',
      KOBO_QUEUE_DIR: 'queue-test',
      LIBRARY_DIR: 'library-test',
      DATA_DIR: 'data-test',
      KOBO_STORE_URL: 'http://127.0.0.1:39217',
      KOBO_PROXY_TIMEOUT_MS: '700',
      SESSION_SECRET: 'test-secret-not-used-outside-the-suite',
      SCRYPT_N: '1024',
      KEPUBIFY_BIN: 'no-such-kepubify-in-the-suite',
    },
  },
})
