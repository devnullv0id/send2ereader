#!/bin/sh
set -eu

. /usr/local/lib/s2e/extensions-lib.sh

S2E_TAG=entrypoint

if [ "$(id -u)" = "0" ]; then
    install_packages "${EXTENSION_PACKAGES:-}"

    mkdir -p "$S2E_STATE_DIR"
    for name in $(printf '%s' "${EXTENSIONS:-}" | tr '|' ' ') $(enabled_extensions); do
        install_extension "$name"
    done
    stage_kept_scripts
    run_extension_scripts

    for dir in /data /data/uploads /data/db /data/queue /data/library /opt/calibre-config "$S2E_STATE_DIR"; do
        [ -d "$dir" ] || mkdir -p "$dir"
    done
    chown -R "${RUN_AS_UID}:${RUN_AS_GID}" /data /opt/calibre-config 2>/dev/null || true

    # Forked before the privilege drop below, so it keeps uid 0. setpriv replaces
    # this process image rather than its children, so the agent outlives it and
    # is the only thing left that can install anything once the server is up.
    S2E_TAG=agent /usr/local/bin/extension-agent &

    exec setpriv --reuid="${RUN_AS_UID}" --regid="${RUN_AS_GID}" --init-groups --inh-caps=-all -- "$@"
fi

if [ -n "${EXTENSIONS:-}${EXTENSION_PACKAGES:-}" ]; then
    log "EXTENSIONS needs the container to start as root; ignoring them"
fi

exec "$@"
