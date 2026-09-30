/**
 * Dev-tunnel scene allowlist (FIX-05 §3-§6).
 *
 * The Cloudflare quick tunnel makes the dev origin reachable from the public
 * internet.  When the tunnel is enabled (``GS_ENABLE_DEV_TUNNEL=1``) the
 * ``/local-scenes/<slug>/*`` dev middleware must NOT keep serving every repo
 * scene — that would re-open FIX-01 P0-1 (unauthenticated scene bytes on the
 * public internet).  Only scenes explicitly listed in
 * ``XR_DEV_PUBLIC_SCENES`` (comma-separated slugs) are exposed; an unset or
 * empty allowlist exposes NOTHING.
 *
 * The decision is a pure function so it is directly unit-testable without
 * toggling process env.
 */

export const DEV_TUNNEL_ENV = 'GS_ENABLE_DEV_TUNNEL'
export const DEV_SCENE_ALLOWLIST_ENV = 'XR_DEV_PUBLIC_SCENES'

/** Parse a comma-separated allowlist env value into trimmed slugs. */
export function parseDevSceneAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/**
 * Is ``sceneId`` reachable through the dev ``/local-scenes`` middleware?
 *
 * Tunnel OFF (normal localhost/LAN dev) → every valid scene is allowed.
 * Tunnel ON → only allowlisted scenes (empty allowlist → nothing).
 */
export function resolveLocalSceneAccess(
  tunnelEnabled: boolean,
  allowlist: ReadonlySet<string>,
  sceneId: string,
): boolean {
  if (!tunnelEnabled) return true
  return allowlist.has(sceneId)
}
