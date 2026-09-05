#!/bin/sh
# Installs Wine, Amazon's Kindle Previewer and calibre's KFX Output plugin, so
# this server can write KFX. None of it is in the image: the Previewer is not
# ours to redistribute, and Wine is several hundred megabytes nobody who only
# wants EPUB should carry.
#
# It runs as root at container start, before the server exists. It is slow the
# first time and a no-op afterwards, because everything lands under /data.
set -eu

PREFIX="${KFX_PREFIX:-/data/kfx}"
WINEPREFIX="${PREFIX}/wine"
INSTALLER_URL="${KFX_PREVIEWER_URL:-}"
PLUGIN_URL="${KFX_OUTPUT_PLUGIN_URL:-}"

say() { printf 'kfx: %s\n' "$*" >&2; }

if [ -f "${PREFIX}/.installed" ]; then
    say "already installed under ${PREFIX}"
    exit 0
fi

# No default download. Amazon's own URL answers 403 to anything that is not a
# browser, and fetching their installer is the operator's act to take, not ours
# to take on their behalf.
if [ -z "$INSTALLER_URL" ]; then
    say 'set KFX_PREVIEWER_URL to a Kindle Previewer installer this container can'
    say 'reach. Amazon answers 403 to anything that is not a browser, so host a'
    say 'copy yourself. Nothing to do without one; KFX stays unavailable.'
    exit 0
fi

say 'installing wine — this takes a while the first time'
dpkg --add-architecture i386
apt-get update
apt-get install -y --no-install-recommends wine wine32 wine64 xvfb cabextract
rm -rf /var/lib/apt/lists/*

mkdir -p "$PREFIX"

say "fetching the Previewer from ${INSTALLER_URL}"
if ! curl -fsSL -o "${PREFIX}/installer.exe" "$INSTALLER_URL"; then
    say 'that URL would not hand it over — leaving KFX unavailable'
    exit 0
fi

say 'running the installer under wine'
export WINEPREFIX
export WINEDEBUG=-all
xvfb-run -a wine "${PREFIX}/installer.exe" /S || say 'the installer exited badly; checking anyway'
rm -f "${PREFIX}/installer.exe"

KPV="$(find "$WINEPREFIX" -iname 'Kindle Previewer 3.exe' 2>/dev/null | head -1 || true)"
if [ -z "$KPV" ]; then
    say 'the Previewer is not where it should be — leaving KFX unavailable'
    exit 0
fi
say "found ${KPV}"

# calibre's KFX Output plugin is what actually calls the Previewer. It is
# distributed by its author, not by us, so the URL is the operator's to give.
if [ -n "$PLUGIN_URL" ]; then
    say 'installing the KFX Output plugin'
    curl -fsSL -o /tmp/kfx-output.zip "$PLUGIN_URL"
    calibre-customize -a /tmp/kfx-output.zip
    rm -f /tmp/kfx-output.zip
else
    say 'no KFX_OUTPUT_PLUGIN_URL given, so calibre has nothing to drive it with'
fi

if calibre-customize --list-plugins | grep -qi 'KFX Output'; then
    say 'KFX Output is installed'
else
    say 'KFX Output did not install — the Convert page will keep refusing KFX'
    exit 0
fi

chown -R "${PUID:-node}:${PGID:-node}" "$PREFIX" 2>/dev/null || true
touch "${PREFIX}/.installed"
say 'done'
