# send2ereader

Send ebooks to a Kobo, Kindle or Tolino through the device's own browser, converted to whatever
that device reads.

Open the site on the ereader and it shows a four-character key. Type that key on your phone or
computer, pick a book, send. A download link appears on the ereader.

## How to run

One command, to try it:

```sh
docker run -d --name send2ereader --restart unless-stopped -p 3001:3001 -v s2e:/data \
  ghcr.io/devnullv0id/send2ereader:latest
# or: code.private-home-network.de/devnullv0id/send2ereader:latest
```

Or compose, to keep it. `docker-compose.yaml` in this repo is ready to run;
[`compose.yaml.example`](compose.yaml.example) is the same thing with every setting there is,
commented, if you want to change something:

```sh
docker compose up -d
```

Then open <http://localhost:3001>. Everything lives under `/data` — database, library, queued
books — so that one volume is the whole of your state.

Images are built for `linux/amd64` and `linux/arm64`. About 105 MB to pull, 470 MB unpacked. The
same digests are published to both `ghcr.io` and `code.private-home-network.de`; take whichever
you can reach.

| Tag | What it is |
| --- | --- |
| `latest` | Current release |
| `2.0.0`, `2.0` | Pin to a version or a minor series |
| `legacy`, `1.1.0` | The original app, before the rewrite. Not updated. |

### Without Docker

Needs Node 22+ and, for anything past EPUB, [kepubify](https://github.com/pgaskin/kepubify) and
[calibre](https://calibre-ebook.com/) on `PATH`.

```sh
npm ci && npm run build && npm start
```

## What it does

**Sends a book to a device with no app and no account.** The file is held only as long as the key
is, so a device that drops the connection mid-download can ask again.

**Converts on the way.** Uploads are identified by magic bytes, not by extension.

| From | To | Via |
| --- | --- | --- |
| EPUB | `.kepub.epub` for Kobo | kepubify |
| EPUB, KEPUB, CBZ, CBR, TXT, HTML, HTMLZ, KFX | AZW3 or MOBI for Kindle | calibre |
| anything | EPUB, PDF, TXT, HTMLZ | calibre |
| KFX, KFX-ZIP | readable formats | calibre + KFX Input |
| anything | KFX | calibre + Kindle Previewer |

A Kobo and a Kindle are never both targets: KEPUB carries Kobo markup a Kindle cannot read, and
AZW3 means nothing to a Kobo. Tolino reads EPUB but not KEPUB, so it gets the file unconverted.
Comics are the one exception to "anything": CBZ and CBR convert to EPUB, AZW3, MOBI, KFX or PDF,
and nothing else — a comic squeezed into TXT would be a list of nothing.

Three optional fixes ride along: **repair EPUB layout** (on by default), **crop PDF margins**,
and **transliterate the filename** for the Kindle browser, which chokes on non-ASCII names.

The layout fix repairs what Adobe's RMSDK renderer — in Kobo, Tolino and PocketBook — does to
full-page images and stretched covers. It runs before kepubify, is skipped for Kindle output, and
if it fails the unrepaired book is still delivered. Engine from
[calibre-epub-layout-fix](https://github.com/devnullv0id/calibre-epub-layout-fix).

**Converts without sending**, at `/convert`, if you only want the file.

**Delivers to a Kobo over its own sync.** Generate a sync endpoint in Settings, put the URL in
`.kobo/Kobo/Kobo eReader.conf` over USB, and books you queue appear in the device's library on its
next sync. Everything the device asks for beyond your books is proxied to the real Kobo store.
Queued books are deleted once collected, after six hours, or when the server restarts — a kept
library copy is what survives, if the account keeps one.

**Keeps a library** for signed-in accounts, with per-user and total storage caps and optional
retention. Anything else is transient.

## Extensions

A fresh image does EPUB and KEPUB. The rest is fetched when you ask for it, which is the
difference between a 105 MB pull and a 500 MB one.

| id | Adds | Needs | Cost |
| --- | --- | --- | --- |
| `calibre` | MOBI, AZW3, PDF, TXT, HTMLZ, reading KFX | — | ~600 MB |
| `pdfcrop` | Cropping PDF margins | — | ~90 MB |
| `kfx` | Writing KFX | `calibre` | ~2.6 GB, Wine and Amazon's Kindle Previewer |

Install them at **Admin → Converters** while the server runs, or name them in the environment:

```yaml
environment:
  EXTENSIONS: calibre|pdfcrop|kfx
```

Either way a background agent does the fetching while the server is already answering — the site
never waits on a download, and the Converters page (and a badge in the header) show every stage
as it happens. They land on the data volume and survive a container being recreated. A missing
converter is never hidden — the format is greyed with the reason — and outside the Docker image,
where no agent exists, the install switches say so instead of pretending.

KFX is the one that cannot be shipped: Amazon's Previewer is a Windows program and not ours to
redistribute, so the extension fetches it on your machine, at your instruction.

## Languages

The pages, e-mails and error messages speak English out of the box, and German ships alongside
(machine-drafted, marked for native review). Everyone picks their own language in the footer of
any page — signed in, the choice follows the account; signed out, it lives in a browser cookie —
and the administrator sets the default for first-time visitors at **Admin → Language** (or
`LANGUAGE=de` in the environment). E-ink pages, which carry no cookie, follow that default.

Adding a language is dropping a file, no build step:

1. Copy [`languages/de.json`](languages/de.json) to `<code>.json` — `fr.json`, `nl.json` — and
   translate the values. The keys are the English sentences themselves; a key you leave out simply
   stays English, so a half-finished file is safe to ship.
2. Put it in the `languages` folder of a checkout, or on the data volume under `/data/languages`
   for a Docker install (`docker cp fr.json send2ereader:/data/languages/`).
3. Restart. The language appears in every picker and in the admin default choices.

A file on the data volume with the same code as a shipped one replaces it whole, so corrections
to the shipped German go in `/data/languages/de.json` and survive image updates.
[`languages/README.md`](languages/README.md) is the translator's guide.

## Accounts

Optional. Sending a book never needs one. Set `ACCOUNTS=false` for the bare key flow with no
sign-in, library or admin page.

The **first account to register claims the server**. After that local registration is closed
unless `ALLOW_SIGNUP=true`. Sign in with a password, a passkey, or single sign-on; two-factor and
a printable recovery phrase are available.

Without `SMTP_ENABLED`, confirmation and reset links are written to the log instead of e-mailed —
with their tokens redacted, because a link in a log is a live credential. Set
`MAIL_LOG_SECRETS=true` (Admin → Mail) while you need a usable link:

```sh
docker logs send2ereader | grep /auth/verify
```

The session secret is generated on first boot next to the database as `session.key`, mode `0600`.
Keep it: losing it signs everyone out and makes stored Kobo tokens and 2FA secrets unreadable.

## Configuration

Either put them in the compose file — [`compose.yaml.example`](compose.yaml.example) lists all 85
with their defaults — or keep them in a file next to it:

```sh
cp .env.example .env
```

Both list the same settings, and a test fails if the code gains one that is missing. Real
environment variables win over the file.

Most are better changed at **Admin → Settings**, which writes to the database and beats the file.
Some stay environment-only and show read-only there: the ones read before the server exists
(`ACCOUNTS`, `HTTP_PORT`, `HTTP_ADDR`, `DATA_DIR`, `DB_PATH`, `SESSION_SECRET`, `EXTENSIONS`,
`EXTENSION_PACKAGES`), the paths, logging and rate limits, the security knobs (`SCRYPT_N`,
`CLEAN_UPLOAD_DIR_ON_BOOT`), and the converter binaries — a browser form is the wrong place to
choose what a server executes. `LOCKED_SETTINGS` pins anything else you want left alone.

The ones worth knowing:

| Variable | Default | Why |
| --- | --- | --- |
| `DOMAIN` / `PROTOCOL` | unset / `http` | The address the server hands out in links. Passkeys need a real https domain |
| `TRUST_PROXY` | `false` | Behind a reverse proxy, name it — an address, a CIDR or `loopback`. Left off, everyone shares one rate limit; set to `true`, anyone who reaches the port can forge their address, which is why the admin page refuses to save that word |
| `MAX_FILE_SIZE` | 800 MB | Upload ceiling |
| `EXPIRE_SECONDS` | `300` | How long a key outlives the ereader that stopped polling |
| `SESSION_SECRET` | generated | Set it when several instances share a database |

## Backups

**Admin → Backup** hands you one `.tar.gz`, named with date and time: the database, taken with
SQLite's `VACUUM INTO` so a running server cannot be caught half-written, plus every book in the
library.

Restoring happens from the same page: upload the archive, confirm, and it is unpacked at the next
boot, before anything opens the database — nothing is touched while the server runs. In a
container the page restarts the server for you (the entrypoint supervises the process, so no
`--restart` policy is needed for that); elsewhere you restart it yourself. The manual way still
works too:

```sh
docker compose down
tar -xzf send2ereader-2026-08-12-14-31-07.tar.gz -C /your/data
docker compose up -d
```

Your `.env` and `session.key` are not in the archive; neither belongs to the server.

## Privacy

Uploads live as long as their key: deleted when it expires, when a new file replaces them, when
deleted from the ereader page, and on shutdown. Keys come from a CSPRNG, and both polling and
download require the same user-agent that asked for the key.

## Development

```sh
npm ci               # also points git at .githooks
npm run dev          # tsx watch on :3001
npm test             # vitest
npm run lint         # biome
npm run format       # biome, writing its fixes
npm run typecheck
npm run scan:secrets # the credential scan CI runs, over the whole history
```

On Windows, `scripts/dev.ps1` resolves the converter binaries and runs the same dev loop
(`-Setup` fetches kepubify the first time). `scripts/smoke-convert.mjs <url>` proves every
offered format really converts against a running instance, and `scripts/compare-instances.mjs`
diffs the page inventory of two instances.

`npm ci` installs hooks that refuse to commit or push anything shaped like a credential; CI runs
the same scan over the whole history.

The fast loop uses whatever converters your machine has, which is not what ships. Before trusting
a change, run the real thing:

```sh
docker build -t send2ereader:dev . && docker run --rm -p 3001:3001 -v s2e-dev:/data send2ereader:dev
```

[`compose.yaml.example`](compose.yaml.example) carries the same thing as a commented `build:`
block, with the build arguments below, if you would rather keep it in compose.

The layout-fix engine is baked in at build time from a release of
[calibre-epub-layout-fix](https://github.com/devnullv0id/calibre-epub-layout-fix). Unset means
GitHub; build with `EPUB_LAYOUT_FIX_FORGE=forgejo` to take it from the Forgejo mirror instead,
and `EPUB_LAYOUT_FIX_HOST` to say from which host.

Fastify 5 and TypeScript in `src/`. The pages in `static/` are two separate worlds and code must
not cross between them:

- `download.html`, `style.css`, `common.js` and `receive.js` run **on the ereader**, in WebKit
  builds from the early 2010s: no custom properties, flexbox, grid, `const`, arrow functions or
  `fetch`. Black on white, because e-ink turns greys into noise.
- Everything else is a phone or desktop browser. No `style=` attributes, no HTML built from
  strings — repeated rows clone a `<template>`.

Tests enforce both, including that no page carries anything the content security policy would
refuse to run.

[API.md](API.md) documents every endpoint.

## Credits

Maintained by [devnullv0id](https://github.com/devnullv0id). Started as
[send2ereader by djazz](https://github.com/daniel-j/send2ereader) before being rewritten.

## License

MIT — see [LICENSE](LICENSE).
