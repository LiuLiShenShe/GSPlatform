/**
 * GS-NEXT-04 —— 导览点（XR 出生位姿）准入规则。
 *
 * 这条规则的**全部价值**在于排除项：老场景里大量标注没有作者化相机，官方
 * adapter 会把它们的 `camera.initial` 逐条回落到**场景初始相机**。若不排除，
 * 用户点「导览点」却被放到初始视角 —— 一个不报错的假承诺。
 */
import { describe, expect, it } from 'vitest';
import { eligibleGuidePoints, isEligibleGuidePoint } from '../scene-runtime/guidePoints';
import type { RuntimeAnnotation } from '../scene-runtime/types';

function ann(over: Partial<RuntimeAnnotation> = {}): RuntimeAnnotation {
  return {
    id: 'a1',
    title: '入口',
    description: '',
    anchor: { x: 1, y: 1, z: 1 },
    style: 'LEADER_TEXT',
    contentType: 'TEXT',
    textContent: '',
    mediaAssetUrl: null,
    textColor: '#FFFFFF',
    textSize: 14,
    fov: 60,
    orderIndex: 0,
    enabled: true,
    cameraPosition: { x: 0, y: 1.6, z: 3 },
    cameraTarget: { x: 0, y: 1.2, z: 0 },
    cameraFov: 55,
    ...over,
  };
}

describe('GS-NEXT-04 导览点准入', () => {
  it('相机 position + target 齐全 → 合格', () => {
    expect(isEligibleGuidePoint(ann())).toBe(true);
    expect(eligibleGuidePoints([ann()])).toHaveLength(1);
  });

  it('缺 cameraPosition 或 cameraTarget → 不合格（不得回落成「初始视角」假承诺）', () => {
    expect(isEligibleGuidePoint(ann({ cameraPosition: null }))).toBe(false);
    expect(isEligibleGuidePoint(ann({ cameraTarget: null }))).toBe(false);
    // 两个都没有 = 典型的历史热点
    expect(isEligibleGuidePoint(ann({ cameraPosition: null, cameraTarget: null }))).toBe(false);
    expect(eligibleGuidePoints([ann({ cameraPosition: null, cameraTarget: null })])).toHaveLength(0);
  });

  it('enabled === false → 不合格（停用热点不进运行时）', () => {
    expect(isEligibleGuidePoint(ann({ enabled: false }))).toBe(false);
  });

  it('缺 cameraFov 仍合格 —— fov 由 adapter 兜底，位置/目标才是导览点的本质', () => {
    expect(isEligibleGuidePoint(ann({ cameraFov: null }))).toBe(true);
  });

  it('保持描述符顺序（= 作者排序），不改写输入', () => {
    const list = [
      ann({ id: 'a', orderIndex: 2 }),
      ann({ id: 'b', enabled: false }),
      ann({ id: 'c', orderIndex: 1 }),
      ann({ id: 'd', cameraPosition: null }),
    ];
    const frozen = JSON.stringify(list);
    expect(eligibleGuidePoints(list).map((a) => a.id)).toEqual(['a', 'c']);
    expect(JSON.stringify(list)).toBe(frozen); // 纯函数：不改调用方数据
  });

  it('空数组 / 全不合格 → 空数组（页面据此隐藏导览点分组）', () => {
    expect(eligibleGuidePoints([])).toEqual([]);
    expect(eligibleGuidePoints([ann({ enabled: false }), ann({ cameraTarget: null })])).toEqual([]);
  });
});