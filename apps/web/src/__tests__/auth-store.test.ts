import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { httpClient } from '../services/http';
import { useAuthStore } from '../stores/authStore';

beforeEach(() => useAuthStore.setState({ user: null, loading: false, error: null }));
afterEach(() => vi.restoreAllMocks());

it.each([
  ['login', 401, '邮箱或密码错误', '邮箱或密码错误'],
  ['login', 429, 'login 请求过于频繁，请稍后重试', '登录尝试过于频繁，请稍后重试。'],
  ['register', 409, '该邮箱已被注册', '该邮箱已被注册'],
] as const)('%s 展示可读的 %s 错误', async (action, status, message, expected) => {
  const failure = Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: { code: `HTTP_${status}`, message } },
  });
  vi.spyOn(httpClient, 'post').mockRejectedValueOnce(failure);
  const attempt = action === 'login'
    ? useAuthStore.getState().login('preview@example.com', 'example-password')
    : useAuthStore.getState().register('preview@example.com', 'example-password', 'Preview');
  await expect(attempt).rejects.toBe(failure);
  expect(useAuthStore.getState().error).toBe(expected);
  expect(useAuthStore.getState().user).toBeNull();
});
