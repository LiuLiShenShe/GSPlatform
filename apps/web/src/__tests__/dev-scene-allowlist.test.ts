/**
 * FIX-05 §6 — dev-tunnel scene allowlist unit tests.
 *
 * The decision is a pure function (src/scene-dev/sceneAllowlist.ts), so the
 * full matrix is testable without toggling process env:
 *   Tunnel OFF                     → allowed
 *   Tunnel ON + in allowlist       → allowed
 *   Tunnel ON + not in allowlist   → denied (vite middleware responds 403)
 *   Tunnel ON + empty allowlist    → nothing exposed
 * Traversal / symlink-escape rejection is exercised by the API asset tests
 * (test_scene_assets.py, FIX-01) and the unchanged middleware containment
 * path covered by e2e/ssv08-streaming.
 */
import { describe, expect, it } from 'vitest';
import {
  DEV_SCENE_ALLOWLIST_ENV,
  DEV_TUNNEL_ENV,
  parseDevSceneAllowlist,
  resolveLocalSceneAccess,
} from '../scene-dev/sceneAllowlist';

describe('parseDevSceneAllowlist', () => {
  it('parses comma-separated slugs, trimmed, ignoring empties', () => {
    expect([...parseDevSceneAllowlist('local-garden, xr-smoke-test ,')]).toEqual([
      'local-garden',
      'xr-smoke-test',
    ]);
  });

  it('returns an empty set for unset / empty / whitespace values', () => {
    expect(parseDevSceneAllowlist(undefined).size).toBe(0);
    expect(parseDevSceneAllowlist('').size).toBe(0);
    expect(parseDevSceneAllowlist(' , ').size).toBe(0);
  });

  it('exposes the exact env-var names the middleware reads', () => {
    expect(DEV_TUNNEL_ENV).toBe('GS_ENABLE_DEV_TUNNEL');
    expect(DEV_SCENE_ALLOWLIST_ENV).toBe('XR_DEV_PUBLIC_SCENES');
  });
});

describe('resolveLocalSceneAccess (FIX-05 §4/§6)', () => {
  it('tunnel OFF → every scene allowed (normal localhost/LAN dev)', () => {
    expect(resolveLocalSceneAccess(false, new Set(), 'local-garden')).toBe(true);
    expect(resolveLocalSceneAccess(false, new Set(['local-garden']), 'stream-medium')).toBe(true);
  });

  it('tunnel ON + scene in allowlist → allowed', () => {
    const allow = parseDevSceneAllowlist('local-garden,xr-smoke-test');
    expect(resolveLocalSceneAccess(true, allow, 'local-garden')).toBe(true);
    expect(resolveLocalSceneAccess(true, allow, 'xr-smoke-test')).toBe(true);
  });

  it('tunnel ON + scene NOT in allowlist → denied', () => {
    const allow = parseDevSceneAllowlist('local-garden,xr-smoke-test');
    expect(resolveLocalSceneAccess(true, allow, 'stream-large')).toBe(false);
    expect(resolveLocalSceneAccess(true, allow, 'secret-private-scene')).toBe(false);
  });

  it('tunnel ON + empty allowlist → nothing publicly exposed', () => {
    const allow = parseDevSceneAllowlist('');
    expect(resolveLocalSceneAccess(true, allow, 'local-garden')).toBe(false);
    expect(resolveLocalSceneAccess(true, allow, 'xr-smoke-test')).toBe(false);
  });

  it('no default-allow-all: tunnel ON with a non-matching set still denies', () => {
    // exact-match only — prefix/similar slugs are NOT allowed
    const allow = parseDevSceneAllowlist('local-garden');
    expect(resolveLocalSceneAccess(true, allow, 'local-garden-x')).toBe(false);
    expect(resolveLocalSceneAccess(true, allow, 'local-g')).toBe(false);
  });
});