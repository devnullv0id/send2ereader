FROM node:24-trixie-slim AS builder

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev &&     find node_modules -type d -path '*/prebuilds/*'         ! -name 'linux-x64' ! -name 'linux-arm64'         -maxdepth 3 -mindepth 3 -prune -exec rm -rf {} +

FROM node:24-trixie-slim AS tools

ARG TARGETARCH
ARG KEPUBIFY_VERSION=4.0.4
ARG EPUB_LAYOUT_FIX_REPO=devnullv0id/calibre-epub-layout-fix
ARG EPUB_LAYOUT_FIX_REF=v0.2.0
ARG EPUB_LAYOUT_FIX_FORGE=github
ARG EPUB_LAYOUT_FIX_HOST=code.private-home-network.de

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl unzip && \
    rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
        amd64) SUFFIX=linux-64bit ;; \
        arm64) SUFFIX=linux-arm64 ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2 ; exit 1 ;; \
    esac && \
    curl -fsSL -o /out-kepubify \
        "https://github.com/pgaskin/kepubify/releases/download/v${KEPUBIFY_VERSION}/kepubify-${SUFFIX}" && \
    chmod +x /out-kepubify

ARG KFX_INPUT_PLUGIN_URL=""
ARG KFX_OUTPUT_PLUGIN_URL=""
ARG KFX_INPUT_THREAD="291290"
ARG KFX_OUTPUT_THREAD="272407"

COPY docker/fetch-calibre-plugin.sh /fetch-calibre-plugin.sh
RUN sh /fetch-calibre-plugin.sh 'KFX Input.zip' "${KFX_INPUT_THREAD}" "${KFX_INPUT_PLUGIN_URL}" /out-kfx-input.zip && \
    sh /fetch-calibre-plugin.sh 'KFX Output.zip' "${KFX_OUTPUT_THREAD}" "${KFX_OUTPUT_PLUGIN_URL}" /out-kfx-output.zip

ARG EPUB_LAYOUT_FIX_ASSET=EPUB-Layout-Fix.zip

RUN FORGE="${EPUB_LAYOUT_FIX_FORGE:-github}" && \
    HOST="${EPUB_LAYOUT_FIX_HOST:-code.private-home-network.de}" && \
    case "$FORGE" in \
        github)  BASE="https://github.com/${EPUB_LAYOUT_FIX_REPO}" ;; \
        forgejo) BASE="https://${HOST}/${EPUB_LAYOUT_FIX_REPO}" ;; \
        *) echo "EPUB_LAYOUT_FIX_FORGE must be github or forgejo, not ${FORGE}" >&2 ; exit 1 ;; \
    esac && \
    if [ "${EPUB_LAYOUT_FIX_REF}" = "latest" ]; then \
        if [ "$FORGE" != "github" ]; then \
            echo "EPUB_LAYOUT_FIX_REF=latest only works on github; pin a version for ${FORGE}" >&2 ; \
            exit 1 ; \
        fi ; \
        URL="${BASE}/releases/latest/download/${EPUB_LAYOUT_FIX_ASSET}" ; \
    else \
        URL="${BASE}/releases/download/${EPUB_LAYOUT_FIX_REF}/${EPUB_LAYOUT_FIX_ASSET}" ; \
    fi && \
    echo "EPUB Layout Fix ${EPUB_LAYOUT_FIX_REF}: ${URL}" && \
    mkdir -p /out-layout-fix && \
    curl -fsSL --retry 3 --retry-delay 2 -o /tmp/elf.zip "$URL" && \
    unzip -j -o /tmp/elf.zip fixer.py -d /out-layout-fix && \
    printf '%s\n' "${EPUB_LAYOUT_FIX_REF}" > /out-layout-fix/VERSION

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

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
    && rm -rf /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*

COPY --from=tools /out-kepubify /usr/local/bin/kepubify
COPY --from=tools /out-layout-fix /opt/epub-layout-fix
COPY docker/epub-layout-fix /usr/local/bin/epub-layout-fix

COPY --from=tools /out-kfx-input.zip /opt/s2e/kfx-input.zip
COPY --from=tools /out-kfx-output.zip /opt/s2e/kfx-output.zip

RUN chmod +x /usr/local/bin/epub-layout-fix && \
    epub-layout-fix --version && \
    python3 -c "import sys; sys.path.insert(0, '/opt/epub-layout-fix'); import fixer; print('engine ok')" && \
    kepubify --version

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY static ./static
COPY languages ./languages
COPY package.json ./

RUN mkdir -p /data/uploads /data/db /data/queue /data/library /data/languages /opt/calibre-config /etc/s2e/extensions && \
    chown -R node:node /data /opt/calibre-config

ENV DATA_DIR=/data

COPY docker/entrypoint.sh /usr/local/bin/entrypoint
COPY docker/extension-agent.sh /usr/local/bin/extension-agent
COPY docker/extensions-lib.sh /usr/local/lib/s2e/extensions-lib.sh
COPY docker/extensions/calibre/install.sh /opt/s2e/install-calibre.sh
COPY docker/extensions/calibre/remove.sh /opt/s2e/remove-calibre.sh
COPY docker/extensions/pdfcrop/install.sh /opt/s2e/install-pdfcrop.sh
COPY docker/extensions/pdfcrop/remove.sh /opt/s2e/remove-pdfcrop.sh
COPY docker/extensions/kfx/install.sh /opt/s2e/install-kfx.sh
COPY docker/extensions/kfx/remove.sh /opt/s2e/remove-kfx.sh
RUN chmod +x /usr/local/bin/entrypoint /usr/local/bin/extension-agent /opt/s2e/install-calibre.sh /opt/s2e/remove-calibre.sh /opt/s2e/install-kfx.sh /opt/s2e/remove-kfx.sh /opt/s2e/install-pdfcrop.sh /opt/s2e/remove-pdfcrop.sh

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.HTTP_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["node", "dist/server.js"]
