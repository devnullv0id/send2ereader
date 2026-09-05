#!/bin/sh
set -eu

. /usr/local/lib/s2e/extensions-lib.sh

S2E_TAG=entrypoint
RESTART_MARK="${DATA_DIR:-/data}/restart-requested"

serve() {
    rm -f "$RESTART_MARK" 2>/dev/null || true
    stopping=0
    while :; do
        "$@" &
        child=$!
        trap 'stopping=1; kill -TERM "$child" 2>/dev/null' TERM INT
        set +e
        wait "$child"
        code=$?
        while kill -0 "$child" 2>/dev/null; do
            wait "$child"
            code=$?
        done
        set -e
        trap - TERM INT
        if [ "$stopping" = 1 ]; then
            exit "$code"
        fi
        if [ -f "$RESTART_MARK" ]; then
            rm -f "$RESTART_MARK" 2>/dev/null || true
            log "the server asked to be restarted — starting it again"
            continue
        fi
        exit "$code"
    done
}

if [ "$(id -u)" = "0" ]; then
    install_packages "${EXTENSION_PACKAGES:-}"

    mkdir -p "$S2E_STATE_DIR"
    for name in $(printf '%s' "${EXTENSIONS:-}" | tr '|' ' ') $(enabled_extensions); do
        install_extension "$name"
    done
    stage_kept_scripts
    queue_extension_scripts

    for dir in /data /data/uploads /data/db /data/queue /data/library /data/languages /opt/calibre-config "$S2E_STATE_DIR"; do
        [ -d "$dir" ] || mkdir -p "$dir"
    done
    chown -R "${RUN_AS_UID}:${RUN_AS_GID}" /data /opt/calibre-config 2>/dev/null || true

    S2E_TAG=agent /usr/local/bin/extension-agent &

    serve setpriv --reuid="${RUN_AS_UID}" --regid="${RUN_AS_GID}" --init-groups --inh-caps=-all -- "$@"
fi

if [ -n "${EXTENSIONS:-}${EXTENSION_PACKAGES:-}" ]; then
    log "EXTENSIONS needs the container to start as root; ignoring them"
fi

serve "$@"
