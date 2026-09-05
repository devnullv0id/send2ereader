#!/bin/sh
set -eu

. /usr/local/lib/s2e/extensions-lib.sh

S2E_TAG=agent
PROGRESS_DIR=/data
POLL_SECONDS=2

mkdir -p "$S2E_STATE_DIR"
chown "${RUN_AS_UID}:${RUN_AS_GID}" "$S2E_STATE_DIR" 2>/dev/null || true

progress_file() { printf '%s/%s/%s.progress' "$PROGRESS_DIR" "$1" "$1"; }
log_file() { printf '%s/%s/%s.log' "$PROGRESS_DIR" "$1" "$1"; }

known() {
    case "$1" in
        calibre|pdfcrop|kfx) return 0 ;;
        *) return 1 ;;
    esac
}

start_run() {
    name="$1"
    mkdir -p "${PROGRESS_DIR}/${name}"
    : > "$(progress_file "$name")"
    : > "$(log_file "$name")"
    chown -R "${RUN_AS_UID}:${RUN_AS_GID}" "${PROGRESS_DIR}/${name}" 2>/dev/null || true
}

stage() {
    printf '%s %s %s\n' "$1" "$2" "${3:-}" >> "$S2E_PROGRESS"
}

remember() {
    grep -qxF "$1" "$S2E_ENABLED_FILE" 2>/dev/null && return 0
    printf '%s\n' "$1" >> "$S2E_ENABLED_FILE"
    chown "${RUN_AS_UID}:${RUN_AS_GID}" "$S2E_ENABLED_FILE" 2>/dev/null || true
}

forget() {
    [ -f "$S2E_ENABLED_FILE" ] || return 0
    grep -vxF "$1" "$S2E_ENABLED_FILE" > "${S2E_ENABLED_FILE}.next" 2>/dev/null || true
    mv "${S2E_ENABLED_FILE}.next" "$S2E_ENABLED_FILE"
    chown "${RUN_AS_UID}:${RUN_AS_GID}" "$S2E_ENABLED_FILE" 2>/dev/null || true
}

# The image carries every installer, so asking for one from the browser does not
# depend on a registry being reachable or a package being published. A copy kept
# from an earlier EXTENSIONS run wins, then the baked-in one.
script_for() {
    name="$1"
    kept="$(kept_script_for "$name" || true)"
    if [ -n "$kept" ]; then
        printf '%s' "$kept"
        return 0
    fi
    [ -f "/opt/s2e/install-${name}.sh" ] || return 1
    printf '%s' "/opt/s2e/install-${name}.sh"
}

install_one() {
    name="$1"
    start_run "$name"
    S2E_PROGRESS="$(progress_file "$name")"
    export S2E_PROGRESS

    script="$(script_for "$name" || true)"
    if [ -z "$script" ]; then
        stage packages failed "this image carries no installer for ${name}"
        stage run failed
        return 0
    fi

    remember "$name"
    S2E_LOG="$(log_file "$name")" sh "$script" || {
        stage verify failed 'the installer stopped early'
        stage run failed
    }
}

remove_one() {
    name="$1"
    start_run "$name"
    S2E_PROGRESS="$(progress_file "$name")"
    export S2E_PROGRESS

    forget "$name"
    script="/opt/s2e/remove-${name}.sh"
    if [ -f "$script" ]; then
        S2E_LOG="$(log_file "$name")" sh "$script" || {
            stage verify failed 'the removal stopped early'
            stage run failed
        }
    else
        stage verify failed "this image carries no removal script for ${name}"
        stage run failed
    fi
}

SPOOL="${S2E_STATE_DIR}/spool"
RUNNING="${S2E_STATE_DIR}/running"

log "watching ${S2E_REQUEST_FILE}"

while true; do
    if [ -f "$S2E_REQUEST_FILE" ]; then
        # Moved rather than read in place: the setup assistant asks for all
        # three at once, and the server may append another line while this is
        # working. Anything that arrives after the move is picked up next time
        # round, and nothing is read half-written.
        mv "$S2E_REQUEST_FILE" "$SPOOL"
        cp "$SPOOL" "$SPOOL.reading"

        while IFS= read -r request || [ -n "$request" ]; do
            [ -n "$request" ] || continue
            log "request: ${request}"

            printf '%s\n' "$request" > "$RUNNING"

            # The server reads the spool to know what is still waiting, so it
            # has to shrink as each one is taken off it.
            tail -n +2 "$SPOOL" > "${SPOOL}.rest" 2>/dev/null || : > "${SPOOL}.rest"
            mv "${SPOOL}.rest" "$SPOOL"

            verb="${request%% *}"
            name="${request#* }"

            if known "$name"; then
                case "$verb" in
                    install) install_one "$name" || log 'the install stopped early' ;;
                    remove)  remove_one "$name"  || log 'the removal stopped early' ;;
                    *)       log "ignoring a request nobody understands: ${request}" ;;
                esac
            else
                log "ignoring a request nobody understands: ${request}"
            fi

            rm -f "$RUNNING"
        done < "$SPOOL.reading"

        rm -f "$SPOOL" "$SPOOL.reading"
    fi
    sleep "$POLL_SECONDS"
done
