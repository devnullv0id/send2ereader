# HTTP API

Reference for building a front end against this server. Everything here is
implemented and covered by tests.

Two rules shape the whole surface:

- **Sending a book never requires an account.** The key flow works for anyone
  who can reach the server, and that will not change.
- **Accounts are optional.** They are on by default, with the session secret
  generated on first boot if none was given. With `ACCOUNTS=false` there is no
  database, no cookies, and every `/auth/*` and account page returns **404**.
  A `404` from `/auth/status` is the signal that accounts are off — `/healthz`
  does not carry it.

Errors are JSON: `{ "ok": false, "error": "human readable reason" }` on the
JSON API, and a bare `{ "error": "..." }` on the endpoints a device or a
download link hits directly (`/kobo/*`, `/download/*`, the pair endpoints, the
converted-file download). Status codes carry the meaning; the strings are for
display and may change.

**CSRF.** Every state-changing request under accounts is checked. `GET
/auth/status` hands out the token as `csrf`; send it back as an
`x-csrf-token` header on `POST`/`PATCH`/`PUT`/`DELETE`, or the request is
refused with `403` before any handler runs.

---

## Discovery

### `GET /healthz`

Unauthenticated. Everything the sender page needs to render itself.

```json
{
  "ok": true,
  "tools": {
    "kepubify": true,
    "calibre": true,
    "pdfcropmargins": true,
    "kfxInput": false,
    "kfxOutput": false,
    "layoutFix": true
  },
  "maxFileSize": 838860800,
  "expireSeconds": 300,
  "publicUrl": "https://send.example.com/",
  "queueTtlSeconds": 21600
}
```

`tools` reports which converters this deployment actually has. A missing one is
not an error: the file is sent unconverted instead. Use it to explain the
consequence rather than to hide the option. `expireSeconds` is how long a key
outlives its ereader, `publicUrl` is the address the server calls itself, and
`queueTtlSeconds` is how long a queued Kobo delivery waits to be collected.

### `GET /i18n/:code`

Unauthenticated. The dictionary for one installed language, as the pages use it:

```json
{
  "ok": true,
  "language": "de",
  "languages": [
    { "code": "en", "name": "English" },
    { "code": "de", "name": "Deutsch" }
  ],
  "strings": { "Send": "Senden", "…": "…" }
}
```

`strings` maps the English source text to its translation; a missing key means
the English text is used as-is. An uninstalled `code` degrades to the `en`
payload (empty `strings`); a code that is not even language-shaped is `404`.

Every HTML page is served already translated into the language the request
resolves to: the signed-in account's choice, else the `s2e_lang` cookie
(set by the footer picker; plain, not `HttpOnly`, one year), else the
server's `LANGUAGE` setting, else English. `<html lang>` names the result,
and the page scripts fetch this dictionary for the strings they build at
runtime. Errors and e-mails follow the same resolution.

### `GET /auth/status`

**404 when accounts are off.** Safe to call unauthenticated.

```json
{
  "enabled": true,
  "unclaimed": false,
  "registrationOpen": false,
  "ssoEnabled": true,
  "ssoProvider": "Authentik",
  "mailEnabled": true,
  "verificationNeeded": true,
  "recoveryPhraseInUse": false,
  "minPasswordLength": 10,
  "passwordRules": { "minLength": 10, "maxLength": 128, "needs": [] },
  "signInLinkLasts": "15 minutes",
  "emailTokenLasts": "24 hours",
  "user": null,
  "csrf": "…",
  "setupPending": false,
  "verifyNudge": null,
  "pendingEmail": null,
  "hasRecoveryPhrase": null,
  "awaitingSecondFactor": false,
  "passkeysPossible": true,
  "staySignedIn": true,
  "soleAccount": null,
  "installing": null,
  "language": "en",
  "languages": [{ "code": "en", "name": "English" }, { "code": "de", "name": "Deutsch" }]
}
```

| Field | Meaning for the UI |
| --- | --- |
| `unclaimed` | No administrator exists. Send the visitor to `/setup`. |
| `registrationOpen` | Whether to offer "create an account" at all. |
| `ssoEnabled`, `ssoProvider` | Whether to show the SSO button, and what to call it. |
| `mailEnabled` | `false` means links are written to the server log, not e-mailed. Say so, or people wait for mail that will never arrive. |
| `verificationNeeded` | Whether confirming an address is possible at all — it is `SMTP_ENABLED`, and with mail off nothing is gated on verification. |
| `recoveryPhraseInUse` | Mail is off, so accounts get a six-word phrase as the way back in. |
| `minPasswordLength`, `passwordRules` | Drive `minlength` and the hint text from these, never hardcoded values. `passwordRules.needs` lists the enabled composition rules as `{ id, said }`. |
| `user` | `null` when signed out. Otherwise `{ id, email, firstName, lastName, emailVerified, isAdmin, createdAt, hasPassword, totpEnabled, passkeysClearedAt, passkeysClearedFrom }`. |
| `csrf` | The token to send back as `x-csrf-token`. |
| `setupPending` | The signed-in admin has not finished first-run setup; the shell forwards them to `/setup/start`. |
| `verifyNudge` | `{ needed, remindersLeft }` for the confirm-your-address modal. |
| `awaitingSecondFactor` | A password was accepted and the session is holding for a TOTP code. |
| `passkeysPossible` | The configured address can hold a passkey (https, or localhost). |
| `soleAccount` | `true` when the signed-in user is the only account. |
| `installing` | Admins only, else `null`: `{ id, label, kind: "install"\|"remove", stage, percent, queued }` while the extension agent is working — feeds the header badge. |
| `language` | The language this request resolved to — account choice, `s2e_lang` cookie, or the server default. |
| `languages` | Every installed language as `{ code, name }`, English always first. Feeds the pickers. |

---

## Sending a book (no account needed)

The ereader shows a short key; the sender enters it. Nothing is stored beyond
the key's lifetime.

### `POST /generate`

Called by the **ereader**. Returns the key as `text/plain`, e.g. `7F3K`.
Rate limited. Accepts any `Content-Type`, including none — ereader browsers
attach one to bodyless POSTs.

Returns `503` with body `error` if the key space is exhausted.

### `GET /status/:key`

Polled by the ereader every few seconds. **Requires the same `User-Agent` that
generated the key**; a mismatch returns `404` exactly like an unknown key, so it
cannot be used to probe.

```json
{
  "alive": "2026-08-06T12:00:00.000Z",
  "expiresIn": 300,
  "file": { "name": "book.kepub.epub", "size": 481920 },
  "urls": ["https://example.com/article"]
}
```

`file` is `null` until something is sent. Polling also keeps the key alive.
`expiresIn` is the configured `EXPIRE_SECONDS`, not a countdown.

### `GET /key/:key`

For the **sender**, so the form can preselect a conversion target. No
`User-Agent` check — the sender is a different device.

```json
{
  "device": "kobo",
  "label": "a Kobo device",
  "hasFile": false,
  "connected": true,
  "silentFor": 0,
  "expiresInMs": 293000
}
```

`device` is `kobo` | `kindle` | `tolino` | `generic`. `connected` says whether
the ereader is still polling, `silentFor` how many seconds it has not. `404` if
unknown.

### `POST /key/:key/extend`

Renews the key's lease and returns `{ "ok": true, "expiresInMs": … }`. The
sender page calls it while a long upload runs so the key does not expire under
the transfer. `404` for an unknown key; rate limited.

### `POST /upload`

`multipart/form-data`. Send `key` (this flow) or `deviceId` (Kobo sync flow,
below), plus a file, a url, or both.

| Field | Values |
| --- | --- |
| `key` | the pairing key — this flow |
| `deviceId` | a registered device instead of a key — see "Sending to a registered device" |
| `file` | the book |
| `url` | `http(s)` only; anything else is rejected |
| `target` | `auto` (default) · `kobo` · `kindle` · `none` |
| `format` | an explicit output format (`kepub`, `epub`, `azw3`, `mobi`, `kfx`, `pdf`, `txt`, `htmlz`); overrides what `target` would pick, ignored if the tools cannot reach it |
| `kindleFormat` | `azw3` (default) · `mobi` |
| `layoutFix` | defaults **on**; send `off` explicitly to disable |
| `pdfcropmargins`, `transliteration` | default off |
| `layoutFixImages`, `layoutFixCovers`, `layoutDarkCover`, `layoutPreserveAnchors`, `layoutFixCaptioned`, `layoutFixMultiImage`, `layoutMinWidthPercent`, `layoutCoverColor` | per-send layout-fix tuning; absent fields use the engine's defaults |
| `hold` | device flow only: convert and stage, but wait for `POST /upload/commit` before queueing |

```json
{
  "ok": true,
  "key": "7F3K",
  "messages": ["Upload successful! …", "Filename: book.kepub.epub"],
  "filename": "book.kepub.epub",
  "conversion": ["layoutfix", "kepubify"],
  "pending": null,
  "url": null,
  "kept": null
}
```

`messages` is an array of plain strings — **render them as text, never HTML**.
They embed the uploaded filename, which is attacker-controlled. `conversion`
lists the steps that actually ran, in order, and is `[]` for a pass-through.
`kept` describes the library copy when the sender is signed in and keeping
books, else `null`.

A Kindle conversion is emitted with calibre's `--share-not-sync`, which is what
makes the downloaded book show its cover. calibre otherwise stamps an invented
ASIN into the file and marks it "bought", so the Kindle asks Amazon for a cover
that does not exist and then refuses to use the one inside the file. Set
`KINDLE_SHARE_NOT_SYNC=false` to get calibre's stock behaviour back. A file that
is *already* AZW3 or MOBI is passed through untouched and keeps whatever
markings it came with — the UI should say so.

Failure codes: `400` bad key/format/url, `413` too large, `415` not multipart,
`503` too many conversions already running, and `422` when a converter itself
failed — with a structured body:

```json
{ "ok": false, "error": "calibre failed (exit code 1)", "detail": "…the converter's own last lines, path-redacted…", "tool": "calibre" }
```

`tool` names the converter that failed; it is absent on refusals that never ran
one, which is how a front end can tell "the converter broke" from "the server
said no".

**`layoutFix` defaults on, so an absent field means enabled.** An unchecked
checkbox submits nothing, so a form must send an explicit `off` — pair the box
with a hidden input of the same name, hidden first.

### `POST /upload/commit` and `POST /upload/discard`

The other half of `hold`. An upload staged with `hold` returns a `pending`
token; `commit` (`{ deviceId, token }` or `{ key, token }`) queues or delivers
it, `discard` deletes it. `404` when nothing is staged under that token.

### `GET /download/:filename?key=KEY`

Called by the ereader. Requires the generating `User-Agent`, and `:filename`
must match exactly. Supports `Range`. `400` without a key. The filename is the
last path segment on purpose: the Kindle browser names the saved file after the
URL.

### `DELETE /file/:key`

Detaches **and deletes** the stored file. Requires the generating `User-Agent`.

---

## Converting without sending

### `GET /api/convert/targets?from=epub`

What the Convert page offers for a given source extension. Unauthenticated.
Returns `{ "groups": [...] }` — Kobo / Kindle / Anything else, each item
carrying `format`, `label`, `via` (the converter chain) and `refusal` (a
sentence when the tools cannot do it, so the option is greyed with a reason
instead of hidden). Without `from` it still answers, so the grid is never
empty.

### `POST /convert`

`multipart/form-data`: `file`, `format` (required), and the same option fields
as `/upload`. Rate limited (`CONVERT_RATE_MAX` per `CONVERT_RATE_WINDOW`,
default 5/minute) — expect `429` with a `retry-after` header.

```json
{ "ok": true, "id": "uuid", "filename": "book.kepub.epub", "size": 481920, "applied": ["layoutfix", "kepubify"], "url": "/convert/uuid/book.kepub.epub", "kept": null }
```

Failures: `400` no file / no such format, `413`, `415`, `503`, and `422` either
as a refusal (`error` only — the target is not reachable with the installed
tools) or a converter failure (`error`, `detail`, `tool`, as on `/upload`).

### `GET /convert/:id/:filename`

Collects the result **once** — the file is deleted as it is served. `404` when
the id or filename does not match, or after the first download. A conversion
made while signed in is only served to that account.

---

## Accounts

All **404 when accounts are off**. Session is an encrypted `HttpOnly` cookie;
send `credentials: 'same-origin'` and the `x-csrf-token` header on writes.

The core flow:

| Route | Body | Notes |
| --- | --- | --- |
| `POST /auth/register` | `{ email, password, firstName?, lastName? }` | First account becomes administrator. `403` once closed. Returns `claimed`, `mailEnabled`, and — when mail is off — `recoveryPhrase`, shown exactly once. |
| `POST /auth/login` | `{ email, password, remember? }` | `401` with identical wording for a wrong password and an unknown address — deliberately not an enumeration oracle. With TOTP on it returns `{ ok: true, secondFactor: true }` and **no `user`** — finish with `/auth/login/second-factor`. |
| `POST /auth/login/second-factor` | `{ code }` | The held sign-in's TOTP code. `440` when the hold timed out — start over. |
| `POST /auth/login/recovery` | `{ email, phrase, remember? }` | Sign in with the six-word recovery phrase (mail-off servers). |
| `POST /auth/login/cancel` | — | Abandons a held second-factor sign-in. |
| `POST /auth/logout` | — | |
| `GET /auth/verify?token=` | — | Redirects to `/settings?verified=1#profile` or `/login?error=verify`. |
| `POST /auth/verify/resend` | — | Requires a session. Rate limited. |
| `POST /auth/verify/remind-later` | — | Spends one of the verify-nudge reminders. |
| `POST /auth/reset/request` | `{ email }` | **Always** `{ ok: true }`, known address or not. |
| `POST /auth/reset` | `{ token, password }` | Signs the user in and marks the address verified. |
| `POST /auth/link/request` | `{ email }` | E-mails a sign-in link. Always `{ ok: true }`. |
| `GET /auth/link?token=` | — | The link itself; signs in and lands on `/auth/linked`. |

The signed-in account surface:

| Route | Purpose |
| --- | --- |
| `POST /auth/name` | Change first/last name. |
| `POST /auth/language` | `{ language }` — an installed code, or `null` to follow the server default again. `400` for anything not installed. |
| `POST /auth/password` | Change the password; revokes every other session. |
| `POST /auth/email` / `POST /auth/email/cancel` / `GET /auth/email/confirm` | Change of address, confirmed from the new address before anything switches. |
| `GET`/`POST /auth/recovery-phrase` | See whether a phrase exists / issue a fresh one (mail-off servers). |
| `GET /auth/tfa` · `POST /auth/tfa/begin` · `/confirm` · `/disable` · `/codes` | TOTP two-factor: state, enrollment, confirmation, teardown, fresh recovery codes. Disabling and codes require reauthentication (`password` and/or `code`). |
| `GET`/`POST /auth/passkeys` · `POST /auth/passkeys/options` · `DELETE /auth/passkeys/:id` | Passkey list and registration (WebAuthn). |
| `POST /auth/passkey/login/options` · `POST /auth/passkey/login` | Passkey sign-in. Rate limited. |
| `POST /auth/passkeys/cleared/ack` | Dismisses the "your passkey was removed when the address changed" notice. |
| `GET /auth/sessions` · `DELETE /auth/sessions/:id` · `POST /auth/sessions/revoke-others` | Where you're signed in. |

Password endpoints are **rate limited to 10 per 5 minutes** because each
attempt costs a deliberately expensive password hash. Expect `429`.

### Single sign-on

Only registered when SSO is fully configured; `ssoEnabled` on `/auth/status`
tells you whether to show the button.

- `GET /auth/sso?next=/settings` — full-page redirect to the provider. **Not
  XHR**: it is a navigation.
- `GET /auth/sso/callback` — the provider returns here; ends on the `next`
  page or `/login?error=sso`.

An SSO identity is joined to an existing local account **only** when the
provider asserts `email_verified`. `OIDC_ADMIN_GROUP` membership is
re-evaluated on every login; the founding account — the first ever created —
is never demoted by it.

### Pages the server serves

`/` `/send` `/receive` `/convert` `/history` `/waiting` `/setup` `/setup/start`
`/login` `/register` `/settings` `/admin` `/admin/extensions` `/auth/forgot`
`/auth/reset` `/auth/linked` — plus `/account`, which is a redirect into
`/settings#profile`, kept because e-mails once linked to it.

While `unclaimed`, `/`, `/send`, `/convert`, `/history`, `/login` and
`/register` all redirect to `/setup` — except for an ereader `User-Agent`,
which still gets its key page because it cannot complete a setup form.

HTML is served `Cache-Control: no-cache`; CSS and JS are cached and carry a
`?v=` marker that is a hash of the file's own bytes, stamped as the page is
served — nothing to bump by hand.

---

## Registered ereaders

All of these need a signed-in account. When mail is configured they also need
a **confirmed address** — the token they hand out lets a device pull books, so
it is never issued to an address nobody has proven they can read. `401` when
signed out, `403` when unverified. With mail off, confirmation is impossible
and is not demanded.

### `GET /api/devices`

```json
{
  "devices": [
    {
      "id": "uuid",
      "label": "Clara BW",
      "proxyStore": true,
      "createdAt": "2026-08-06T12:00:00.000Z",
      "lastSeenAt": null,
      "lastSyncFailedAt": null,
      "paired": false,
      "endpoint": "https://send.example.com/kobo/8Kx…"
    }
  ],
  "storeEndpoint": "https://storeapi.kobo.com"
}
```

`paired` is `true` once the Kobo has actually contacted the server — use it to
tell "registered" apart from "registered and working". The `endpoint` carries
the live token and is shown masked in the UI with an explicit reveal, because
anyone holding it can pull the queue.

### `POST /api/devices`

Body is optional: `{ "label": "Clara BW", "proxyStore": true }`. Defaults to
`"My Kobo"` with the store proxy on. Returns **201** with the device, `token`
and `endpoint`. The token is stored encrypted, so the endpoint can be shown
again later — treat it like a password all the same.

### `POST /api/devices/:id/token`

Rotates the token and returns a fresh `{ token, endpoint }`. The old URL stops
working immediately.

### `PATCH /api/devices/:id`

`{ "label"?: string, "proxyStore"?: boolean }`. Returns the updated device.
`400` on an empty name.

### `DELETE /api/devices/:id`

Revokes the token immediately and drops anything queued for the device.

Someone else's device id returns **404, not 403**, so the API never confirms
that an id exists on another account.

---

## Sending to a registered device

Same `POST /upload` endpoint. Send **`deviceId` instead of `key`**; everything
else (`file`, `target`, `layoutFix`, …) behaves the same. `url` is not
supported here — a Kobo library holds books, not links.

Requires a signed-in account that owns the device (verified, when mail is
configured). Unlike the key flow, the receiving device is not consenting in
the moment, so this is not open to anyone who can reach the server. `401`
signed out, `403` unverified, `404` for a device that is not yours, and **409**
for a device that has never synced — nothing could ever collect the book.

```json
{
  "ok": true,
  "deviceId": "uuid",
  "messages": ["Queued for Clara. It will appear after the next sync.", "Filename: My Book.kepub.epub"],
  "filename": "My Book.kepub.epub",
  "conversion": ["layoutfix", "kepubify"],
  "book": { "id": "uuid", "title": "My Book", "size": 481920 },
  "url": null,
  "kept": null
}
```

With `hold`, the response carries `pending` (a commit token) instead of
`book`, and nothing is queued until `POST /upload/commit`.

The book waits in an **outbox, not a library**: the device collects it on its
next sync and the file is then deleted. Anything uncollected expires after
`KOBO_QUEUE_TTL` (6 hours by default), and **a restart clears the queue** — the
UI should say so, because "sent" does not mean "delivered" until the Kobo syncs.
A kept library copy (below) is what outlives the outbox.

`title` comes from the book's own `dc:title`, read out of the EPUB after
conversion — along with `dc:creator` and `dc:language`, which become the
`Contributors` and `Language` a Kobo shows in its library. Nothing is stored;
the package document is parsed on the way past. A book that declares no title,
or is not an EPUB, falls back to the filename (`My_Book.epub` → `My Book`) with
`Contributors: ["send2ereader"]` and `Language: "en"`.

---

## Waiting, library, account

Signed-in surface behind the same verification rule as devices:

| Route | Purpose |
| --- | --- |
| `GET /api/waiting` | Books queued at your sync endpoints, with `ttlSeconds`. |
| `GET /api/waiting/count` | The number the header badge shows. |
| `GET /api/waiting/:id/download` | Pull a queued book from the browser instead of waiting for the device. |
| `DELETE /api/waiting/:id` | Un-queue it. |

The library (any signed-in account):

| Route | Purpose |
| --- | --- |
| `GET /api/library` | Retention ceiling and choice, storage used and limits. |
| `PATCH /api/library` | `{ minutes }` (integer or `null`) — the account's keep preference, capped by the server's `RETAIN_DAYS`. |
| `GET /api/library/books` | The kept books, with the account's effective `retainMinutes` and the server's `ceilingMinutes` (`RETAIN_DAYS` in minutes). |
| `GET /api/library/:id/cover` | Cover image, read out of the EPUB on demand; `404` when there is none. |
| `GET /api/library/:id/download` | The file. Does **not** consume it. |
| `DELETE /api/library/:id` | Removes the book and its file. |
| `DELETE /api/account` | Deletes the account and everything attached; requires reauthentication. |

---

## Admin

Everything under `/api/admin/*` requires a signed-in administrator. A
non-admin gets **404, not 403** — the API does not admit the surface exists.

| Route | Purpose |
| --- | --- |
| `GET /api/admin/settings` | Every setting with value, origin (`environment` / `default` / `generated`), read-only tier, plus `canRestart`, the running address, and the backup summary. Secrets come back blank with `isSet`. |
| `PUT /api/admin/settings` | `{ key, value }` — writes an override to the database. Address changes that would strand passkeys answer `409` with `needsPasskeyConfirmation` until confirmed. |
| `DELETE /api/admin/settings/:key` | Drops the override; the environment or default shows through again. |
| `GET /api/admin/users` | The people list — names in the clear, addresses masked. |
| `POST /api/admin/users/:id/admin` | Grant or revoke admin. The founder cannot be demoted. |
| `DELETE /api/admin/users/:id` | Delete an account. |
| `GET /api/admin/backup` | The `.tar.gz` (database + library), streamed. |
| `POST /api/admin/restore` | Upload an archive; it is **staged**, nothing changes yet. |
| `DELETE /api/admin/restore` | Throw the staged archive away. |
| `POST /api/admin/restore/confirm` | Mark it for restore at the next boot; in a container this restarts the server. |
| `POST /api/admin/restart` | Restart, in a container (the entrypoint supervises the process). `409` elsewhere. |

First-run setup (`/setup/start` drives these): `GET /api/setup`, `POST
/api/setup/complete`, `POST /api/setup/mail/test`, `POST /api/setup/sso/test`.

### Extensions

| Route | Purpose |
| --- | --- |
| `GET /api/admin/extensions` | `{ extensions, busy, agent }`. Each entry: installed, enabled, pending, `blocked` (a sentence when it cannot be asked for — a missing dependency, or no agent at all), current run state and stages. `agent` is whether the Docker image's installer agent is alive; without it every install and removal is refused with **409** and the same sentence. |
| `POST /api/admin/extensions/:id` | Queue an install. `409` when already installed, already queued, blocked, or agentless. |
| `DELETE /api/admin/extensions/:id` | Queue a removal. `409` while something depends on it — including a dependant that is merely queued. |
| `GET /api/admin/extensions/:id/progress?from=N` | Stages, run state, and the install log from offset `N` — the Converters page tails this. |
| `DELETE /api/admin/extensions/:id/progress` | Clear a finished run's record. |

---

## The device endpoints

Under `/kobo/:token`, authenticated solely by the opaque token in the path —
an ereader cannot perform an OIDC redirect. Unknown token gives `401`, and
revoking the device invalidates it immediately. A front end never calls these;
they exist for the Kobo.

| Route | Purpose |
| --- | --- |
| `GET /v1/initialization` | Resource map. Built by overriding only what this server serves on top of Kobo's own, so unimplemented features keep working. The device's own request is forwarded to the store so its credentials fetch the real map; if that fails, a native list of Kobo's stock resources stands in |
| `POST /v1/auth/device` | Device check-in; flips `paired` in the device list |
| `GET /v1/library/sync` | Queued books as `NewEntitlement`, plus any kept copy this device has not removed, `[]` when there is neither |
| `GET /v1/library/:uuid/metadata` | Per-book metadata, from the queue or the kept copy |
| `GET`/`PUT /v1/library/:uuid/state` | Reading state, for queued and kept copies alike — accepted and discarded |
| `DELETE /v1/library/:uuid` | The device removing a book; answers `204`. Drops it from the queue and stops the kept copy being offered again |
| `GET /download/:uuid` | The file. The queued copy is deleted once the bytes are out; a kept copy is left alone |
| `GET /v1/books/:imageId/thumbnail/:w/:h/[:quality/]:greyscale/image.jpg` | Cover images — see below |

### Cover images

A book delivered by sync arrives as an *entitlement*, and the device treats an
entitlement as store content: it never opens the file looking for a cover, it
fetches one by URL. So this endpoint is how the cover already inside the book
reaches the screen. (Sideloading over USB is the case where the device does read
the file itself — that is a different path and does not come here.)

`/v1/initialization` therefore points the device's whole `image_host` at this
server, and **every** cover it wants arrives here, not just ours.

- An `imageId` matching a queued book returns that book's cover, read out of the
  EPUB on demand. Nothing is extracted to disk and the queue stays an outbox.
  A non-EPUB, or an EPUB with no cover, is `404` and the device draws its own
  placeholder.
- **Anything else is `302`'d to Kobo's own image host.** Without that,
  registering a device would blank the covers of every book bought from Kobo.
  The template Kobo advertises is preferred, cached per device by
  `/v1/initialization`. A cover asked for before the device has initialized
  falls back to `KOBO_IMAGE_BASE_URL` rather than making a store call of its
  own.
- A device with `proxyStore` off gets `404` and nothing is sent to Kobo, same as
  every other path.

The URL shape matches what other Kobo sync servers use, so a configuration can
be compared against theirs. Note Kobo's own asymmetry, reproduced here: the
plain template hardcodes `false` in the greyscale slot and only the *quality*
template takes `{IsGreyscale}`. Width and height are ignored — there is no image
library in the container, and the device scales anyway.

A failed transfer leaves the book queued so the device can retry; deletion only
happens after the stream completes.

### The kept copy as a second source

The queue is an outbox and empties itself. When the library is on, the copy kept
for the sending user is written under the **same id** as the queued book and
records which device it went to, so once the queue lets go the device can still
reach it: sync keeps offering it, and `download` serves it without consuming it.
That is what lets a reader delete the file to reclaim space and pull it back
later.

Three things bound it. The copy is only ever served to the device it was sent to
and only to its owner; it stops being offered the moment the device sends
`DELETE /v1/library/:uuid`, which is a reader removing the book rather than the
device tidying up; and it disappears with the retention TTL like any other kept
book. With the library off nothing is kept, and the queue behaves exactly as it
did before.

### The store proxy

Everything else under `/kobo/:token/*` is forwarded to the real Kobo store.

**It catches less than you might expect.** A device's `Kobo eReader.conf` gives
most store features their own absolute URL — `store_search`, `book_detail_page`,
`product_reviews`, `autocomplete`, `oauth_host`, `reading_services_host` and
around forty more all name `storeapi.kobo.com` or `www.kobo.com` outright — so
overriding `api_endpoint` never touches them. The device keeps talking to Kobo
directly for all of it.

What the proxy actually carries is the calls the device builds *from*
`api_endpoint`. This server advertises only what it serves, so `user_profile`,
`user_wishlist` and the rest keep Kobo's own absolute URLs and never reach the
wildcard at all. The device presents its real Kobo credentials on everything
that does come through, which is why those calls answer `200` rather than
`401`.

- Honours the device's `proxyStore` flag. Switched off, the request gets `404`
  and **nothing is sent to Kobo at all** — books still deliver normally.
- `502` if the store is unreachable, rather than hanging the device.
- Implemented routes always win; the proxy is a wildcard registered last.
- This path carries the user's real Kobo credentials, so nothing on it logs
  headers or bodies. Keep it that way.

### Pointing a real device here

1. **Back up `.kobo/Kobo/Kobo eReader.conf`.** Restoring it is the escape
   hatch if anything goes wrong.
2. Set `api_endpoint` to the `endpoint` from `POST /api/devices`.
3. Send a book, sync, and confirm it lands in the device's library.
4. Confirm the store still browses, then that turning `proxyStore` off leaves
   delivery working.
