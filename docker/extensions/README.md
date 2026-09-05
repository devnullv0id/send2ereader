# Extensions

Some things do not belong in the image. Amazon's Kindle Previewer is not ours to
redistribute, and Wine is several hundred megabytes that nobody who only wants
EPUB should have to pull. So they are not there — and the operator who wants
them can add them at container start.

```yaml
services:
  send2ereader:
    image: ghcr.io/devnullv0id/send2ereader:latest
    environment:
      EXTENSIONS: ghcr.io/devnullv0id/s2e-mod-kfx:latest
      EXTENSION_PACKAGES: fonts-noto-cjk|poppler-utils
```

Both are pipe-separated, the way linuxserver's images spell it, so a list copied
from one of those needs no re-punctuating.

## What happens at start

The entrypoint runs as root, and only for as long as this takes:

1. `EXTENSION_PACKAGES` is handed to `apt-get install`.
2. Each name in `EXTENSIONS` is pulled from its registry — a token, the
   manifest, then each blob — and unpacked over `/`.
3. Anything left in `/etc/s2e/extensions` is run once, in name order, and
   deleted.
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

## kfx

In this directory. It enables i386, installs Wine, installs the Kindle
Previewer, and adds calibre's KFX Output plugin.

Both downloads are yours to provide, and the extension does nothing without
them:

- `KFX_PREVIEWER_URL` — a Kindle Previewer installer this container can reach.
  Amazon's own download URL answers 403 to anything that is not a browser, so
  there is no default: fetch it once yourself and host it somewhere the
  container can pull it from.
- `KFX_OUTPUT_PLUGIN_URL` — calibre's KFX Output plugin, distributed by its
  author rather than by us.

With neither set, the extension says so and exits, and the server starts
normally with KFX still refused.

When it works, `/api/convert/targets` starts offering KFX for real instead of
refusing it, because the server asks calibre what plugins it has rather than
being told.

Everything it installs lands in `/data/kfx`, so the second start is
quick and a `docker rm` does not undo it.
