#!/bin/sh
set -eu

PREFIX="${CALIBRE_PREFIX:-/data/calibre}"
APP="${PREFIX}/app"
ARCHIVE="${PREFIX}/calibre.txz"

RUN_UID="${PUID:-$(id -u node)}"
RUN_GID="${PGID:-$(id -g node)}"

CONFIG_DIR="${CALIBRE_CONFIG_DIRECTORY:-/opt/calibre-config}"
BINARIES='ebook-convert calibre-customize ebook-meta ebook-polish calibre-debug'

say() {
    printf 'calibre: %s\n' "$*" >&2
    [ -n "${S2E_LOG:-}" ] && printf '%s\n' "$*" >> "$S2E_LOG"
    return 0
}

stage() {
    [ -n "${S2E_PROGRESS:-}" ] || return 0
    printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$S2E_PROGRESS"
    return 0
}

link_binaries() {
    for name in $BINARIES; do
        [ -x "${APP}/${name}" ] && ln -sf "${APP}/${name}" "/usr/local/bin/${name}"
    done
    return 0
}

stage run install

# Everything calibre needs from Debian. Qt comes bundled in the tarball; these
# are the system libraries underneath it. libnss3 and its neighbours are only
# reached on the PDF path, which is why a container without them converted
# everything else and failed PDF alone.
LIBS='xz-utils
      libegl1 libfontconfig1 libgl1 libgl1-mesa-dri libglx-mesa0 libopengl0
      libxcb-cursor0 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxi6
      libxkbcommon-x11-0 libxkbcommon0 libxkbfile1 libxrandr2 libxrender1 libxtst6
      libasound2t64 libdbus-1-3 libevent-2.1-7t64 libexpat1 libfreetype6
      libharfbuzz-subset0 libharfbuzz0b libjpeg62-turbo liblcms2-2 libminizip1t64
      libnspr4 libnss3 libopenjp2-7 libopus0 libpng16-16t64 libsnappy1v5
      libtiff6 libwebp7 libwebpdemux2 libwebpmux3'

# Asked every time, not only on a first install: the libraries live in the
# container layer rather than on the volume, so a recreated container has lost
# them, and removing another extension can take them out from under a calibre
# that is still sitting on the data volume.
have_libraries() {
    for one in libnss3 libegl1 libgl1 libxcomposite1; do
        dpkg-query -W -f='${Status}' "$one" 2>/dev/null | grep -q 'ok installed' || return 1
    done
    return 0
}

stage packages running
if have_libraries; then
    say 'the libraries calibre draws with are already here'
else
    say 'installing the libraries calibre draws with'
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $LIBS
    rm -rf /var/lib/apt/lists/*
fi
stage packages done

if [ -x "${APP}/ebook-convert" ]; then
    say "already installed under ${APP}"
    stage download done
    stage install done
else

    case "$(uname -m)" in
        x86_64|amd64) ARCH=x86_64 ;;
        aarch64|arm64) ARCH=arm64 ;;
        *)
            stage download failed "calibre has no build for $(uname -m)"
            stage run failed
            say "calibre publishes no build for $(uname -m) — leaving it unavailable"
            exit 0
            ;;
    esac

    URL="${CALIBRE_URL:-https://calibre-ebook.com/dist/linux-${ARCH}}"

    stage download running 0
    say "asking ${URL} what the current version is"

    RESOLVED="$(curl -fsSLI "$URL" -o /dev/null -w '%{url_effective}' 2>/dev/null || true)"
    [ -n "$RESOLVED" ] && URL="$RESOLVED"
    say "fetching ${URL}"

    TOTAL="$(curl -fsSLI "$URL" 2>/dev/null \
        | awk 'tolower($1) == "content-length:" { print $2 }' | tr -d '\r' | tail -1)"
    case "$TOTAL" in
        ''|*[!0-9]*) TOTAL=0 ;;
    esac
    [ "$TOTAL" -gt 0 ] && say "$((TOTAL / 1048576))MB to fetch"

    mkdir -p "$PREFIX"
    chown "${RUN_UID}:${RUN_GID}" "$PREFIX"

    curl -fsSL --retry 3 --retry-delay 5 -o "$ARCHIVE" "$URL" &
    CURL_PID=$!

    while kill -0 "$CURL_PID" 2>/dev/null; do
        sleep 5
        kill -0 "$CURL_PID" 2>/dev/null || break
        HAVE="$(wc -c < "$ARCHIVE" 2>/dev/null | tr -d ' ' || true)"
        case "$HAVE" in
            ''|*[!0-9]*) HAVE=0 ;;
        esac
        if [ "$TOTAL" -gt 0 ]; then
            stage download running "$((HAVE * 100 / TOTAL))"
            say "downloading: $((HAVE * 100 / TOTAL))%  $((HAVE / 1048576))MB of $((TOTAL / 1048576))MB"
        else
            say "downloading: $((HAVE / 1048576))MB so far"
        fi
    done

    if ! wait "$CURL_PID"; then
        stage download failed 'that URL would not hand it over'
        say 'that URL would not hand it over — leaving calibre unavailable'
        say 'set CALIBRE_URL to a copy this container can reach if the download'
        say 'site is unreachable from here'
        rm -f "$ARCHIVE"
        stage run failed
        exit 0
    fi

    stage download done 100
    say "downloaded $(( $(wc -c < "$ARCHIVE") / 1048576 ))MB"

    stage install running
    say "unpacking into ${APP}"
    rm -rf "$APP"
    mkdir -p "$APP"
    if ! tar -xJf "$ARCHIVE" -C "$APP"; then
        stage install failed 'the archive would not unpack'
        say 'the archive would not unpack — leaving calibre unavailable'
        rm -rf "$APP" "$ARCHIVE"
        stage run failed
        exit 0
    fi
    rm -f "$ARCHIVE"

    # The same prunes the image used to do at build time: translations no
    # conversion reads, and the runtime for a feature this server never calls.
    find "${APP}/resources/localization" -name '*.mo' -delete 2>/dev/null || true
    rm -f "${APP}/resources/localization/locales.zip"
    find "${APP}/translations/qtwebengine_locales" -type f ! -name 'en-US.pak' -delete 2>/dev/null || true
    rm -f "${APP}/lib/libonnxruntime.so"*
    rm -rf "${APP}/man-pages"
    find "$APP" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

    chown -R "${RUN_UID}:${RUN_GID}" "$PREFIX" 2>/dev/null || true
    stage install done
    say "installed $(du -sh "$APP" 2>/dev/null | cut -f1)"
fi

link_binaries

stage plugins running

mkdir -p "$CONFIG_DIR"

# The two KFX plugins ride in the image but cannot be registered while it is
# built, because there is no calibre there to register them with. This is the
# first moment one exists. KFX Input reads a KFX file on its own; KFX Output
# needs the Kindle Previewer, which is the kfx extension's job.
REGISTERED=''
for kind in input output; do
    ZIP="/opt/s2e/kfx-${kind}.zip"
    [ -s "$ZIP" ] || continue
    if HOME="$PREFIX" CALIBRE_CONFIG_DIRECTORY="$CONFIG_DIR" "${APP}/calibre-customize" -a "$ZIP" >/dev/null 2>&1; then
        REGISTERED="${REGISTERED} ${kind}"
    else
        say "the KFX ${kind} plugin would not register"
    fi
done

chown -R "${RUN_UID}:${RUN_GID}" "$CONFIG_DIR" 2>/dev/null || true

if [ -n "$REGISTERED" ]; then
    say "registered the KFX plugins:${REGISTERED}"
else
    say 'this image carries no KFX plugins, so KFX will stay refused'
fi
stage plugins done

stage verify running

if HOME="$PREFIX" "${APP}/ebook-convert" --version >/dev/null 2>&1; then
    stage verify done
    stage run done
    say "$(HOME="$PREFIX" "${APP}/ebook-convert" --version 2>/dev/null | head -1) answers"
    say 'MOBI, AZW3, PDF, TXT and HTMLZ are offered from now on'
else
    stage verify failed 'it will not run'
    stage run failed
    say 'it unpacked but will not run — leaving calibre unavailable'
fi
