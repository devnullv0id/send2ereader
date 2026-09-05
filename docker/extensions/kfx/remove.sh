#!/bin/sh
set -eu

PREFIX="${KFX_PREFIX:-/data/kfx}"
WINEPREFIX="${PREFIX}/wine"

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

WINE_PACKAGES='winehq-staging wine-staging wine-staging-amd64 wine-staging-i386
               wine wine32 wine64 winbind'
# Only what nothing else here uses. The X and GL libraries wine wanted are the
# same ones calibre's PDF renderer loads, and purging them by name left
# ebook-convert unable to import QWebEnginePage. Whatever was pulled in for
# wine alone is reclaimed by autoremove below instead.
KFX_ONLY='xvfb xauth cabextract'

stage run remove
stage previewer running
say 'stopping anything still running under wine'
pkill -9 -f wineserver 2>/dev/null || true
pkill -9 -f '/usr/bin/wine' 2>/dev/null || true
pkill -9 Xvfb 2>/dev/null || true
sleep 1

USER_HOME="$(getent passwd "$RUN_UID" | cut -d: -f6)"
USER_HOME="${USER_HOME:-/home/node}"

say "deleting the wine prefix and the Previewer under ${PREFIX}"
SIZE="$(du -sm "$PREFIX" 2>/dev/null | cut -f1 || echo 0)"
rm -rf "$WINEPREFIX" "${PREFIX}/installer.exe" "${PREFIX}/.installed"
rm -f "${USER_HOME}/.wine"
stage previewer done

stage wire running
say 'removing the wine wrapper and the marker the server reads'
rm -f /usr/local/bin/wine /etc/s2e/kfx-previewer
stage wire done

stage packages running
say 'purging wine — this reclaims the container layer'
# shellcheck disable=SC2086
apt-get purge -y $WINE_PACKAGES $KFX_ONLY >/dev/null 2>&1 || true
apt-get autoremove -y >/dev/null 2>&1 || true
rm -f /etc/apt/sources.list.d/winehq-trixie.sources /etc/apt/keyrings/winehq-archive.key
dpkg --remove-architecture i386 2>/dev/null || true
rm -rf /var/lib/apt/lists/*
stage packages done

stage verify running
if command -v wine >/dev/null 2>&1; then
    say 'wine is somehow still here — KFX will keep being refused either way'
else
    say "wine is gone, and ${SIZE}MB came back"
fi
stage verify done
stage run done
say 'KFX support removed'
