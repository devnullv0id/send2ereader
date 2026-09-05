#!/bin/sh
set -eu

PREFIX="${PDFCROP_PREFIX:-/data/pdfcrop}"
VENV="${PREFIX}/venv"

say() {
    printf 'pdfcrop: %s\n' "$*" >&2
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
SIZE="$(du -sm "$VENV" 2>/dev/null | cut -f1 || echo 0)"
say "deleting the python environment under ${VENV}"
# only the venv, never $PREFIX itself — the progress this page is reading
# lives beside it, and taking the directory would leave the page waiting.
rm -rf "$VENV"
rm -f /usr/local/bin/pdfcropmargins
stage install done

stage packages running
say 'leaving python where it is — the server and the layout fix both use it'
stage packages done

stage verify running
if command -v pdfcropmargins >/dev/null 2>&1; then
    say 'something still answers to pdfcropmargins — cropping may stay offered'
    stage verify failed 'it is still on PATH'
    stage run failed
else
    say "pdfCropMargins is gone, and ${SIZE}MB came back"
    stage verify done
    stage run done
fi
