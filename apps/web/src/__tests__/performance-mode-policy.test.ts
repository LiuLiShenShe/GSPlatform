/**
 * GS-NEXT-02 §五 —— Performance Mode 默认策略。
 *
 * 产品契约：
 *   1. 首次打开（无显式偏好）→ 默认 **ON**（不再沿用官方桌面端默认 OFF）。
 *   2. 用户显式偏好（localStorage `performanceMode`）→ 优先于产品默认。
 *   3. 默认值只施加一次且不写入 localStorage（默认 ≠ 偏好）；
 *      会话内用户手动 OFF 不得被重新强制打开。
 *   4. 偏好来源唯一 = 官方 key（禁止第二套存储）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  GSPLATFORM_PERFORMANCE_MODE_DEFAULT,
  PERFORMANCE_MODE_STORAGE_KEY,
  performanceModeTarget,
  readPerformanceModePreference,
  resolveInitialPerformanceMode,
} from '../scene-runtime/performanceModePolicy';

afterEach(() => {
  localStorage.removeItem(PERFORMANCE_MODE_STORAGE_KEY);
});

describe('GS-NEXT-02 Performance Mode 默认策略', () => {
  it('偏好 key 就是官方 key（不建第二套存储）', () => {
    expect(PERFORMANCE_MODE_STORAGE_KEY).toBe('performanceMode');
  });

  it('产品默认为 ON', () => {
    expect(GSPLATFORM_PERFORMANCE_MODE_DEFAULT).toBe(true);
  });

  it('无偏好（首次打开）→ 默认 ON', () => {
    localStorage.removeItem(PERFORMANCE_MODE_STORAGE_KEY);
    expect(readPerformanceModePreference()).toBeNull();
    expect(resolveInitialPerformanceMode()).toBe(true);
  });

  it('显式偏好 OFF 优先于产品默认（尊重用户手动关闭）', () => {
    localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, 'false');
    expect(readPerformanceModePreference()).toBe(false);
    expect(resolveInitialPerformanceMode()).toBe(false);
  });

  it('显式偏好 ON 优先于产品默认', () => {
    localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, 'true');
    expect(readPerformanceModePreference()).toBe(true);
    expect(resolveInitialPerformanceMode()).toBe(true);
  });

  it('清除偏好 key = 恢复产品默认 ON', () => {
    localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, 'false');
    expect(resolveInitialPerformanceMode()).toBe(false);
    localStorage.removeItem(PERFORMANCE_MODE_STORAGE_KEY);
    expect(resolveInitialPerformanceMode()).toBe(true);
  });

  it('未知取值按官方语义解析（严格等于 "true" 才是 ON）', () => {
    localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, 'TRUE');
    expect(readPerformanceModePreference()).toBe(false);
    localStorage.setItem(PERFORMANCE_MODE_STORAGE_KEY, '');
    expect(readPerformanceModePreference()).toBe(false);
  });

  it('无偏好 + 当前 OFF → 需施加 ON；施加后无偏好 + 当前 ON → 无需再写', () => {
    expect(performanceModeTarget(false, null)).toBe(true);
    expect(performanceModeTarget(true, null)).toBeNull();
  });

  it('显式偏好与当前值相同 → null（不重复写入官方 state）', () => {
    expect(performanceModeTarget(false, false)).toBeNull();
    expect(performanceModeTarget(true, true)).toBeNull();
  });

  it('显式偏好覆盖默认值（当前 ON 但偏好 OFF → 需施加 OFF）', () => {
    expect(performanceModeTarget(true, false)).toBe(false);
    expect(performanceModeTarget(false, true)).toBe(true);
  });
});