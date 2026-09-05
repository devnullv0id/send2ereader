# syntax=docker/dockerfile:1

FROM node:24-trixie-slim AS builder

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# sodium-native ships a prebuilt binary for thirteen platforms. Only Linux can
# ever load here, and the other eleven are about nine megabytes of dead weight
# that has to go before node_modules is copied into the runtime image.
RUN npm run build && npm prune --omit=dev &&     find node_modules -type d -path '*/prebuilds/*'         ! -name 'linux-x64' ! -name 'linux-arm64'         -maxdepth 3 -mindepth 3 -prune -exec rm -rf {} +


# Everything fetched from the network is fetched here, so the runtime image never
# installs curl or unzip and never carries an apt list for having done so.
FROM node:24-trixie-slim AS tools

ARG TARGETARCH
ARG KEPUBIFY_VERSION=4.0.4
ARG EPUB_LAYOUT_FIX_REPO=devnullv0id/calibre-epub-layout-fix
# Pinned, not "latest": this python runs inside the conversion pipeline over files
# strangers upload, so the image should not change underneath a rebuild. Raise it
# deliberately when there is a release worth taking.
ARG EPUB_LAYOUT_FIX_REF=v0.2.0

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

# One architecture, not both. ADDing both put the unused one in the image for good,
# because deleting it in a later layer does not take it back out of the earlier one.
RUN case "${TARGETARCH}" in \
        amd64) SUFFIX=linux-64bit ;; \
        arm64) SUFFIX=linux-arm64 ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2 ; exit 1 ;; \
    esac && \
    curl -fsSL -o /out-kepubify \
        "https://github.com/pgaskin/kepubify/releases/download/v${KEPUBIFY_VERSION}/kepubify-${SUFFIX}" && \
    chmod +x /out-kepubify

ARG KFX_INPUT_PLUGIN_URL=""
# Always produces the file so the COPY below is unconditional; empty means no plugin.
RUN if [ -n "${KFX_INPUT_PLUGIN_URL}" ]; then         curl -fsSL -o /out-kfx-input.zip "${KFX_INPUT_PLUGIN_URL}" ;     else         : > /out-kfx-input.zip ;     fi

RUN if [ "${EPUB_LAYOUT_FIX_REF}" = "latest" ]; then \
        API="https://api.github.com/repos/${EPUB_LAYOUT_FIX_REPO}/releases/latest" ; \
    else \
        API="https://api.github.com/repos/${EPUB_LAYOUT_FIX_REPO}/releases/tags/${EPUB_LAYOUT_FIX_REF}" ; \
    fi && \
    META="$(curl -fsSL "$API")" && \
    TAG="$(printf '%s' "$META" | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)" && \
    URL="$(printf '%s' "$META" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*\.zip"' | head -1 | cut -d'"' -f4)" && \
    test -n "$URL" && echo "EPUB Layout Fix ${TAG}: ${URL}" && \
    mkdir -p /out-layout-fix && \
    curl -fsSL -o /tmp/elf.zip "$URL" && \
    unzip -j -o /tmp/elf.zip fixer.py -d /out-layout-fix && \
    printf '%s\n' "$TAG" > /out-layout-fix/VERSION


FROM node:24-trixie-slim AS runtime

ARG TARGETARCH

ENV NODE_ENV=production \
    HTTP_PORT=3001 \
    UPLOAD_DIR=/data/uploads \
    DB_PATH=/data/db/send2ereader.db \
    KOBO_QUEUE_DIR=/data/queue \
    LIBRARY_DIR=/data/library \
    QT_QPA_PLATFORM=offscreen \
    CALIBRE_CONFIG_DIRECTORY=/opt/calibre-config \
    HOME=/home/node

# One layer for the whole runtime, because anything deleted in a later layer stays
# in the image regardless. calibre brings a full scientific python stack it only
# needs for its GUI and its plugins, and ebook-convert never touches scipy or
# sympy on these formats.
#
# QtWebEngine stays, all 239MB of it. calibre's PDF output plugin imports
# QWebEnginePage, so deleting it does not shrink the image so much as remove PDF
# from the product — which is what the version of this file before it did, without
# saying so. Its locale packs do go: one language is enough for a renderer whose
# interface nobody ever sees. Every removal here is checked afterwards by
# converting a book into every format the page offers.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        calibre \
        curl \
        pipx \
        python3 \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install pdfCropMargins \
    && rm -rf /usr/lib/python3/dist-packages/scipy \
              /usr/lib/python3/dist-packages/sympy \
              /usr/lib/python3/dist-packages/pygments \
              /usr/lib/x86_64-linux-gnu/lapack \
              /usr/lib/x86_64-linux-gnu/blas \
    && rm -f /usr/lib/*-linux-gnu/libx265.so* \
             /usr/lib/*-linux-gnu/libcodec2.so* \
             /usr/lib/*-linux-gnu/libSvtAv1Enc.so* \
             /usr/lib/*-linux-gnu/libz3.so* \
    && rm -rf /opt/pipx/venvs/*/lib/python*/site-packages/pip \
              /opt/pipx/venvs/*/lib/python*/site-packages/pip-* \
              /opt/pipx/venvs/*/lib/python*/site-packages/setuptools \
              /opt/pipx/venvs/*/lib/python*/site-packages/setuptools-* \
              /opt/pipx/venvs/*/lib/python*/site-packages/wheel \
              /opt/pipx/venvs/*/lib/python*/site-packages/wheel-* \
    && rm -f /usr/share/qt6/translations/*.qm \
    && find /usr/share/qt6/translations/qtwebengine_locales -type f \
            ! -name 'en-US.pak' -delete \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info \
              /usr/share/calibre/manual \
              /usr/share/locale \
    && find /usr/lib/python3 /usr/lib/python3.* /opt/pipx -name '__pycache__' -type d -prune -exec rm -rf {} + \
    && find /usr/lib/python3 /usr/lib/python3.* /opt/pipx -name '*.pyc' -delete \
    && apt-get purge -y pipx \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

COPY --from=tools /out-kepubify /usr/local/bin/kepubify
COPY --from=tools /out-layout-fix /opt/epub-layout-fix
COPY docker/epub-layout-fix /usr/local/bin/epub-layout-fix

COPY --from=tools /out-kfx-input.zip /tmp/kfx-input.zip
RUN if [ -s /tmp/kfx-input.zip ]; then         calibre-customize -a /tmp/kfx-input.zip &&         calibre-customize --list-plugins | grep -qi 'KFX Input' ;     fi &&     rm -f /tmp/kfx-input.zip

RUN chmod +x /usr/local/bin/epub-layout-fix && \
    epub-layout-fix --version && \
    python3 -c "import sys; sys.path.insert(0, '/opt/epub-layout-fix'); import fixer; print('engine ok')" && \
    kepubify --version && \
    ebook-convert --version

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY static ./static
COPY package.json ./

RUN mkdir -p /data/uploads /data/db /data/queue /data/library /opt/calibre-config /etc/s2e/extensions && \
    chown -R node:node /data /opt/calibre-config

COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint

# No USER here on purpose. The entrypoint starts as root, installs whatever
# EXTENSIONS asks for, and then drops to node with setpriv before the server is
# ever exec'd — the same guarantee USER gives, arrived at a step later.
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "dist/server.js"]
