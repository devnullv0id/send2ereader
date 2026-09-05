# Code review — send2ereader (second pass)

Audit of `master` at commit `9fb9819`, which is the first audit's fixes plus the responsive work.
The first pass is summarised at the bottom; this document is the current state.

Two things make this pass different. Most of the code under review is code I wrote, so the first
question was what my own changes broke — and the answer is **two Critical regressions, neither of
which the 1101-test suite noticed**. And you asked for dead and unused code specifically, which
turned up a fourteen-year-old habit the tests actively encourage.

## What the tooling reports

| Command | Result |
|---|---|
| `npm run lint` | passes — 93 files, no diagnostics |
| `npm run typecheck` | passes |
| `npm run build` | passes, exit 0 |
| `npm test` | passes — 36 files, **1101 tests**, 49.5s |

All four green, and green is not worth much here: the suite passes with the e-reader page
completely non-functional and with a boot failure on every existing install.

---

## [CRITICAL] The Content-Security-Policy kills the e-reader page

- **Location:** `src/app.ts:96-120` (the helmet registration), `static/download.html:45-211`
- **Category:** bug — regression, introduced by me in `b758098`
- **What:** `download.html` carries a **166-line inline `<script>`** that is the entire receive
  flow: it generates the key, polls `/status/:key`, and wires the download link. The CSP I added
  sets `script-src 'self'` with no `unsafe-inline`, so the browser refuses to run it.
- **Why it matters:** This is the product. A Kobo or Kindle opening the site gets a page that
  renders and then does nothing at all — no key, no polling, no download. Every send to an e-reader
  fails. It is served at both `/receive` and `/` for an e-reader user-agent, so there is no route
  around it.
- **Trigger:** Open `/receive` in any browser.
- **Reproduced:** Console:
  `Executing inline script violates the following Content Security Policy directive 'script-src
  'self''. The action has been blocked.` The key box holds its `––––` placeholder, and the globals
  the script defines (`keyOutput`, `keyGenBtn`) are `undefined`. The stylesheet loads fine — CSS
  was never the problem, and the page has no inline `style` attributes.
- **Fix:** Move the inline block into a `receive.js` beside `common.js` and load it with
  `<script src>`. It has to keep the same discipline as the rest of that bundle — no `const`,
  `let`, `=>`, `fetch` or `Promise` — and `test/static.test.ts` should be extended to cover the new
  file the way it already covers `common.js`. A CSP hash would also work but goes stale on every
  edit; a nonce needs per-request templating that this static page does not have.
- **How I caused it:** I checked whether any page had inline scripts, hit a ripgrep error on my
  first pattern, re-ran a simpler one, read `send.html`, and concluded "no page has an inline
  script". The grep output in front of me listed `download.html: 2` and I did not follow it up.
  Then I verified the CSP in the browser on send, convert, history, settings and admin — and never
  loaded the e-reader page, because I had filed it under "out of scope" for the responsive work
  without noticing that a CSP is not scoped to the pages you are thinking about.
- **Confidence:** high — reproduced.

## [CRITICAL] Every existing install fails to boot after upgrading

- **Location:** `src/files.ts:199-232`, `src/kobo/queue.ts:58-69`, `src/library.ts:32-36`
- **Category:** bug — regression, introduced by me in `f061139`
- **What:** To stop a mistyped `UPLOAD_DIR` erasing a directory, `claimDirectory` only accepts a
  directory that is empty or already carries a `.send2ereader` marker. On an install that predates
  the marker, `UPLOAD_DIR` holds real files and no marker, so `prepareUploadDir` throws
  `UnclaimedDirectoryError` — from `main()`, before `listen`.
- **Why it matters:** The container will not start. Under `restart: unless-stopped` it crash-loops.
  This hits *every* upgrading installation, and the more data someone has the more certain it is.
- **Trigger:** Boot the new code with pre-existing files in `UPLOAD_DIR`, `KOBO_QUEUE_DIR` or
  `LIBRARY_DIR`.
- **Reproduced:**
  `UnclaimedDirectoryError: UPLOAD_DIR points at …/uploads, which already holds files this server
  did not put there.` — thrown at `prepareUploadDir (src/files.ts:214)` via `main (src/server.ts:9)`.
- **Fix:** The danger being guarded against is *deleting someone else's files*, so the mitigation
  should be *not deleting*, not *not starting*. `Library.sweepOrphans` already does exactly that —
  it logs an error and returns 0. The upload and queue paths should match it:
  ```ts
  if (!(await claimDirectory(config.uploadDir))) {
    log.error({ dir: config.uploadDir }, 'not marked as ours, so nothing was cleaned')
    return
  }
  ```
  Better still, claim a directory whose contents all match the shapes this server creates
  (`upload-<ts>-<hex>`, `<uuid><ext>`, `<uuid>.cover`), which covers the upgrade case without
  weakening the guard.
- **Consistency note:** the same guard behaves three ways in three files — two throw, one logs.
  That split is what let the fatal version through unexamined.
- **Confidence:** high — reproduced.

## [HIGH] Thirteen admin settings are stored, echoed back, and never read

- **Location:** `src/settings.ts:201-318` (the specs), `src/mail/index.ts:99-118`,
  `src/auth/oidc.ts:51-79`
- **Category:** bug — pre-existing, and **missed by the first audit**
- **What:** `settings.raw()` reads the database with an environment fallback, and 21 of the 34
  settings are read that way. The other 13 — every Mail and every Single sign-on setting — are read
  only through `config.mail.*` and `config.oidc.*`, which are built from `process.env` once at
  import. Nothing ever writes a stored setting back into the environment or rebuilds `config`.
- **Why it matters:** The admin page presents a working form. An admin fills in their SMTP server,
  saves, is told **"NEEDS A RESTART"**, restarts — and the server re-reads the environment and
  ignores what they saved. Mail stays off. The value stays in the database being displayed back to
  them, which makes it look applied. `SMTP_PASSWORD` and `OIDC_CLIENT_SECRET` are encrypted at rest
  on the way in, so the server carefully protects a secret it never uses.
- **Trigger:** Set anything under Mail or Single sign-on in `/admin`.
- **Reproduced:** end to end. `PUT /api/admin/settings` for `SMTP_ENABLED=true`,
  `SMTP_HOST=smtp.example.com`, `SMTP_FROM_EMAIL=noreply@example.com` all returned 200 and came
  back as `overridden: true`. The rows are in the `settings` table. After restarting the process on
  the same database, `/auth/status` still reports `mailEnabled: false`.
- **The correlation is exact**, which is what makes this a design gap rather than an oversight:

  | | read back from the store | never read |
  |---|---|---|
  | **marked "needs a restart"** | 0 | **13** |
  | **not marked** | 21 | 0 |

  Every setting the UI says needs a restart is one a restart cannot apply.
- **Fix:** Either read them through `settings` at the point of use — `createMailer` and
  `OidcService` take their values from `settings.str('SMTP_HOST')` and friends, which also removes
  the need for a restart — or, if a restart is genuinely wanted for transport-level settings, apply
  stored values over `process.env` before `config` is built. The first is smaller and matches how
  the other 21 already work.
- **Confidence:** high — reproduced across a restart.

---

## Dead and unused code

You asked for this specifically. Measured, not estimated.

### [MEDIUM] 449 lines of CSS that nothing can ever match

- **Location:** `static/app.css`, `static/screens.css`
- **What:** **78 rule blocks over 449 lines** whose selectors appear in no markup and no script.
  Verified individually against every `.html` and `.js` in `static/`, including classes applied via
  `className`, `classList.*` and `setAttribute('class', …)`:

  `.auth-said--top` · `.auth__label-action` · `.auth__label-row` · `.auth__label-row--first` ·
  `.auth__note--footer` · `.btn--ok-quiet` · `.btn--secondary` · `.btn-link--quiet` ·
  `.endpoint-meta` (+ `__dot`, `__seen`, `__text`) · `.field--code` · `.format-hint` ·
  `.format__note` · `.manual` · `.meta` · `.section-title` · `.step--quiet` · `.step__actions` ·
  `.step__badge--tick` · `.step__head` · `.tfa-setup` · `.tfa-setup__title`

  Plus two custom properties declared and never referenced — `--border-mute`, `--err-hover` — and
  `.center` and `.hint` in the e-reader stylesheet.
- **Why it matters:** ~10% of the design system is unreachable. Some of it is a trap rather than
  just weight: `.btn--secondary` and `.field--code` look like live variants someone would reach
  for, and `.tfa-setup` sits next to `.tfa-setup__body` and `.tfa-setup__side`, which *are* used.
- **Why it accumulated:** `test/page.test.ts:396` asserts that every class in the markup has a
  rule. Nothing asserts the reverse, so deleting markup silently orphans its CSS and the suite
  stays green. That asymmetry is the actual finding.
- **Fix:** Delete them, and add the mirror check to `page.test.ts` with an explicit allowlist for
  anything applied dynamically in a way a static scan cannot see.
- **Confidence:** high for the list above — each was grepped individually. `.is-complete`,
  `.is-syncing`, `.is-warn` and `.warn-tri` looked dead to a first scan and are **not**; they are
  applied from JavaScript. They are excluded.

### [LOW] Three exported functions nothing calls

- **Location:** `src/convert/index.ts:128`, `src/db/index.ts:54`, `src/db/index.ts:58`
- **What:** `conversionsRunning()`, `setDatabase()`, `closeDatabase()` — each declared once and
  referenced nowhere in `src/` or `test/`.
- **Note:** `conversionsRunning` is mine. I added it alongside the concurrency limiter in `8f49cfd`
  as an accessor for the counter and then never used it — dead on arrival, in the same commit that
  introduced it. `setDatabase`/`closeDatabase` are pre-existing.
- **Fix:** Delete all three. `conversionsRunning` would be worth keeping only if `/healthz` reported
  it, which would be a reasonable thing to do instead.
- **Confidence:** high.

### [LOW] Exports with no consumer outside their own file

- **Location:** across `src/` — `normaliseEmail`, `generateToken`, `normaliseCode`, `decodeHref`,
  `senderAddress`, `isInventedIdentifier`, `migrate`, `koboFormat`, `requestRestart`, and the
  constants `PENDING_TTL_MS`, `PERIOD_SECONDS`, `DIGITS`, `lockedKeys`, `MAX_XML`.
- **What:** Exported, used only inside the module that declares them, and not reached by any test
  either — so the export is not a testing seam, it is just reach.
- **Why it matters:** Mildly. It widens the surface that has to keep working and blunts
  `noUnusedImports`, which can only see unused *imports*.
- **Fix:** Drop `export` where nothing imports it. Roughly 60 exported *types* are in the same
  position; that is idiomatic and not worth changing.
- **Confidence:** high on the list, low on it mattering much.

### Clean

No unused files in `src/` — every module is imported by something. No unused runtime or dev
dependencies: all 13 runtime and all 7 dev packages are referenced. No dead config fields, top level
or nested. No environment variable documented in `.env.example` that nothing reads. The dead
database columns from the first pass are gone.

---

## What the first pass fixed, re-verified here

Spot-checked on the current build rather than trusted:

- **Security headers** are present on both pages and API responses, HSTS correctly absent over
  plain http.
- **CSRF**: `POST /auth/sessions/revoke-others` is 403 without a token, 200 with it. I tried to
  borrow the `/kobo/` exemption with `/kobo/../auth/…`, `%2f` encoding, and `//kobo/…` — no bypass;
  nothing reached the route with the check skipped. The exemption is still a raw string prefix on
  `req.url`, which is worth remembering if a normalising proxy is ever put in front.
- **Founder escalation**, **token redaction**, **mail link redaction**, **aborted downloads** — all
  still behave as recorded in the first pass.
- **Desktop layout** did not regress from the responsive work: at 1440×900 the pills are visible,
  the drawer toggle is hidden, the step rail is back beside the card. The card is 611px rather than
  the old fixed 862px, which is the change you asked for, and it means short desktop windows now
  look different from before.

## Systemic

**The suite grew to 1101 tests and got no better at catching this class of bug.** Both Criticals are
invisible to it for the same reason: nothing boots the server against pre-existing state, and
nothing loads a page and checks it works. `test/static.test.ts` reads the e-reader bundle's bytes
and never runs it. The cheapest fix with real coverage is one boot test against a populated data
directory, and one page test that asserts the receive page's script actually executed.

**Tests that check one direction encourage rot in the other.** Every class in the markup must have a
rule; no rule need have markup. 449 lines followed.

**My own worst habit in this codebase has been generalising from one file.** "No page has an inline
script" came from reading `send.html`. "The e-reader bundle is out of scope" was true of the
responsive work and false of a global header. Both Criticals trace to the same move.

## What I could not check

- **A real e-reader.** The CSP breakage is reproduced in Chrome, which is conclusive for the block
  itself, but the actual Kobo browser is untested — as it was in the first pass.
- **The Docker image and CI.** Neither has been built or run. The upgrade regression is reproduced
  by booting the code directly against a populated directory, which is the same code path the
  container takes, but the container itself is unverified.
- **SSO end to end.** No identity provider configured, so the inert-settings finding for OIDC rests
  on the same static and restart evidence as the mail one rather than on a real sign-in.
- **Whether any of the 449 dead CSS lines are reachable through markup I did not think to scan** —
  I covered `class=`, `className`, `classList.*` and `querySelector`-family selectors across every
  HTML and JS file, which is how I caught the four false positives, but a class assembled from
  fragments at runtime would still slip through.
- **The conversion concurrency limiter**, still enforced-by-construction and untested, as recorded
  last time.

---

## Appendix — the first pass

The original audit of `f2950be` found 5 High, 9 Medium and ~20 Low issues; all were worked through
in commits `1af8858`..`f7546f1`, and the responsive work in `9fb9819`. Reproduced then and fixed:
founder deletion granting admin, the Kobo device token in the logs, passkey login skipping 2FA,
unauthenticated unthrottled convert/upload, and the complete absence of security headers. Three
findings were accepted rather than fixed — passkey user verification stays optional, anonymous
conversion results stay capability URLs, four-character pairing keys stay the default. Two findings
turned out to be wrong and were corrected: the zip allocation was worse than graded, and the
`/history` vs `/waiting` split was a justified difference rather than an inconsistency.
