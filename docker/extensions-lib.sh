S2E_KEEP_DIR=/opt/s2e/extensions
S2E_STATE_DIR=/data/extensions
S2E_ENABLED_FILE="${S2E_STATE_DIR}/enabled"
S2E_REQUEST_FILE="${S2E_STATE_DIR}/request"

RUN_AS_UID="${PUID:-$(id -u node)}"
RUN_AS_GID="${PGID:-$(id -g node)}"

log() {
    printf '%s %s: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${S2E_TAG:-entrypoint}" "$*" >&2
}

install_packages() {
    packages="$1"
    [ -n "$packages" ] || return 0

    list="$(printf '%s' "$packages" | tr '|' ' ')"
    log "installing packages: ${list}"
    apt-get update
    # shellcheck disable=SC2086
    apt-get install -y --no-install-recommends $list
    rm -rf /var/lib/apt/lists/*
}

S2E_BUILTINS='calibre pdfcrop kfx'

builtin_extension() {
    case " ${S2E_BUILTINS} " in
        *" $1 "*) return 0 ;;
        *) return 1 ;;
    esac
}

remember_extension() {
    mkdir -p "$S2E_STATE_DIR"
    grep -qxF "$1" "$S2E_ENABLED_FILE" 2>/dev/null && return 0
    printf '%s
' "$1" >> "$S2E_ENABLED_FILE"
    chown "${RUN_AS_UID}:${RUN_AS_GID}" "$S2E_ENABLED_FILE" 2>/dev/null || true
}

install_extension() {
    ref="$1"

    if builtin_extension "$ref"; then
        log "${ref} is carried by this image — installing it from here"
        remember_extension "$ref"
        return 0
    fi

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

    body="$(mktemp)"
    status="$(curl -fsSL -o "$body" -w '%{http_code}' \
        "https://${registry}/token?scope=repository:${ref}:pull&service=${registry}" || true)"
    token="$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$body")"
    rm -f "$body"

    if [ -z "$token" ]; then
        case "$status" in
            401|403)
                log "${registry}/${ref} refused an anonymous pull (HTTP ${status})."
                log "  ${registry} answers this both for a package that does not exist and"
                log "  for one that is private. Check it is published and its visibility is"
                log "  public, or that the name is spelt the way the registry has it."
                ;;
            404) log "${registry}/${ref} does not exist (HTTP 404)" ;;
            000) log "could not reach ${registry} at all — no network from this container?" ;;
            *)   log "${registry} would not issue a pull token for ${ref} (HTTP ${status})" ;;
        esac
        log "carrying on without ${ref}"
        return 0
    fi

    accept='application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'
    manifest="$(curl -fsSL -H "Authorization: Bearer ${token}" -H "Accept: ${accept}" \
        "https://${registry}/v2/${ref}/manifests/${tag}")" || {
        log "could not read the manifest for ${ref} — skipping"
        return 0
    }

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

# Builtins are queued so the server starts without waiting; any other script runs here, because the agent only answers for names it knows. The copy kept first is what makes a later reinstall possible.
queue_extension_scripts() {
    mkdir -p "$S2E_KEEP_DIR" "$S2E_STATE_DIR"
    for script in /etc/s2e/extensions/*.sh; do
        [ -f "$script" ] || continue

        base="$(basename "$script")"
        cp "$script" "${S2E_KEEP_DIR}/${base}" 2>/dev/null || true
        name="${base#*-}"
        name="${name%.sh}"

        if builtin_extension "$name"; then
            log "queueing ${name} for the agent to install once the server is up"
            printf 'install %s\n' "$name" >> "$S2E_REQUEST_FILE"
        else
            log "running ${script}"
            chmod +x "$script" 2>/dev/null || true
            sh "$script" || log "${script} failed — carrying on without it"
        fi
        rm -f "$script" 2>/dev/null || true
    done
}

kept_script_for() {
    name="$1"
    for script in "${S2E_KEEP_DIR}"/*"${name}"*.sh; do
        [ -f "$script" ] || continue
        printf '%s' "$script"
        return 0
    done
    return 1
}

# The prefixes are install order: pdfcrop and KFX are useless without calibre.
S2E_ORDER='10:calibre 20:pdfcrop 30:kfx'

stage_kept_scripts() {
    mkdir -p /etc/s2e/extensions
    wanted="$(enabled_extensions)"
    [ -n "$wanted" ] || return 0

    for pair in $S2E_ORDER; do
        prefix="${pair%%:*}"
        id="${pair#*:}"

        case " $wanted " in
            *" $id "*) : ;;
            *) continue ;;
        esac

        [ -f "/etc/s2e/extensions/${prefix}-${id}.sh" ] && continue

        if [ -f "${S2E_KEEP_DIR}/${prefix}-${id}.sh" ]; then
            cp "${S2E_KEEP_DIR}/${prefix}-${id}.sh" "/etc/s2e/extensions/${prefix}-${id}.sh"
            log "reinstalling ${id} from the copy kept on this image"
        elif [ -f "/opt/s2e/install-${id}.sh" ]; then
            cp "/opt/s2e/install-${id}.sh" "/etc/s2e/extensions/${prefix}-${id}.sh"
            log "reinstalling ${id} from the installer in this image"
        fi
    done
}

enabled_extensions() {
    [ -f "$S2E_ENABLED_FILE" ] || return 0
    tr '\n' ' ' < "$S2E_ENABLED_FILE"
}
