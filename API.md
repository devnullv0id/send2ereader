# HTTP API

Reference for building a front end against this server. Everything here is
implemented and covered by tests unless marked **not built yet**.

Two rules shape the whole surface:

- **Sending a book never requires an account.** The key flow works for anyone
  who can reach the server, and that will not change.
- **Accounts are optional.** They are on by default, with the session secret
  generated on first boot if none was given. With `ACCOUNTS=false` there is no
  database, no cookies, and every `/auth/*` and account page returns **404**.
  Check `accounts` on `/healthz` before rendering anything account-related.

Errors are JSON: `{ "ok": false, "error": "human readable reason" }`, except a
few read-only endpoints that return `{ "error": "..." }`. Status codes carry
the meaning; the strings are for display and may change.

---

## Discovery

### `GET /healthz`

Unauthenticated. Everything the sender page needs to render itself.

```json
{
  "ok": true,
  "keys": 3,
  "tools": {
    "kepubify": true,
    "calibre": true,
    "pdfcropmargins": true,
    "kfxInput": false,
    "layoutFix": true
  },
  "keyLength": 4,
  "maxFileSize": 838860800,
  "accounts": true
}
```

`tools` reports which converters this deployment actually has. A missing one is
not an error: the file is sent unconverted instead. Use it to explain the
consequence rather than to hide the option — see the notes on the target switch
below.

### `GET /auth/status`

**404 when accounts are off.** Safe to call unauthenticated.

```json
{
  "enabled": true,
  "unclaimed": false,
  "registrationOpen": false,
  "ssoEnabled": true,
  "mailEnabled": true,
  "minPasswordLength": 10,
  "user": { "id": "uuid", "email": "a@b.c", "emailVerified": true, "isAdmin": true }
}
```

| Field | Meaning for the UI |
| --- | --- |
| `unclaimed` | No administrator exists. Send the visitor to `/setup`. |
| `registrationOpen` | Whether to offer "create an account" at all. |
| `ssoEnabled` | Whether to show the SSO button. |
| `mailEnabled` | `false` means links are written to the server log, not e-mailed. Say so, or people wait for mail that will never arrive. |
| `minPasswordLength` | Drive `minlength` and the hint text from this, never a hardcoded number. |
| `user` | `null` when signed out. |

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
  "expiresIn": 30,
  "file": { "name": "book.kepub.epub", "size": 481920 },
  "urls": ["https://example.com/article"]
}
```

`file` is `null` until something is sent. Polling also keeps the key alive.

### `GET /key/:key`

For the **sender**, so the form can preselect a conversion target. No
`User-Agent` check — the sender is a different device.

```json
{ "device": "kobo", "hasFile": false }
```

`device` is `kobo` | `kindle` | `tolino` | `generic`. `404` if unknown.

### `POST /upload`

`multipart/form-data`. All fields optional except `key`; send a file, a url, or
both.

| Field | Values |
| --- | --- |
| `key` | required |
| `file` | the book |
| `url` | `http(s)` only; anything else is rejected |
| `target` | `auto` (default) · `kobo` · `kindle` · `none` |
| `kindleFormat` | `azw3` (default) · `mobi` |
| `layoutFix` | defaults **on**; send `off` explicitly to disable |
| `pdfcropmargins`, `transliteration` | default off |

```json
{
  "ok": true,
  "key": "7F3K",
  "messages": ["Upload successful! …", "Filename: book.kepub.epub"],
  "filename": "book.kepub.epub",
  "conversion": ["layoutfix", "kepubify"],
  "url": null
}
```

`messages` is an array of plain strings — **render them as text, never HTML**.
They embed the uploaded filename, which is attacker-controlled. `conversion`
lists the steps that actually ran, in order, and is `[]` for a pass-through.

A Kindle conversion is emitted with calibre's `--share-not-sync`, which is what
makes the downloaded book show its cover. calibre otherwise stamps an invented
ASIN into the file and marks it "bought", so the Kindle asks Amazon for a cover
that does not exist and then refuses to use the one inside the file. Set
`KINDLE_SHARE_NOT_SYNC=false` to get calibre's stock behaviour back. A file that
is *already* AZW3 or MOBI is passed through untouched and keeps whatever
markings it came with — the UI should say so.

Failure codes: `400` bad key/format/url, `413` too large, `415` not multipart,
`422` a converter failed (the message contains its output, path-redacted).

**`layoutFix` defaults on, so an absent field means enabled.** An unchecked
checkbox submits nothing, so a form must send an explicit `off` — pair the box
with a hidden input of the same name, hidden first.

### `GET /download/:filename?key=KEY`

Called by the ereader. Requires the generating `User-Agent`, and `:filename`
must match exactly. Supports `Range`. The filename is the last path segment on
purpose: the Kindle browser names the saved file after the URL.

### `DELETE /file/:key`

Detaches **and deletes** the stored file. Requires the generating `User-Agent`.

---

## Accounts

All **404 when accounts are off**. Session is an encrypted `HttpOnly` cookie;
send `credentials: 'same-origin'`.

| Route | Body | Notes |
| --- | --- | --- |
| `POST /auth/register` | `{ email, password }` | First account becomes administrator. `403` once closed. |
| `POST /auth/login` | `{ email, password }` | `401` with identical wording for a wrong password and an unknown address — deliberately not an enumeration oracle. |
| `POST /auth/logout` | — | |
| `GET /auth/verify?token=` | — | Redirects to `/account?verified=1` or `/login?error=verify`. |
| `POST /auth/verify/resend` | — | Requires a session. |
| `POST /auth/reset/request` | `{ email }` | **Always** `{ ok: true }`, known address or not. |
| `POST /auth/reset` | `{ token, password }` | Signs the user in and marks the address verified. |

Register and login return `{ ok: true, user: {…} }`. Register also returns
`claimed` and `mailEnabled`.

These are **rate limited to 10 per 5 minutes** because each attempt costs a
deliberately expensive password hash. Expect `429`.

### Single sign-on

Only registered when SSO is fully configured; `ssoEnabled` on `/auth/status`
tells you whether to show the button.

- `GET /auth/sso?next=/account` — full-page redirect to the provider. **Not
  XHR**: it is a navigation.
- `GET /auth/sso/callback` — the provider returns here; ends on `/account` or
  `/login?error=sso&reason=…`.

An SSO identity is joined to an existing local account **only** when the
provider asserts `email_verified`. `OIDC_ADMIN_GROUP` membership is
re-evaluated on every login, but the last administrator is never demoted.

### Pages the server currently serves

`/setup` `/login` `/register` `/account` `/auth/forgot` `/auth/reset`

While `unclaimed`, `/`, `/send`, `/login` and `/register` all redirect to
`/setup` — except for an ereader `User-Agent`, which still gets its key page
because it cannot complete a setup form.

HTML is served `Cache-Control: no-cache`; CSS and JS are cached and carry a
`?v=` marker, so bump it when you change them.

---

## Registered ereaders

All of these need a signed-in account **with a confirmed address** — the token
they hand out lets a device pull books, so it is never issued to an address
nobody has proven they can read. `401` when signed out, `403` when unverified.

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
      "paired": false
    }
  ]
}
```

`paired` is `true` once the Kobo has actually contacted the server — use it to
tell "registered" apart from "registered and working".

### `POST /api/devices`

Body is optional: `{ "label": "Clara BW", "proxyStore": true }`. Defaults to
`"My Kobo"` with the store proxy on.

```json
{
  "ok": true,
  "device": { "id": "uuid", "label": "Clara BW", "proxyStore": true, "paired": false },
  "token": "8Kx…",
  "endpoint": "https://send.example.com/kobo/8Kx…"
}
```

**`token` and `endpoint` are returned exactly once.** Only a hash is stored, so
they cannot be shown again — the UI has to say so and make the value easy to
copy. `endpoint` is what goes into the Kobo's `api_endpoint`.

### `PATCH /api/devices/:id`

`{ "label"?: string, "proxyStore"?: boolean }`. Returns the updated device.
`400` on an empty name.

### `DELETE /api/devices/:id`

Revokes the token immediately.

Someone else's device id returns **404, not 403**, so the API never confirms
that an id exists on another account.

---

## Sending to a registered device

Same `POST /upload` endpoint. Send **`deviceId` instead of `key`**; everything
else (`file`, `target`, `layoutFix`, …) behaves the same. `url` is not
supported here — a Kobo library holds books, not links.

Requires a signed-in, **verified** account that owns the device. Unlike the key
flow, the receiving device is not consenting in the moment, so this is not open
to anyone who can reach the server. `401` signed out, `403` unverified, `404`
for a device that is not yours.

```json
{
  "ok": true,
  "deviceId": "uuid",
  "messages": ["Queued for Clara. It will appear after the next sync.", "Filename: My Book.kepub.epub"],
  "filename": "My Book.kepub.epub",
  "conversion": ["layoutfix", "kepubify"],
  "book": { "id": "uuid", "title": "My Book", "size": 481920 },
  "url": null
}
```

The book waits in an **outbox, not a library**: the device collects it on its
next sync and the file is then deleted. Anything uncollected expires after
`KOBO_QUEUE_TTL` (6 hours by default), and **a restart clears the queue** — the
UI should say so, because "sent" does not mean "delivered" until the Kobo syncs.

`title` comes from the book's own `dc:title`, read out of the EPUB after
conversion — along with `dc:creator` and `dc:language`, which become the
`Contributors` and `Language` a Kobo shows in its library. Nothing is stored;
the package document is parsed on the way past. A book that declares no title,
or is not an EPUB, falls back to the filename (`My_Book.epub` → `My Book`) with
`Contributors: ["send2ereader"]` and `Language: "en"`.

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
| `GET`/`PUT /v1/library/:uuid/state` | Reading state — accepted and discarded |
| `DELETE /v1/library/:uuid` | The device removing a book. Drops it from the queue and stops the kept copy being offered again |
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

---

Everything in the plan is now implemented. What remains is verification on
real hardware, which no amount of testing here substitutes for:

1. **Back up `.kobo/Kobo/Kobo eReader.conf`.** Restoring it is the escape
   hatch if anything goes wrong.
2. Set `api_endpoint` to the `endpoint` from `POST /api/devices`.
3. Send a book, sync, and confirm it lands in the device's library.
4. Confirm the store still browses, then that turning `proxyStore` off leaves
   delivery working.
