/**
 * sceneAssetPolicy —— pure dev-scene asset decisions shared by the vite
 * `/local-scenes/<slug>/<rel>` middleware (vite.config.ts) and their unit
 * tests.
 *
 * FIX-05B issue 1: the middleware used to stamp `Cache-Control` from the
 * *filename alone* (`manifest.json → 60s`, everything else →
 * `public, max-age=31536000, immutable`), which made the repointable
 * `current/*` URLs immutable.  Cacheability is a property of the PATH
 * (mutability), never of the file name, so the decision is made from the
 * path's first segment, mirroring the API's scope-aware
 * `SceneAssetService.build_cache_control` for the one scope a dev origin
 * knows: public.
 *
 * FIX-05B issue 2: the middleware no longer follows `storage/published`
 * symlinks at all (Plan A — see vite.config.ts): `/local-scenes` serves the
 * local scenes tree only; real DB/published scenes are served by the API
 * through `/api/v1/scenes/<id>/assets/*`, where the trusted root is the
 * scene's OWN `published/<scene.id>` (FIX-05 P1-6).
 */

/** Versioned (content-addressed) bytes: the URL never changes. */
export const DEV_IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
/** Everything mutable / repointable / unknown — never long-cached. */
export const DEV_NO_CACHE = 'public, no-cache'
/** Descriptor manifest fetch (top-level `/local-scenes/<id>/manifest.json`). */
export const DEV_MANIFEST_CACHE = 'public, max-age=60'
/** Poster image. */
export const DEV_POSTER_CACHE = 'public, max-age=86400'

/**
 * Dev Cache-Control for one `/local-scenes/<slug>/<rel>` response.
 *
 * Ordered by path semantics, never by filename:
 *
 *   current/<file>       → public, no-cache   (repointable alias — NEVER immutable)
 *   versions/<ver>/<file> → public, max-age=31536000, immutable (content-addressed)
 *   manifest.json        → public, max-age=60 (top-level descriptor fetch)
 *   poster.webp          → public, max-age=86400
 *   anything else        → public, no-cache
 *
 * The manifest/poster special-cases never override the `current` rule:
 * `current/manifest.json` and `current/poster.webp` are still no-cache,
 * because `current` is a symlink alias that a republish may re-point.
 */
export function buildDevSceneCacheControl(relPath: string): string {
  const segments = relPath.split('/').filter(Boolean)
  if (segments[0] === 'current') return DEV_NO_CACHE
  if (segments[0] === 'versions' && segments.length >= 2) return DEV_IMMUTABLE_CACHE
  const name = segments[segments.length - 1] ?? ''
  if (name === 'manifest.json') return DEV_MANIFEST_CACHE
  if (name === 'poster.webp') return DEV_POSTER_CACHE
  return DEV_NO_CACHE
}

/**
 * Real directories the dev middleware may serve a scene asset from.
 *
 * FIX-05B issue 2 (Plan A): ONLY the scene's own real root is trusted.  The
 * pre-FIX-05B code additionally trusted the realpaths of `versions/*`
 * symlinks pointing anywhere under `<storage>/published` — a planted symlink
 * `scenes/A/versions/evil -> published/<B>/...` made A able to read B's
 * bytes, because the dev origin has no DB lookup to prove which published
 * UUID belongs to slug A.  The API (which does have the DB) is the only path
 * that may follow published storage, and there the root is
 * `published/<scene.id>` only (FIX-05 P1-6).  Here we return exactly one
 * root; asserting that no `published` path is ever trusted is a regression
 * guard.
 */
export function buildDevSceneTrustedRoots(realSceneRoot: string): string[] {
  return [realSceneRoot]
}
