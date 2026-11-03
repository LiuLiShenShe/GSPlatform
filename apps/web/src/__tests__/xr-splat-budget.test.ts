/**
 * GS-UI-01 后续 —— VR 专用低 LOD 的 splat 预算决策。
 *
 * 背景：官方 viewer 预算表 mobile {low:1M,high:2M} / desktop {low:2M,high:4M}，
 * PICO 浏览器 UA 可能被判成 desktop → 13M/3.2GB 场景在头显上流式/渲染过重，
 * 转头时未加载分块就是黑背景。XR 入口显式传 `budget`（百万高斯）覆盖官方表，
 * 默认落在 3.125% LOD 档附近；`?budget=` 可在真机现场调。
 */
import { describe, expect, it } from 'vitest';
import {
  resolveXrSplatBudget,
  XR_DEFAULT_SPLAT_BUDGET_MILLIONS,
} from '../scene-runtime/xrSplatBudget';

describe('resolveXrSplatBudget', () => {
  it('无 ?budget= 时用 VR 默认值（0.5M ≈ 3.125% LOD）', () => {
    expect(XR_DEFAULT_SPLAT_BUDGET_MILLIONS).toBe(0.5);
    expect(resolveXrSplatBudget('')).toBe(0.5);
    expect(resolveXrSplatBudget('?foo=1')).toBe(0.5);
  });

  it('?budget=<正数> 覆盖默认（百万高斯）', () => {
    expect(resolveXrSplatBudget('?budget=1')).toBe(1);
    expect(resolveXrSplatBudget('?budget=0.25')).toBe(0.25);
    expect(resolveXrSplatBudget('?budget=0.75&x=1')).toBe(0.75);
  });

  it('非法值（0/负数/非数字/空）回默认，避免“设了但没生效”', () => {
    expect(resolveXrSplatBudget('?budget=0')).toBe(0.5);
    expect(resolveXrSplatBudget('?budget=-1')).toBe(0.5);
    expect(resolveXrSplatBudget('?budget=abc')).toBe(0.5);
    expect(resolveXrSplatBudget('?budget=')).toBe(0.5);
    expect(resolveXrSplatBudget('?budget=Infinity')).toBe(0.5);
  });
});
