#!/usr/bin/env bash
# lib_env.sh — safe loader for the deployment env file (FIX-06.2 §24).
#
# Sourced by preflight.sh and deploy_release.sh.  Reads /etc/gsplatform/env
# (or $GS_ENV_FILE) as a *flat KEY=value* file WITHOUT shell expansion — a
# `source` of the file would interpret `$` and backticks in passwords, which
# would corrupt secrets.  Only well-formed lines (^KEY=value) are applied;
# comments and anything else are ignored.
#
# Usage:
#   . "${SCRIPT_DIR}/lib_env.sh"
#   load_gsplatform_env   # reads $GS_ENV_FILE (default /etc/gsplatform/env)
#
# The value is exported verbatim (leading/trailing whitespace stripped,
# one pair of surrounding quotes stripped).  Never printed to logs.
#
# If the operator already exported variables explicitly, an existing
# `GS_ENV_LOADED=1` in the environment skips loading (keep compatibility);
# otherwise the env file is the single source of truth and is loaded once.

GS_ENV_FILE="${GS_ENV_FILE:-/etc/gsplatform/env}"

load_gsplatform_env() {
    local file="${GS_ENV_FILE:-/etc/gsplatform/env}"
    if [[ "${GS_ENV_LOADED:-0}" == "1" ]]; then
        return 0
    fi
    if [[ ! -f "$file" ]]; then
        return 0
    fi
    local line key value trimmed
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip blank + comment lines; do NOT strip inline '#' (a password may
        # legitimately contain '#'); operator env files use whole-line comments.
        trimmed="${line#"${line%%[![:space:]]*}"}"
        [[ -n "$trimmed" && "$trimmed" == \#* ]] && continue
        [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
        key="${line%%=*}"
        value="${line#*=}"
        value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//; s/[[:space:]]*$//')"
        case "$value" in
            \"*\") value="${value%\"}"; value="${value#\"}" ;;
            \'*\') value="${value%\'}"; value="${value#\'}" ;;
        esac
        export "$key=$value"
    done < "$file"
    export GS_ENV_LOADED=1
}