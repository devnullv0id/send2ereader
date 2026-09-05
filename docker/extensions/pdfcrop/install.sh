#!/bin/sh
set -eu

PREFIX="${PDFCROP_PREFIX:-/data/pdfcrop}"
VENV="${PREFIX}/venv"

RUN_UID="${PUID:-$(id -u node)}"
RUN_GID="${PGID:-$(id -g node)}"

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

stage run install

if [ -x "${VENV}/bin/pdfcropmargins" ]; then
    say "already installed under ${PREFIX}"
    stage packages done
    stage install done
else
    stage packages running
    say 'installing python and its venv module'
    if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
        apt-get update
        apt-get install -y --no-install-recommends python3 python3-venv
        rm -rf /var/lib/apt/lists/*
    fi
    stage packages done

    stage install running
    say "building a python environment under ${PREFIX}"
    mkdir -p "$PREFIX"
    chown "${RUN_UID}:${RUN_GID}" "$PREFIX"
    rm -rf "$VENV"
    python3 -m venv "$VENV"

    say 'installing pdfCropMargins — a minute or so'
    if ! "${VENV}/bin/pip" install --no-cache-dir --disable-pip-version-check -q pdfCropMargins; then
        stage install failed 'pip would not install it'
        stage run failed
        say 'pip would not install it — leaving PDF cropping unavailable'
        exit 0
    fi

    rm -rf "${VENV}/lib/python"*/site-packages/pip \
           "${VENV}/lib/python"*/site-packages/pip-* \
           "${VENV}/lib/python"*/site-packages/setuptools \
           "${VENV}/lib/python"*/site-packages/setuptools-* 2>/dev/null || true

    chown -R "${RUN_UID}:${RUN_GID}" "$PREFIX" 2>/dev/null || true
    stage install done
    say "installed $(du -sh "$PREFIX" 2>/dev/null | cut -f1)"
fi

stage verify running
ln -sf "${VENV}/bin/pdfcropmargins" /usr/local/bin/pdfcropmargins

if "${VENV}/bin/pdfcropmargins" --version >/dev/null 2>&1; then
    stage verify done
    stage run done
    say 'pdfCropMargins answers — PDF cropping is offered'
else
    stage verify failed 'it will not run'
    stage run failed
    say 'it installed but will not run — PDF cropping stays unavailable'
fi
