# send2ereader

A self-hostable service for sending ebooks to a Kobo, Kindle or Tolino ereader through the
device's built-in browser.

Open the site on your ereader and it shows a short pairing key. Enter that key on your phone or
PC, upload an ebook, and a download link appears on the ereader — converted to the right format
for that device.

## Format support

| Device | Input | Sent as | Converter |
| --- | --- | --- | --- |
| Kobo | EPUB | `.kepub.epub` | kepubify |
| Kobo | KEPUB, PDF, CBZ, CBR, MOBI, TXT, HTML | unchanged | — |
| Kindle | EPUB, CBZ, CBR, TXT, HTML | `.azw3` (default) | calibre `ebook-convert` |
| Kindle | EPUB | `.mobi` (opt-in, pre-2015 devices) | calibre `ebook-convert` |
| Kindle | MOBI, AZW3, KFX, PDF | unchanged | — |
| Any | PDF | cropped PDF (opt-in) | pdfCropMargins |
| Tolino / other | anything supported | unchanged | — |

Files sent to a Kindle have their names stripped of special characters — a limitation of the
Kindle browser. Uploads are validated by magic bytes, not just by extension.

Converters are probed at startup; if one is missing, its option is disabled in the UI and the
file is sent unconverted rather than failing.

### EPUB layout fix

Adobe's RMSDK renderer — the engine in Kobo, Tolino and PocketBook readers — clips full-page
images at the edges, pushes tall ones off the bottom, and stretches covers that calibre wrote
with `preserveAspectRatio="none"`. Every EPUB this service delivers is repaired for those defects
by default, using the engine from
[calibre-epub-layout-fix](https://github.com/devnullv0id/calibre-epub-layout-fix).

That project ships as a calibre GUI plugin, but its engine (`fixer.py`) is deliberately free of
calibre and Qt imports, so the Docker build extracts that one module and runs it under plain
`python3` — no plugin registration, no GUI, no calibre startup cost. The build tracks the
**latest release**; pass `--build-arg EPUB_LAYOUT_FIX_REF=v0.1.0` to pin a tag instead.

It applies to **every input format** whose result is an EPUB, and runs *before* kepubify so the
Kobo package wraps the repaired book:

```text
.kfx → calibre → .epub → layout fix → kepubify → .kepub.epub
```

It is skipped for Kindle output, because AZW3/MOBI are not EPUB and KF8 does not share the
defect. The option is a checkbox in the form (default on, `LAYOUT_FIX_DEFAULT=false` to flip the
server default), and the step is **optional**: if the engine fails, the failure is logged and the
unrepaired book is still delivered rather than failing the upload.

### Choosing a target

The upload form has a single **Convert for** switch — `Auto`, `Kobo`, `Kindle`, `Don't convert` —
and exactly one is ever active. Kobo and Kindle are mutually exclusive by construction: a
`.kepub.epub` carries Kobo-specific markup that a Kindle cannot read, and an AZW3 is meaningless
to a Kobo, so there is never a reason to produce both.

`Auto` is the default and uses whichever device generated the key. Type a key and the form asks
the server (`GET /key/:key`) what it is paired with, then says so — "Auto: paired with a Kobo".
The other three are manual overrides for when user-agent detection gets it wrong, or when you
want the file left alone.

Tolino is *not* folded into Kobo. Both read EPUB directly, but only Kobo understands KEPUB, so
a Tolino resolves to no conversion.

### KFX

`.kfx` and `.kfx-zip` uploads are always accepted, and a `.kfx` is sent to a Kindle as-is —
that is already the device's native format, so no conversion is involved.

Reading KFX (converting it into something a Kobo or Tolino can open, or unwrapping the
`.kfx-zip` container that no device can open directly) needs calibre's third-party **KFX Input**
plugin. It is a MobileRead forum download with no stable public URL, so it is not bundled.
Supply it at build time:

```sh
docker build --build-arg KFX_INPUT_PLUGIN_URL=https://…/KFX_Input.zip -t send2ereader .
```

With the plugin present, `.kfx`/`.kfx-zip` convert to AZW3/MOBI for a Kindle and to EPUB for
everything else. Without it, both are passed through untouched. The server detects this at
startup (`calibre-customize --list-plugins`) and `/healthz` reports it as `tools.kfxInput`.

**KFX output is not in the image**, and the Convert page says so rather than offering it. Writing
KFX means calibre's KFX Output plugin driving Amazon's Kindle Previewer — a Windows program, and
not ours to redistribute. AZW3 is the best format this image can produce for a Kindle, and every
Kindle since 2011 reads it.

An operator who wants KFX anyway can add it at container start with the `kfx` extension, which
installs Wine, fetches the Previewer from Amazon **on your machine, at your instruction**, and
installs the plugin. The server then offers KFX for real, because it asks calibre what plugins it
has (`tools.kfxOutput` on `/healthz`) rather than being told. See
[Extensions](#extensions).

## How to run

### Docker Compose (recommended)

```yaml
services:
  send2ereader:
    image: ghcr.io/devnullv0id/send2ereader:latest
    container_name: send2ereader
    restart: unless-stopped
    ports:
      - 3001:3001
    volumes:
      - uploads:/data/uploads

volumes:
  uploads:
```

```sh
docker compose up -d
```

Images are published for `linux/amd64` and `linux/arm64`, and the service listens on port 3001.

| Tag | What it is |
| --- | --- |
| `latest` | The current build from `master`. |
| `legacy` | The last build of the original Express app, kept pinned. Pull this if you want the app as it was before the rewrite; it will not receive updates. |

The image is around 1.7 GB, almost all of it calibre — the price of proper Kindle conversion.
The Qt WebEngine and Mesa stack calibre would otherwise drag in is pruned during the build,
since `ebook-convert` never uses it for the formats this service produces.

### Build the image yourself

```sh
git clone https://github.com/devnullv0id/send2ereader.git
cd send2ereader
docker compose build     # uncomment the `build:` block in docker-compose.yaml first
docker compose up -d
```

### On your host OS

1. Install Node.js 22 or newer.
2. Install the converters and make sure they are on `PATH`:
   - [kepubify](https://github.com/pgaskin/kepubify) — Kobo EPUB conversion
   - [calibre](https://calibre-ebook.com/) — provides `ebook-convert` for Kindle formats
   - [pdfCropMargins](https://github.com/abarker/pdfCropMargins) — optional PDF margin cropping
3. Install dependencies, build and start:

```sh
npm ci
npm run build
npm start
```

Then open <http://localhost:3001>.

## Accounts (optional)

**Sending a book never needs an account.** The key flow above works for anyone who can reach the
server, and that does not change. Accounts exist only to manage registered ereaders.

They are on with no configuration at all. The secret that signs a session is generated on first
boot and written next to the database as `session.key`, mode `0600`; keep that file, because losing
it signs everyone out and makes stored Kobo tokens and two-factor secrets unreadable. Set it
yourself if you would rather — which is the right answer when several instances share a database:

```sh
cp .env.example .env
openssl rand -base64 32          # put the result in SESSION_SECRET
```

To run the bare key-transfer app instead, with no sign-in, no library and no admin page, set
`ACCOUNTS=false`. It is set in the environment and nowhere else, because turning accounts off also
removes the page you would turn them back on from.

The **first account to register claims the server** and becomes its owner. After that
local registration is closed unless you set `ALLOW_SIGNUP=true`; SSO, once configured, is the
intended route for anyone else.

Use a real address — it is the only way back in if you forget the password. Unless `SMTP_ENABLED`
is on, the confirmation and reset links are **written to the server log** instead of being
e-mailed, so a self-hoster without a mail server can still complete the flow:

```sh
docker logs send2ereader | grep /auth/verify
```

You can sign in without confirming, but registering an ereader requires a confirmed address.

Passwords are hashed with scrypt (`node:crypto`, N=2¹⁶, ~130 ms per hash) and the login, register
and reset endpoints are rate limited, because that cost is per attempt.

## Configuration

Settings come from environment variables. For anything other than a throwaway run, put them in a
`.env` file next to `docker-compose.yaml`:

```sh
cp .env.example .env
```

[.env.example](.env.example) documents every variable with its default — a test fails if a new one
is added to the code without appearing there. The file is read by the app itself (via Node's
built-in `process.loadEnvFile`, no dependency) and by Docker Compose, and it is gitignored and
excluded from the image so secrets are not committed or baked in.

**Real environment variables always win over `.env`**, so compose `environment:` entries and
`docker run -e` override the file rather than being silently ignored. Point `ENV_FILE` somewhere
else to load a different file.

Everything is optional; defaults are shown.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen address |
| `HTTP_PORT` | `3001` | Port the server listens on |
| `HTTP_ADDR` | `0.0.0.0` | Address the server listens on |
| `LOG_LEVEL` | `info` | pino log level |
| `TRUST_PROXY` | `false` | Honour `X-Forwarded-*` behind a reverse proxy |
| `UPLOAD_DIR` | `./uploads` | Where uploads are stored while a key is alive |
| `CLEAN_UPLOAD_DIR_ON_BOOT` | `true` | Wipe leftovers at startup |
| `EXPIRE_SECONDS` | `30` | Idle TTL — a key dies this long after the ereader stops polling |
| `MAX_EXPIRE_SECONDS` | `600` | Hard TTL — never extended, however active the key is |
| `MAX_FILE_SIZE` | `838860800` | Upload limit in bytes (800 MB) |
| `KEY_LENGTH` | `4` | Pairing key length |
| `CONVERSION_TIMEOUT_MS` | `600000` | Wall-clock cap for one conversion |
| `CALIBRE_OUTPUT_PROFILE` | `kindle_pw3` | calibre `--output-profile` for Kindle targets; set empty to omit |
| `LAYOUT_FIX_DEFAULT` | `true` | Default state of the "Fix EPUB layout" checkbox |
| `ACCOUNTS` | `true` | Accounts, sign-in and the admin page. Off is the bare key flow |
| `SESSION_SECRET` | *(generated)* | Signs sessions and encrypts stored tokens. Unset generates one beside the database |
| `PROTOCOL` | `http` | Scheme people reach the server on — `https` behind a proxy |
| `DOMAIN` | *(unset)* | Host people reach the server on. Builds every link the server hands out; falls back to `HTTP_ADDR:HTTP_PORT` |
| `ALLOW_SIGNUP` | `false` | Allow local registration beyond the owner |
| `DB_PATH` | `/data/db/send2ereader.db` | Accounts database; created on first boot |
| `SMTP_ENABLED` | `false` | Send mail. While off, links go to the server log |
| `SMTP_HOST` / `SMTP_PORT` | *(unset)* / `587` | 465 uses implicit TLS, 587 and 25 use STARTTLS |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | *(unset)* | Omit both for an unauthenticated relay |
| `SMTP_FROM_EMAIL` / `SMTP_FROM_NAME` | *(unset)* / `send2ereader` | Sender. Defaults to `SMTP_USERNAME` when that is an address; set it only when the two differ |
| `SMTP_TLS` | `true` | Turn off only for a relay on localhost |
| `SMTP_TIMEOUT_SECONDS` | `30` | Connection, greeting and socket timeout |
| `OIDC_ENABLED` | `false` | Offer single sign-on alongside local accounts |
| `OIDC_CONFIG_URL` | *(unset)* | Discovery document or issuer URL |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | *(unset)* | Omit the secret for a public client |
| `OIDC_ADMIN_GROUP` | *(unset)* | Group that grants administrator rights |
| `KEPUBIFY_BIN` / `EBOOK_CONVERT_BIN` / `PDFCROPMARGINS_BIN` / `CALIBRE_CUSTOMIZE_BIN` / `EPUB_LAYOUT_FIX_BIN` | binary name | Override converter paths |
| `EXTENSIONS` / `EXTENSION_PACKAGES` | *(unset)* | Installed at container start; pipe separated. See below |

### Extensions

Some things are deliberately not in the image. Amazon's Kindle Previewer — the
only thing that writes KFX — is not ours to redistribute, and Wine is several
hundred megabytes that nobody who only wants EPUB should pull. So the image says
no to KFX, and an operator who wants it says otherwise:

```yaml
environment:
  EXTENSIONS: ghcr.io/devnullv0id/s2e-mod-kfx:latest
  EXTENSION_PACKAGES: fonts-noto-cjk|poppler-utils
```

At start, the entrypoint installs those packages, unpacks each extension image
over the filesystem, runs whatever script it left behind, and only then drops to
the `node` user and starts the server. An extension that fails is logged and
skipped rather than stopping the container. Both are read before the server
exists, so they are set in the environment and shown read-only on the admin
page. [docker/extensions](docker/extensions) has the details and the one in this
repo.

## HTTP API

A summary. [API.md](API.md) has the full reference — request and response shapes, status
codes, and the rules each endpoint enforces.

| Route | Purpose |
| --- | --- |
| `GET /` | Upload form, or the receive page when the user-agent is an ereader |
| `GET /send`, `GET /receive` | Force either page |
| `POST /generate` | Issue a pairing key (plain text). Rate limited. |
| `GET /key/:key` | Which device a key is paired with, so the form can preselect a target |
| `GET /convert` | Convert a book without sending it anywhere |
| `POST /convert` | multipart: `file`, `format`, and the fixes. Returns a one-shot download link. |
| `GET /convert/:id/:filename` | Collect the result. Serving it deletes it. |
| `GET /api/convert/targets?from=` | Which formats are reachable from a source, and why the rest are not |
| `GET /login`, `/register`, `/settings` | Account pages. Only exist when accounts are enabled |
| `POST /auth/register`, `/auth/login`, `/auth/logout` | Local accounts |
| `POST /auth/password` | Change a password from Settings, with the current one |
| `GET /auth/verify?token=`, `POST /auth/reset` | E-mail confirmation and password reset |
| `POST /api/devices/:id/token` | Rotate a device's sync token. The device and its queue survive. |
| `DELETE /api/waiting/:id` | Cancel a queued book, deleting the file now |
| `GET /api/waiting/:id/download` | Collect a queued book in the browser. It stays queued. |
| `GET /auth/status` | Whether accounts are on, claimed, and who is signed in |
| `GET /status/:key` | Poll for the attached file and urls. Requires the issuing user-agent. |
| `POST /upload` | multipart: `key`, `file`, `url`, and the conversion checkboxes. Returns JSON. |
| `GET /download/:filename?key=` | Download. Requires the issuing user-agent. Supports ranges. |
| `DELETE /file/:key` | Detach and delete the stored file |
| `GET /healthz` | Liveness, key count, converter availability |

## Backups

The admin page has a **Backup** panel. It hands you one `.tar.gz` holding the
database — taken with SQLite's own `VACUUM INTO`, so a running server cannot be
caught half-written — and every book kept in the library. The archive is shaped
like the data directory:

```text
db/send2ereader.db
library/<account>/<book>
```

Putting one back is deliberately not a button: unpacking over a running server
would race whatever it is doing. Stop it, unpack, start it.

```sh
docker compose down
tar -xzf send2ereader-2026-08-12-09-30-00.tar.gz -C /your/data
docker compose up -d
```

Two things are **not** in it, because neither belongs to the server: your `.env`,
and the generated `session.key` beside the database. Losing that key signs
everyone out and makes stored Kobo tokens and two-factor secrets unreadable —
everything else comes back regardless.

## Privacy

Uploads live only as long as the pairing key: they are deleted when the key expires (about 30
seconds after the ereader stops polling), when a new file replaces them, when the file is
deleted from the ereader page, and on server shutdown. Nothing is persisted between restarts.

Keys are generated with a CSPRNG, and both `/status` and `/download` require the same
user-agent that created the key.

## Development

Two loops, and the difference matters because Docker is what actually ships.

**Fast loop — iterate on code.** Reloads on save, but uses whatever converters are installed on
*your* machine, so behaviour can differ from production:

```sh
npm ci
npm run dev          # tsx watch on http://localhost:3001
npm test             # vitest
npm run lint         # biome
npm run typecheck    # tsc --noEmit
npm run scan:secrets # refuse credentials in the history
```

`npm ci` also points git at `.githooks`, which refuses to commit anything shaped like a credential
and refuses to push a range containing one — because a file deleted in a later commit is still in
the history you push, and `.gitignore` never applies to a path that is already tracked. CI runs the
same scan over the whole history, where `--no-verify` cannot reach it.

**Real loop — verify the artifact.** Same Dockerfile, same converters, same non-root user as the
published image. Run this before trusting a change:

```sh
docker compose -f docker-compose.dev.yaml up --build
```

`static/` is bind-mounted read-only in the dev compose file, so page edits show up on reload
without a rebuild; server changes need `--build`. `/healthz` reports which converters the
container actually found — worth checking, since a converter missing on your host but present in
the image (or the reverse) is the usual reason the two loops disagree.

The server is Fastify 5 on TypeScript in `src/`. The pages in `static/` split into two worlds with
deliberately different constraints, and code must not cross between them:

- `download.html` + `style.css` + `common.js` run **on the ereader**, in WebKit builds from the
  early 2010s. No CSS custom properties, flexbox, grid or `rem`; no `const`/arrow
  functions/`fetch`/Promise. Pure black-on-white with 3px borders, because e-ink dithers greys and
  shadows into noise, and it stays readable down to 380px wide. `test/static.test.ts` enforces all
  of that, including that the design system never reaches this page.
- Everything else runs on a **phone or desktop** and is a hand port of the design in `UI/`, which
  is a git-ignored handoff rather than source. Two rules hold there: **no `style=` attribute in any
  page**, and **no HTML built from strings** — repeated rows clone a `<template>`. The only value a
  script may write into a style is a bare number on a custom property, `--prog`. `test/page.test.ts`
  enforces each of those, and also that every class in the markup resolves to a rule.

Where the prototype's markup and its companion `styles.css` disagree, the markup wins; each
correction carries a comment saying so. Controls the design draws that this server has no endpoint
for stay on the page, disabled, marked `data-unbacked` with the reason — and a test names every one,
so "temporarily inert" cannot quietly become permanent.

Mail is the one exception to the no-inline-style rule, because mail clients give no choice:
`src/mail/template.ts` is table layout with every rule on the element and the palette resolved to
literal hex.

## Credits

Maintained by [devnullv0id](https://github.com/devnullv0id). Inspired by
[send2ereader by djazz](https://github.com/daniel-j/send2ereader), which this started as before
being rewritten.

## License

MIT — see [LICENSE](LICENSE).
