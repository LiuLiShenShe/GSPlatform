import { afterEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ reject: null as null | ((error: unknown) => Promise<never>) }));

vi.mock('axios', () => ({
  default: {
    create: () => ({ interceptors: {
      request: { use: vi.fn() },
      response: { use: (_success: unknown, reject: (error: unknown) => Promise<never>) => {
        captured.reject = reject;
      } },
    } }),
    isAxiosError: () => true,
  },
}));

import '../services/http';

afterEach(() => vi.unstubAllGlobals());

describe('anonymous session discovery does not interrupt public Viewer', () => {
  it.each([
    ['/auth/me', 'get', '/scene/public', 401, false],
    ['/scenes/private/runtime', 'get', '/scene/private', 401, true],
    ['/uploads', 'post', '/upload', 401, true],
    ['/scenes/private/runtime', 'get', '/xr/private', 401, false],
    ['/scenes/private/runtime', 'get', '/scene/private', 403, false],
  ])('%s %s on %s HTTP %s redirects=%s', async (url, method, pathname, status, redirects) => {
    const location = { pathname, search: '', href: '' };
    vi.stubGlobal('window', { location });
    const error = { config: { url, method }, response: { status } };
    await expect(captured.reject!(error)).rejects.toBe(error);
    expect(location.href.startsWith('/login?returnTo=')).toBe(redirects);
  });
});
