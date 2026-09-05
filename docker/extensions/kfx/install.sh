#!/bin/sh
set -eu

PREFIX="${KFX_PREFIX:-/data/kfx}"
WINEPREFIX="${PREFIX}/wine"
DEFAULT_INSTALLER_URL='https://d2bzeorukaqrvt.cloudfront.net/KindlePreviewerInstaller.exe'
INSTALLER_URL="${KFX_PREVIEWER_URL:-$DEFAULT_INSTALLER_URL}"
PLUGIN_URL="${KFX_OUTPUT_PLUGIN_URL:-}"

RUN_UID="${PUID:-$(id -u node)}"
RUN_GID="${PGID:-$(id -g node)}"

say() {
    printf 'kfx: %s\n' "$*" >&2
    [ -n "${S2E_LOG:-}" ] && printf '%s\n' "$*" >> "$S2E_LOG"
    return 0
}

stage() {
    [ -n "${S2E_PROGRESS:-}" ] || return 0
    printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$S2E_PROGRESS"
    return 0
}

as_user() {
    setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --init-groups --inh-caps=-all -- \
        env HOME="$PREFIX" WINEPREFIX="$WINEPREFIX" WINEDEBUG=-all WINEARCH=win64 \
        WINEDLLOVERRIDES='mscoree,mshtml=' DISPLAY="${DISPLAY:-:99}" \
        XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}" "$@"
}

ensure_display() {
    if [ ! -S /tmp/.X11-unix/X99 ]; then
        Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp -ac >/dev/null 2>&1 &
        sleep 3
    fi
    DISPLAY=:99
    export DISPLAY
}

find_previewer() {
    find "$WINEPREFIX" -iname 'Kindle Previewer 3.exe' 2>/dev/null | head -1 || true
}

stage run install

X_LIBS='xvfb xauth cabextract libgl1 libgl1-mesa-dri libdrm2 libgbm1 libegl1 libopengl0
        libxkbcommon-x11-0 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libxi6 libxcursor1
        libxinerama1 libxfixes3 libxrender1 libxext6'

if ! command -v wine >/dev/null 2>&1; then
    stage packages running
    say 'installing wine — this takes a while the first time'
    dpkg --add-architecture i386
    apt-get update
    apt-get install -y --no-install-recommends ca-certificates curl gnupg2

    mkdir -pm755 /etc/apt/keyrings
    curl -fsSLo /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key
    curl -fsSLo /etc/apt/sources.list.d/winehq-trixie.sources \
        https://dl.winehq.org/wine-builds/debian/dists/trixie/winehq-trixie.sources
    apt-get update

    # shellcheck disable=SC2086
    if apt-get install -y --no-install-recommends winbind winehq-staging $X_LIBS; then
        say "installed $(wine --version 2>/dev/null || echo wine)"
        stage packages done
    else
        say 'winehq would not install, falling back to the version debian ships'
        stage packages running
        # shellcheck disable=SC2086
        apt-get install -y --no-install-recommends wine wine32 wine64 winbind $X_LIBS
    fi
    rm -rf /var/lib/apt/lists/*
fi

install -d -m 1777 /tmp/.X11-unix
XDG_RUNTIME_DIR="/run/user/${RUN_UID}"
install -d -m 700 -o "$RUN_UID" -g "$RUN_GID" "$XDG_RUNTIME_DIR"
export XDG_RUNTIME_DIR

mkdir -p "$PREFIX"
chown "${RUN_UID}:${RUN_GID}" "$PREFIX"

KPV="$(find_previewer)"

if [ -n "$KPV" ]; then
    say "the Previewer is already installed: ${KPV}"
    stage packages done
    stage download done
    stage prefix done
    stage previewer done
else
    stage packages done
    stage download running 0
    say "fetching the Previewer from ${INSTALLER_URL}"

    TOTAL="$(curl -fsSLI "$INSTALLER_URL" 2>/dev/null \
        | awk 'tolower($1) == "content-length:" { print $2 }' | tr -d '\r' | tail -1)"
    case "$TOTAL" in
        ''|*[!0-9]*) TOTAL=0 ;;
    esac

    if [ "$TOTAL" -gt 0 ]; then
        say "$((TOTAL / 1048576))MB to fetch"
    else
        say 'a few hundred megabytes to fetch'
    fi

    curl -fsSL --retry 3 --retry-delay 5 -o "${PREFIX}/installer.exe" "$INSTALLER_URL" &
    CURL_PID=$!

    while kill -0 "$CURL_PID" 2>/dev/null; do
        sleep 10
        kill -0 "$CURL_PID" 2>/dev/null || break
        HAVE="$(wc -c < "${PREFIX}/installer.exe" 2>/dev/null | tr -d ' ' || true)"
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
        say 'that URL would not hand it over — leaving KFX unavailable'
        say 'set KFX_PREVIEWER_URL to a copy this container can reach if Amazon'
        say 'has moved it'
        rm -f "${PREFIX}/installer.exe"
        stage run failed
        exit 0
    fi

    stage download done 100
    say "downloaded $(( $(wc -c < "${PREFIX}/installer.exe") / 1048576 ))MB"

    case "$(head -c 2 "${PREFIX}/installer.exe")" in
        MZ) : ;;
        *)
            say 'what came back is not a Windows executable — an error page, most'
            say 'likely. Leaving KFX unavailable.'
            rm -f "${PREFIX}/installer.exe"
            stage run failed
            exit 0
            ;;
    esac

    chown "${RUN_UID}:${RUN_GID}" "${PREFIX}/installer.exe"

    ensure_display

    stage prefix running
    say 'preparing the wine prefix'
    as_user /usr/bin/wineboot --init >/dev/null 2>&1 \
        || say 'wineboot complained; carrying on'

    stage prefix done
    stage previewer running
    say 'running the installer under wine'
    as_user /usr/bin/wine "${PREFIX}/installer.exe" /S \
        || say 'the installer exited badly; checking anyway'
    rm -f "${PREFIX}/installer.exe"

    KPV="$(find_previewer)"
    if [ -z "$KPV" ]; then
        stage previewer failed 'the Previewer is not where it should be'
        say 'the Previewer is not where it should be — leaving KFX unavailable'
        stage run failed
        exit 0
    fi
    stage previewer done
    say "installed ${KPV}"
fi

stage wire running

if ! grep -q 'Kindle Previewer 3' "${WINEPREFIX}/user.reg" 2>/dev/null; then
    KPV_DIR="$(dirname "$KPV")"
    WIN_DIR="$(printf '%s' "$KPV_DIR" | sed "s|^${WINEPREFIX}/drive_c|C:|" | tr '/' '\\')"
    {
        printf '\n[Software\\\\Amazon\\\\Kindle Previewer 3] 0\n'
        printf '@="%s"\n' "$(printf '%s' "$WIN_DIR" | sed 's|\\|\\\\|g')"
    } >> "${WINEPREFIX}/user.reg"
    say 'recorded the Previewer in the wine registry'
fi

chown -R "${RUN_UID}:${RUN_GID}" "$PREFIX" 2>/dev/null || true

USER_HOME="$(getent passwd "$RUN_UID" | cut -d: -f6)"
USER_HOME="${USER_HOME:-/home/node}"

if [ ! -L "${USER_HOME}/.wine" ] || [ "$(readlink "${USER_HOME}/.wine")" != "$WINEPREFIX" ]; then
    rm -rf "${USER_HOME}/.wine"
    mkdir -p "$USER_HOME"
    ln -sfn "$WINEPREFIX" "${USER_HOME}/.wine"
    chown -h "${RUN_UID}:${RUN_GID}" "${USER_HOME}/.wine" 2>/dev/null || true
    say "linked ${USER_HOME}/.wine to ${WINEPREFIX}"
fi

cat > /usr/local/bin/wine <<'WRAPPER'
#!/bin/sh
if [ ! -S /tmp/.X11-unix/X99 ]; then
    Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp -ac >/dev/null 2>&1 &
    sleep 3
fi
export DISPLAY="${DISPLAY:-:99}"
export WINEARCH="${WINEARCH:-win64}"
export WINEDLLOVERRIDES="${WINEDLLOVERRIDES:-mscoree,mshtml=}"
export WINEDEBUG="${WINEDEBUG:--all}"
exec /usr/bin/wine "$@"
WRAPPER
chmod +x /usr/local/bin/wine
say 'wine now brings its own display: the Previewer draws a window even when it'
say 'is only asked to convert, and calibre calls wine without one'

mkdir -p /etc/s2e
printf '%s\n' "$KPV" > /etc/s2e/kfx-previewer

stage wire done
stage verify running

if [ -n "$PLUGIN_URL" ]; then
    say 'installing the KFX Output plugin given at start'
    curl -fsSL -o /tmp/kfx-output.zip "$PLUGIN_URL"
    calibre-customize -a /tmp/kfx-output.zip
    rm -f /tmp/kfx-output.zip
fi

PLUGINS="$(calibre-customize --list-plugins 2>/dev/null || true)"
case "$PLUGINS" in
    *'KFX Output'*) HAS_OUTPUT=yes ;;
    *) HAS_OUTPUT=no ;;
esac

if [ "$HAS_OUTPUT" = yes ]; then
    stage verify done
    say 'KFX Output is present and the Previewer is installed — KFX is offered'
    stage run done
else
    stage verify failed 'this image has no KFX Output plugin'
    stage run failed
    say 'this image has no KFX Output plugin, so KFX stays refused. Images from'
    say '2.0.0 on carry it; set KFX_OUTPUT_PLUGIN_URL to add it to an older one.'
fi
