#!/usr/bin/env bash
# lib_rollback.sh — fail-closed `current` symlink rollback for deploy_release.sh
# (FIX-06.2.1 §B/§10/§11).
#
# Sourced by deploy_release.sh (and by the regression tests).  Implements the
# exact contract for undoing a failed release switch:
#
#   rollback_current <failed_new_release_dir> <previous_release_dir_or_empty>
#
#   The ownership gate runs FIRST and is common to both actions: `current`
#   must still resolve EXACTLY to <failed_new_release_dir>, or the rollback
#   REFUSES (non-zero, no mutation).  Only after that gate:
#   CASE 1 — previous release given and valid (upgrade):
#       current → previous release (atomically restore old symlink).  0.
#   CASE 2 — previous empty (first deploy):
#       current is REMOVED (rm -f on the verified symlink only).  0.  The
#       failed release directory is kept for diagnostics (never deleted).
#   REFUSE covers: current not a symlink, current not resolving to the failed
#   release, or a non-empty previous that is not a valid directory (a missing
#   previous must never be treated as a first deploy).
#
# Safety rules:
#   - NEVER rm -rf: only `rm -f` on a symlink we verified.
#   - The move path (ln -sfn + mv -Tf over a staging name) is atomic: an
#     interrupted operation never leaves `current` partially switched.
#   - An unknown `current` target is never overwritten (a concurrent operator
#     may have just switched it).
#
# Reads $DEPLOY_ROOT (exported by deploy_release.sh / tests).

rollback_current() {
    local new_release="${1:-}"
    local previous="${2:-}"
    local link="${DEPLOY_ROOT}/current"
    local resolved_new resolved_current resolved_previous

    resolved_new="$(readlink -f "$new_release" 2>/dev/null || echo "")"
    resolved_current="$(readlink -f "$link" 2>/dev/null || echo "")"

    # FIX-06.2.1a — compare-before-mutate ownership guard.  Runs BEFORE any
    # mutation and is COMMON to both rollback actions: a rollback is only
    # allowed while `current` still resolves EXACTLY to the release that just
    # failed.  If another operator has since switched `current` (or the
    # original switch never happened), refuse — never clobber an unknown
    # target.  (This is a compare-before-mutate guard, not a kernel CAS: a
    # truly concurrent deploy needs a deploy lock / flock around the whole
    # transaction — out of scope here.)
    if [[ ! -L "$link" || -z "$resolved_new" || "$resolved_current" != "$resolved_new" ]]; then
        echo "      ✗ REFUSE rollback: current ($resolved_current) does not resolve to the failed release ($resolved_new); no destructive action taken." >&2
        return 1
    fi

    # `previous` semantics: empty = FIRST deploy; non-empty = UPGRADE.  A
    # non-empty previous that is not a valid directory is a misconfiguration —
    # refuse, and NEVER degrade into the first-deploy unlink (that would
    # wrongly remove `current`).
    if [[ -n "$previous" ]]; then
        resolved_previous="$(readlink -f "$previous" 2>/dev/null || echo "")"
        if [[ -z "$resolved_previous" || ! -d "$previous" ]]; then
            echo "      ✗ REFUSE rollback: previous release '$previous' provided but not a valid directory — not treating as first deploy; no destructive action taken." >&2
            return 1
        fi
        # CASE 1 — upgrade: atomically restore the previous release (staging
        # link + mv -Tf: `current` is never temporarily absent).
        local next="${DEPLOY_ROOT}/current.rollback.$$"
        ln -sfn "$previous" "$next"
        mv -Tf "$next" "$link"
        echo "      ✓ current restored → $previous"
        return 0
    fi

    # CASE 2 — first deploy (no previous): unlink ONLY the failed release
    # (ownership already validated above).  The failed release directory is
    # kept for diagnostics — never deleted.
    rm -f "$link"
    echo "      ✓ current removed (first deploy; failed release never stays current)"
    return 0
}