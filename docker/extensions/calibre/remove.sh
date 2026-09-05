#!/bin/sh
set -eu

PREFIX="${CALIBRE_PREFIX:-/data/calibre}"
APP="${PREFIX}/app"

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

stage run remove

stage install running
SIZE="$(du -sm "$APP" 2>/dev/null | cut -f1 || echo 0)"
say "deleting calibre from ${APP}"
rm -rf "$APP" "${PREFIX}/calibre.txz"
for name in $BINARIES; do
    rm -f "/usr/local/bin/${name}"
done
stage install done

stage plugins running
say 'leaving the plugin registrations where they are — reinstalling calibre'
say 'writes them again, and they cost kilobytes'
stage plugins done

stage packages running
say 'leaving the Debian libraries where they are — apt shares them with'
say 'anything else installed here'
stage packages done

stage download done

stage verify running
if command -v ebook-convert >/dev/null 2>&1; then
    say 'something still answers to ebook-convert — the formats may stay offered'
    stage verify failed 'it is still on PATH'
    stage run failed
else
    say "calibre is gone, and ${SIZE}MB came back"
    say 'this server now sends EPUB and KEPUB only'
    stage verify done
    stage run done
fi
