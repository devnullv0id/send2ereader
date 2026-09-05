export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email_verified INTEGER NOT NULL DEFAULT 0,
    -- NULL for accounts that exist only through SSO.
    password_hash TEXT,
    is_owner      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    last_login_at TEXT
  );

  -- One row per external identity. A user may have both a password and an
  -- OIDC link, which is why this is not a column on users.
  CREATE TABLE identities (
    user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    issuer    TEXT NOT NULL,
    subject   TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    PRIMARY KEY (issuer, subject)
  );
  CREATE INDEX identities_user ON identities(user_id);

  -- Single-use links for e-mail verification and password reset. Only the
  -- hash is stored, so a database leak does not hand over live links.
  CREATE TABLE email_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset')),
    email      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);

  -- A registered Kobo. The token is the bearer credential embedded in the
  -- device's api_endpoint, so only its hash is stored.
  CREATE TABLE devices (
    id             TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    proxy_store    INTEGER NOT NULL DEFAULT 1,
    kobo_device_id TEXT,
    kobo_user_id   TEXT,
    created_at     TEXT NOT NULL,
    last_seen_at   TEXT
  );
  CREATE INDEX devices_user ON devices(user_id);
  `,

  `
  CREATE TABLE email_tokens_new (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'signin')),
    email      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO email_tokens_new SELECT * FROM email_tokens;
  DROP TABLE email_tokens;
  ALTER TABLE email_tokens_new RENAME TO email_tokens;
  CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);
  `,

  `
  -- One row per sign-in. The cookie carries this id, so a session can be
  -- revoked from another browser — which stateless cookies cannot do, and
  -- which is what "Sign out everywhere else" needs to mean anything.
  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_agent   TEXT NOT NULL DEFAULT '',
    ip           TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- A WebAuthn credential. The public key is not a secret, but the id is how
  -- the device is recognised, so it is what we look up by.
  CREATE TABLE passkeys (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label          TEXT NOT NULL,
    public_key     TEXT NOT NULL,
    counter        INTEGER NOT NULL DEFAULT 0,
    transports     TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    last_used_at   TEXT
  );
  CREATE INDEX passkeys_user ON passkeys(user_id);

  -- Recovery codes for two-factor. Hashed like every other credential here,
  -- and marked rather than deleted so "3 of 8 unused" can be counted.
  CREATE TABLE recovery_codes (
    code_hash  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);

  -- The TOTP secret, and the send defaults the design says follow the account.
  -- Nullable: an account without two-factor has no secret, and one that has
  -- never touched Settings has no stored preferences.
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE users ADD COLUMN prefs TEXT;

  -- Two of the design's four Kobo toggles. The third, waking the device after
  -- a send, has no column because it has no mechanism: a Kobo is reachable
  -- only when it chooses to sync, so there is nothing to store.
  ALTER TABLE devices ADD COLUMN deliver_over_sync INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE devices ADD COLUMN hold_until_collected INTEGER NOT NULL DEFAULT 1;

  CREATE TABLE email_tokens_new (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose    TEXT NOT NULL CHECK (purpose IN ('verify', 'reset', 'signin', 'email_change')),
    email      TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at    TEXT,
    created_at TEXT NOT NULL
  );
  INSERT INTO email_tokens_new SELECT * FROM email_tokens;
  DROP TABLE email_tokens;
  ALTER TABLE email_tokens_new RENAME TO email_tokens;
  CREATE INDEX email_tokens_user ON email_tokens(user_id, purpose);
  `,

  `
  ALTER TABLE devices ADD COLUMN token_enc TEXT;
  `,

  `
  ALTER TABLE devices ADD COLUMN last_sync_failed_at TEXT;
  `,

  `
  ALTER TABLE email_tokens ADD COLUMN persist INTEGER NOT NULL DEFAULT 1;
  `,

  `
  CREATE TABLE books (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    title        TEXT NOT NULL,
    authors      TEXT NOT NULL DEFAULT '',
    format       TEXT NOT NULL,
    size         INTEGER NOT NULL,
    path         TEXT NOT NULL,
    cover_path   TEXT,
    cover_type   TEXT,
    -- 'send' or 'convert', so the list can say where a book came from.
    source       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL
  );
  CREATE INDEX books_user ON books(user_id, created_at DESC);
  CREATE INDEX books_expiry ON books(expires_at);

  -- Null means "whatever the server's default is", so raising RETAIN_DAYS
  -- lifts everyone who never expressed a preference. 0 means off, chosen.
  ALTER TABLE users ADD COLUMN retain_days INTEGER;
  `,

  `
  ALTER TABLE users ADD COLUMN retain_minutes INTEGER;
  UPDATE users SET retain_minutes = retain_days * 1440 WHERE retain_days IS NOT NULL;
  `,

  `
  ALTER TABLE books ADD COLUMN device_id TEXT REFERENCES devices(id) ON DELETE SET NULL;
  ALTER TABLE books ADD COLUMN archived_at TEXT;
  CREATE INDEX books_device ON books(device_id, expires_at);
  `,

  `
  ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
  ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';

  ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
  UPDATE users SET is_admin = 1
   WHERE id = (SELECT id FROM users ORDER BY created_at, id LIMIT 1);

  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  `,

  `
  -- Columns nothing ever wrote. prefs was overtaken by localStorage on the
  -- client; the two device toggles were read and handed to the page, which
  -- showed them as switches that could never move.
  ALTER TABLE users DROP COLUMN prefs;
  ALTER TABLE devices DROP COLUMN deliver_over_sync;
  ALTER TABLE devices DROP COLUMN hold_until_collected;

  -- code_hash was globally unique, so two accounts drawing the same recovery
  -- code would collide and the second one's set would fail to save.
  CREATE TABLE recovery_codes_new (
    code_hash  TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    used_at    TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, code_hash)
  );
  INSERT INTO recovery_codes_new SELECT code_hash, user_id, used_at, created_at
    FROM recovery_codes;
  DROP TABLE recovery_codes;
  ALTER TABLE recovery_codes_new RENAME TO recovery_codes;
  CREATE INDEX recovery_codes_user ON recovery_codes(user_id);
  `,

  `
  ALTER TABLE users ADD COLUMN passkeys_cleared_at TEXT;
  ALTER TABLE users ADD COLUMN passkeys_cleared_from TEXT;
  `,

  `
  ALTER TABLE recovery_codes ADD COLUMN purpose TEXT NOT NULL DEFAULT 'second_factor';
  CREATE INDEX recovery_codes_purpose ON recovery_codes(user_id, purpose);
  `,

  `
  -- How many times this account may still put off confirming its address. NULL
  -- is an account that has never been asked, so it still has the whole budget —
  -- which means raising the limit later reaches everyone who never used one.
  ALTER TABLE users ADD COLUMN verify_reminders_left INTEGER;
  `,

  `
  -- Facts about this installation that are not settings. A setting is a key the
  -- environment can also carry; this is not one, and putting it in the settings
  -- table would draw a field on the admin page that means nothing.
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- A server that already has an account is a server somebody already set up.
  -- Without this line, upgrading would put every existing admin through a
  -- first-run assistant they finished months ago.
  INSERT INTO meta (key, value)
    SELECT 'setup_done', '1' WHERE EXISTS (SELECT 1 FROM users);
  `,

  `
  -- is_owner gated nothing. It was set on the first account, reassigned on every
  -- SSO sign-in beside is_admin, read by one log line, and handed to the pages
  -- in every user payload. A flag that looks like authorization and is not is a
  -- trap for whoever reads this next; is_admin does the work.
  ALTER TABLE users DROP COLUMN is_owner;
  `,

  `
  -- NULL means "follow the server default", so an admin changing LANGUAGE moves
  -- everyone who never picked for themselves.
  ALTER TABLE users ADD COLUMN language TEXT;
  `,
]
