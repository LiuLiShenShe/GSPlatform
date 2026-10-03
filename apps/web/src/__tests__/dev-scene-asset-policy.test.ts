/**
 * FIX-05B issue 1/§5 — dev `/local-scenes` Cache-Control matrix + issue 2
 * published-trust guard, tested on the pure helpers
 * (src/scene-dev/sceneAssetPolicy.ts).
 *
 * The pre-FIX-05B vite middleware stamped Cache-Control from the filename
 * alone (`manifest.json → 60s`, everything else → immutable), so the
 * repointable `current/*` URLs were served `immutable`. The policy is now
 * path-semantics based, exactly like the API's scope-aware
 * `build_cache_control` for the public scope:
 *
 *   current/<file>        → public, no-cache
 *   versions/<ver>/<file> → public, max-age=31536000, immutable
 *   manifest.json         → public, max-age=60
 *   poster.webp           → public, max-age=86400
 *   anything else         → public, no-cache
 */
import { describe, expect, it } from 'vitest';
import {
  DEV_IMMUTABLE_CACHE,
  DEV_MANIFEST_CACHE,
  DEV_NO_CACHE,
  DEV_POSTER_CACHE,
  buildDevSceneCacheControl,
  buildDevSceneTrustedRoots,
} from '../scene-dev/sceneAssetPolicy';

const cacheOf = (rel: string): string => buildDevSceneCacheControl(rel);

describe('buildDevSceneCacheControl — current/* is never immutable (issue 1)', () => {
  it('current/*.sog → no-cache (repointable alias)', () => {
    expect(cacheOf('current/scene.sog')).toBe(DEV_NO_CACHE);
  });

  it('current/lod-meta.json → no-cache', () => {
    expect(cacheOf('current/lod-meta.json')).toBe(DEV_NO_CACHE);
  });

  it('current/chunk.webp → no-cache', () => {
    expect(cacheOf('current/chunk.webp')).toBe(DEV_NO_CACHE);
  });

  it('current/manifest.json and current/poster.webp are NOT overridden by the filename specials', () => {
    // The manifest/poster special-cases must never win over the `current`
    // rule — `current` is a symlink alias a republish may re-point.
    expect(cacheOf('current/manifest.json')).toBe(DEV_NO_CACHE);
    expect(cacheOf('current/poster.webp')).toBe(DEV_NO_CACHE);
  });

  it('any current/* value never contains immutable', () => {
    for (const rel of [
      'current/scene.sog',
      'current/lod-meta.json',
      'current/chunk.webp',
      'current/manifest.json',
      'current/nested/anything.bin',
    ]) {
      expect(cacheOf(rel)).not.toContain('immutable');
      expect(cacheOf(rel)).toBe(DEV_NO_CACHE);
    }
  });
});

describe('buildDevSceneCacheControl — versions/<ver>/* is immutable (content-addressed)', () => {
  it('versions/v1/scene.sog → immutable', () => {
    expect(cacheOf('versions/v1/scene.sog')).toBe(DEV_IMMUTABLE_CACHE);
  });

  it('versions/hash123/chunk.webp → immutable', () => {
    expect(cacheOf('versions/hash123/chunk.webp')).toBe(DEV_IMMUTABLE_CACHE);
  });

  it('versioned lod-meta.json and nested chunks → immutable', () => {
    expect(cacheOf('versions/v1/lod-meta.json')).toBe(DEV_IMMUTABLE_CACHE);
    expect(cacheOf('versions/v1/chunk.webp')).toBe(DEV_IMMUTABLE_CACHE);
    expect(cacheOf('versions/v1/0_0/chunk-0001.webp')).toBe(DEV_IMMUTABLE_CACHE);
  });
});

describe('buildDevSceneCacheControl — manifest / poster / other', () => {
  it('bare manifest.json (top-level descriptor fetch) → 60s', () => {
    expect(cacheOf('manifest.json')).toBe(DEV_MANIFEST_CACHE);
  });

  it('bare poster.webp → 1 day', () => {
    expect(cacheOf('poster.webp')).toBe(DEV_POSTER_CACHE);
  });

  it('nested manifest.json / poster.webp do NOT inherit the top-level TTLs (FIX-05C.1)', () => {
    // Only the exact top-level file gets the special TTL; a nested basename
    // falls back to no-cache (mirrors the Backend EXACT top-level rule).
    for (const rel of [
      'foo/manifest.json',
      'foo/poster.webp',
      'nested/path/manifest.json',
      'nested/path/poster.webp',
      'media/poster.webp',
    ]) {
      expect(cacheOf(rel)).toBe(DEV_NO_CACHE);
    }
  });

  it('unknown / other paths → no-cache (never immutable by default)', () => {
    expect(cacheOf('other/file.bin')).toBe(DEV_NO_CACHE);
    expect(cacheOf('scene.sog')).toBe(DEV_NO_CACHE);
    expect(cacheOf('versions/')).toBe(DEV_NO_CACHE); // no version segment
    expect(cacheOf('')).toBe(DEV_NO_CACHE);
  });

  it('the exact strings the report and the backend use', () => {
    expect(DEV_IMMUTABLE_CACHE).toBe('public, max-age=31536000, immutable');
    expect(DEV_NO_CACHE).toBe('public, no-cache');
    expect(DEV_MANIFEST_CACHE).toBe('public, max-age=60');
    expect(DEV_POSTER_CACHE).toBe('public, max-age=86400');
  });
});

describe('buildDevSceneTrustedRoots — no published trust (issue 2, Plan A)', () => {
  it('trusts ONLY the scene own real root', () => {
    const roots = buildDevSceneTrustedRoots('/scenes/A');
    expect(roots).toEqual(['/scenes/A']);
  });

  it('never returns any path under a published storage root (regression guard)', () => {
    // The pre-FIX-05B bug: the middleware trusted the realpaths of
    // `versions/*` symlinks pointing anywhere under `<storage>/published`,
    // so a planted `scenes/A/versions/evil -> published/<B>/…` symlink let
    // A read B's bytes. Plan A returns a single scene root — nothing under
    // `published` is ever a trust anchor here.
    const roots = buildDevSceneTrustedRoots('/scenes/A');
    expect(roots.filter((r) => r.includes('published'))).toEqual([]);
  });
});
