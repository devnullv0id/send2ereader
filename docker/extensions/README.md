# Extensions

Three converters do not belong in the image. Amazon's Kindle Previewer is not
ours to redistribute; calibre and pdfCropMargins are simply large, and a server
that only sends EPUB to a Kobo needs neither. So they are not there — and the
operator who wants them asks, either from the browser or at container start.

| id | Directory | Adds | Needs |
| --- | --- | --- | --- |
| `calibre` | [calibre](calibre) | MOBI, AZW3, PDF, TXT, HTMLZ, reading KFX | — |
| `pdfcrop` | [pdfcrop](pdfcrop) | Trimming a PDF's margins | — |
| `kfx` | [kfx](kfx) | Writing KFX | `calibre` |

```yaml
services:
  send2ereader:
    image: ghcr.io/devnullv0id/send2ereader:latest
    environment:
      EXTENSIONS: calibre|pdfcrop|kfx
      EXTENSION_PACKAGES: fonts-noto-cjk|poppler-utils
```

Both are pipe-separated, the way linuxserver's images spell it, so a list copied
from one of those needs no re-punctuating. A bare id is one of the three above,
installed from the script the image already carries — no registry involved. A
name with a slash is an OCI image, pulled and unpacked as before.

## What happens at start

The entrypoint runs as root, and only for as long as this takes:

1. `EXTENSION_PACKAGES` is handed to `apt-get install`.
2. Each name in `EXTENSIONS` is either recognised as one of the three built in —
   remembered, and its installer staged from `/opt/s2e` — or pulled from its
   registry as an OCI image and unpacked over `/`.
3. Anything left in `/etc/s2e/extensions` is run once, in name order, and
   deleted. The names are numbered `10-calibre`, `20-pdfcrop`, `30-kfx`, which
   is dependency order: KFX is a calibre plugin and has nothing to plug into
   until calibre is there.
4. The server is exec'd as the `node` user through `setpriv`. Nothing after this
   point is privileged.

An extension that fails is logged and skipped. It never stops the server from
starting, because a container that will not come up is worse than one missing a
format.

## Writing one

An extension is an OCI image whose only content is the script it wants run:

```dockerfile
FROM scratch
COPY install.sh /etc/s2e/extensions/10-my-extension.sh
```

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t ghcr.io/you/s2e-mod-my-extension:latest --push .
```

The script runs as root with the whole image available to it. Keep anything
expensive under `/data`, so it survives a restart and is not paid for twice.

## Turning one on from the browser

The admin page has a **Converters** panel, and it leads to a page that installs
any of them while the server keeps running. Nothing needs to be set in the
environment and nothing restarts. Detection is redone the moment a run finishes,
so the Convert page starts offering the new formats without anyone signing out.

It works because the entrypoint forks a small root agent before it drops
privileges. The server runs as `node` and cannot `apt-get` anything; the agent
can, and watches `/data/extensions/request` for lines asking it to. That file is
a queue: the assistant asks for all three at once, and the agent moves the whole
file aside before reading it, so a request arriving mid-run is never read
half-written. Each installer writes its stages to `/data/<id>/<id>.progress` and
everything it says to `/data/<id>/<id>.log`, which is what the page shows.

A removal deletes only what the install unpacked — never the `/data/<id>`
directory itself, because the progress the page is reading lives there and
taking it would leave the page waiting forever.

What was asked for is remembered in `/data/extensions/enabled`, so a container
recreated against the same volume puts it back without anyone opening the page.
Everything expensive is still on the volume by then, so that is seconds of
relinking rather than the full install.

## calibre

In [calibre](calibre). It installs the Debian libraries calibre draws with,
fetches the current release from `calibre-ebook.com` with the progress shown as
a percentage, unpacks it into `/data/calibre/app`, and links its binaries into
`/usr/local/bin`.

It also registers the two KFX plugins the image carries. They cannot be
registered while the image is built, because there is no calibre there to
register them with — this is the first moment one exists. KFX Input is enough on
its own to read a `.kfx`; KFX Output needs the Previewer, which is the kfx
extension.

- `CALIBRE_URL` — a copy to fetch instead, if this container cannot reach the
  download site.

Removing it deletes `/data/calibre/app` and the links, and leaves the Debian
libraries alone: apt shares them with anything else installed here.

## pdfcrop

In [pdfcrop](pdfcrop). A Python virtual environment under `/data/pdfcrop/venv`
with pdfCropMargins in it, and a link in `/usr/local/bin`. It stands on its own —
cropping a PDF and sending it as a PDF never touches calibre.

The one thing to know: `import venv` succeeds on a Debian slim image that has no
`python3-venv` at all. It is `ensurepip` that is missing, and only
`python3 -m venv` finds that out, so that is what the installer checks.

## kfx

In [kfx](kfx). It enables i386, installs Wine, installs the Kindle
Previewer, and needs calibre already installed — the page and the API both
refuse it otherwise, by name, rather than quietly installing calibre underneath.

The Previewer is fetched automatically from Amazon's own download URL, the one
their download page points at. It is about 356MB, so first start is slow; after
that everything lives under `/data/kfx` and the extension is a no-op.

- `KFX_PREVIEWER_URL` — only needed if Amazon moves it, or if you would rather
  the container pulled a copy you host. What comes back is checked for a
  Windows executable header before Wine is asked to run it, so an error page
  served with a 200 is refused rather than executed.
- `KFX_OUTPUT_PLUGIN_URL` — not needed from 2.0.1 on: the plugin is in the
  image, resolved at build time from its MobileRead thread. Set it only to add
  the plugin to an older image.

The extension writes the path of the Previewer it installed to
`/etc/s2e/kfx-previewer`, and the server reads that file to decide whether KFX
can be offered. The plugin being installed is not enough on its own — a plugin
with no Previewer behind it would offer KFX and then fail the conversion. Set
`KFX_PREVIEWER_PATH` if you have a Previewer that did not come from here.

Anything that fails is said plainly in the log and skipped; the server starts
either way.

When it works, `/api/convert/targets` starts offering KFX for real instead of
refusing it, because the server asks calibre what plugins it has rather than
being told.

Everything it installs lands in `/data/kfx`, so the second start is
quick and a `docker rm` does not undo it.
