#!/bin/sh
# Runs as root only long enough to install what the operator asked for, then
# hands the server to an unprivileged user and never comes back.
set -eu

log() {
    printf '%s entrypoint: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

RUN_AS_UID="${PUID:-$(id -u node)}"
RUN_AS_GID="${PGID:-$(id -g node)}"

install_packages() {
    packages="$1"
    [ -n "$packages" ] || return 0

    # Pipe separated, the way linuxserver's images spell it, so a list copied
    # from one of those works here without being re-punctuated.
    list="$(printf '%s' "$packages" | tr '|' ' ')"
    log "installing packages: ${list}"
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $list
    rm -rf /var/lib/apt/lists/*
}

# An extension is an OCI image whose layers are a tarball rooted at /. There is
# no docker daemon in here, so the registry is asked directly: a token, the
# manifest, then each blob.
install_extension() {
    ref="$1"
    case "$ref" in
        */*) : ;;
        *) log "skipping '${ref}': an extension is named registry/owner/name:tag" ; return 0 ;;
    esac

    registry="ghcr.io"
    case "$ref" in
        *.*/*|localhost/*) registry="${ref%%/*}" ; ref="${ref#*/}" ;;
    esac

    tag="latest"
    case "$ref" in
        *:*) tag="${ref##*:}" ; ref="${ref%:*}" ;;
    esac

    log "fetching ${registry}/${ref}:${tag}"

    token="$(curl -fsSL "https://${registry}/token?scope=repository:${ref}:pull&service=${registry}" \
        | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    [ -n "$token" ] || { log "no pull token for ${ref} — skipping"; return 0; }

    accept='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
    manifest="$(curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: ${accept}" \
        "https://${registry}/v2/${ref}/manifests/${tag}")" || {
        log "could not read the manifest for ${ref} — skipping"
        return 0
    }

    # An index points at per-architecture manifests; follow the first one, since
    # an extension for this image is built for the same architectures it is.
    case "$manifest" in
        *'"manifests"'*)
            digest="$(printf '%s' "$manifest" | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\(sha256:[a-f0-9]*\)".*/\1/p' | head -1)"
            manifest="$(curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: ${accept}" \
                "https://${registry}/v2/${ref}/manifests/${digest}")" || return 0
            ;;
    esac

    layers="$(printf '%s' "$manifest" \
        | tr ',' '\n' \
        | sed -n 's/.*"digest"[[:space:]]*:[[:space:]]*"\(sha256:[a-f0-9]\{64\}\)".*/\1/p')"
    [ -n "$layers" ] || { log "no layers in ${ref} — skipping"; return 0; }

    for blob in $layers; do
        curl -fsSL -H "Authorization: Bearer ${token}" \
            "https://${registry}/v2/${ref}/blobs/${blob}" \
            | tar -xz -C / 2>/dev/null || true
    done
}

# Everything is unpacked before anything is run, so an extension can rely on
# another being present, and a script baked into a derived image or mounted in
# by hand runs on the same footing as one that arrived in a layer.
run_extension_scripts() {
    for script in /etc/s2e/extensions/*.sh; do
        [ -f "$script" ] || continue

        log "running ${script}"
        chmod +x "$script" 2>/dev/null || true
        sh "$script" || log "${script} failed — carrying on without it"
        rm -f "$script" 2>/dev/null || true
    done
}

if [ "$(id -u)" = "0" ]; then
    install_packages "${EXTENSION_PACKAGES:-}"

    for name in $(printf '%s' "${EXTENSIONS:-}" | tr '|' ' '); do
        install_extension "$name"
    done
    run_extension_scripts

    for dir in /data /data/uploads /data/db /data/queue /data/library /opt/calibre-config; do
        [ -d "$dir" ] || mkdir -p "$dir"
    done
    chown -R "${RUN_AS_UID}:${RUN_AS_GID}" /data /opt/calibre-config 2>/dev/null || true

    exec setpriv --reuid="${RUN_AS_UID}" --regid="${RUN_AS_GID}" --init-groups --inh-caps=-all -- "$@"
fi

# Already unprivileged: nothing above could have run anyway, so say so once
# rather than failing halfway through an install.
if [ -n "${EXTENSIONS:-}${EXTENSION_PACKAGES:-}" ]; then
    log "EXTENSIONS needs the container to start as root; ignoring them"
fi

exec "$@"
