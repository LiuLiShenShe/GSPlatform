#!/usr/bin/env bash
# lib_rollback.sh — fail-closed `current` symlink rollback for deploy_release.sh
# (FIX-06.2.1 §B/§10/§11).
#
# Sourced by deploy_release.sh (and by the regression tests).  Implements the
# exact contract for undoing a failed release switch:
#
#   rollback_current <failed_new_release_dir> <previous_release_dir_or_empty>
#
#   CASE 1 — previous release exists (upgrade):
#       current → previous release (restore old symlink).  Returns 0.
#   CASE 2 — first deploy, no previous release:
#       current is REMOVED, but ONLY when it is a symlink that resolves EXACTLY
#       to <failed_new_release_dir>.  Returns 0.  The failed release directory
#       itself is kept for diagnostics (never deleted by rollback).
#   default — current does not resolve to the failed release:
#       refuse: no destructive action, print why, return 1.
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
    local resolved_new resolved_current

    resolved_new="$(readlink -f "$new_release" 2>/dev/null || echo "")"
    resolved_current="$(readlink -f "$link" 2>/dev/null || echo "")"

    # CASE 1 — upgrade: restore the previous release.
    if [[ -n "$previous" && -d "$previous" ]]; then
        local next="${DEPLOY_ROOT}/current.rollback.$$"
        ln -sfn "$previous" "$next"
        mv -Tf "$next" "$link"
        echo "      ✓ current restored → $previous"
        return 0
    fi

    # CASE 2 — first deploy (no previous): unlink ONLY the failed release.
    if [[ -L "$link" && -n "$resolved_new" && "$resolved_current" == "$resolved_new" ]]; then
        rm -f "$link"
        echo "      ✓ current removed (first deploy; failed release never stays current)"
        return 0
    fi

    # default — refuse: never clobber an unknown / unrelated target.
    echo "      ✗ REFUSE rollback: current ($resolved_current) does not resolve to the failed release ($resolved_new); no destructive action taken." >&2
    return 1
}