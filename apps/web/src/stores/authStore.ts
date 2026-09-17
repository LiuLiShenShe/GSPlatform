/**
 * Auth store — session state + login/logout/register actions.
 *
 * Session cookie (gs_session) is HttpOnly; the CSRF cookie (gs_csrf)
 * is JS-readable.  On successful login the server sets both cookies via
 * Set-Cookie headers — no client-side token storage is needed.
 *
 * The store holds only the *public session summary* returned by GET /auth/me
 * (userId, email, displayName) so that UI can react to auth state.  The
 * Axios interceptor handles 401 → redirect.
 */
import { create } from 'zustand';
import { httpClient } from '../services/http';

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string;
}

interface AuthState {
  user: AuthUser | null;
  /** True while the initial /auth/me probe is in flight. */
  loading: boolean;
  /** Last login/register error message (cleared on next attempt). */
  error: string | null;

  fetchMe: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

/**
 * Read the raw value of a cookie by name.
 * Not used for the HttpOnly session cookie — only for the CSRF cookie
 * which is intentionally JS-readable.
 */
export function readCsrfCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)gs_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  error: null,

  fetchMe: async () => {
    try {
      const res = await httpClient.get<AuthUser>('/auth/me');
      set({ user: res.data, loading: false, error: null });
    } catch {
      set({ user: null, loading: false });
    }
  },

  login: async (email, password) => {
    set({ error: null });
    try {
      const res = await httpClient.post<AuthUser>('/auth/login', {
        email,
        password,
      });
      set({ user: res.data, error: null });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : '登录失败，请重试';
      set({ error: msg });
      throw err;
    }
  },

  register: async (email, password, displayName) => {
    set({ error: null });
    try {
      const res = await httpClient.post<AuthUser>('/auth/register', {
        email,
        password,
        displayName,
      });
      set({ user: res.data, error: null });
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : '注册失败，请重试';
      set({ error: msg });
      throw err;
    }
  },

  logout: async () => {
    try {
      await httpClient.post('/auth/logout');
    } finally {
      set({ user: null });
    }
  },

  clearError: () => set({ error: null }),
}));
