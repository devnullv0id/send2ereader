#!/bin/sh
set -eu

NAME="$1"
THREAD="$2"
OVERRIDE="$3"
OUT="$4"

say() { printf 'plugin: %s\n' "$*" >&2; }

: > "$OUT"

if [ -n "$OVERRIDE" ]; then
    URL="$OVERRIDE"
    say "${NAME}: using the URL given at build time"
else
    URL="https://plugins.calibre-ebook.com/${THREAD}.zip"
    say "${NAME}: ${URL}"
fi

if ! curl -fsSL -o "$OUT" "$URL"; then
    say "${NAME}: that would not download — the image ships without it"
    : > "$OUT"
    exit 0
fi

case "$(head -c 2 "$OUT")" in
    PK) : ;;
    *)
        say "${NAME}: what came back is not a zip — the image ships without it"
        : > "$OUT"
        exit 0
        ;;
esac

if ! unzip -l "$OUT" | grep -q 'plugin-import-name-'; then
    say "${NAME}: that zip is not a calibre plugin — the image ships without it"
    : > "$OUT"
    exit 0
fi

say "${NAME}: $(( $(wc -c < "$OUT") / 1024 ))KB"
