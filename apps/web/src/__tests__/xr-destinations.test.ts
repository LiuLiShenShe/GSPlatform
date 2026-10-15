/**
 * GS-NEXT-05 —— 会话内导览目的地准入（`xrDestinations.ts` 纯规则）。
 *
 * 这一层决定"哪些位置会被当作可传送的目的地提供给用户"。验收项 §5-9
 * （删除 / 停用 / 无 authored camera 的目的地不得被错误提供）就锁在这里。
 */
import { describe, expect, it } from 'vitest';
import {
  buildXrDestinations,
  destinationIndexByKey,
  destinationKey,
  INITIAL_DESTINATION_ID,
  stepDestinationIndex,
} from '../scene-runtime/xrDestinations';
import type { RuntimeAnnotation, RuntimeViewpoint } from '../scene-runtime/types';

function viewpoint(overrides: Partial<RuntimeViewpoint> = {}): RuntimeViewpoint {
  return {
    id: 'vp-1',
    name: '入口',
    position: { x: 0, y: 1.6, z: 3.5 },
    target: { x: 0, y: 1.0, z: 0 },
    fov: 55,
    orderIndex: 0,
    enabled: true,
    ...overrides,
  };
}

function annotation(overrides: Partial<RuntimeAnnotation> = {}): RuntimeAnnotation {
  return {
    id: 'ann-1',
    title: '水井',
    description: '',
    anchor: { x: 0, y: 0, z: 0 },
    style: 'LEADER_TEXT',
    contentType: 'TEXT',
    textContent: '',
    mediaAssetUrl: null,
    textColor: '#FFFFFF',
    textSize: 14,
    fov: 60,
    cameraPosition: { x: -3, y: 1.9, z: 2 },
    cameraTarget: { x: -1.2, y: 0.4, z: 0.4 },
    cameraFov: 45,
    orderIndex: 0,
    enabled: true,
    ...overrides,
  };
}

const base = {
  hasInitialCamera: true,
  viewpoints: [] as RuntimeViewpoint[],
  guidePoints: [] as RuntimeAnnotation[],
};

describe('buildXrDestinations', () => {
  it('有 authored 初始相机时，初始位置排在第一位（用户"回到的地方"是确定的一个）', () => {
    const list = buildXrDestinations({ ...base, viewpoints: [viewpoint()] });
    expect(list.map((d) => d.kind)).toEqual(['initial', 'viewpoint']);
    expect(list[0].key).toBe(destinationKey('initial', INITIAL_DESTINATION_ID));
  });

  it('没有 authored 初始相机时不提供"返回初始位置"（点了无处可回 = 假按钮）', () => {
    const list = buildXrDestinations({
      ...base,
      hasInitialCamera: false,
      viewpoints: [viewpoint()],
      guidePoints: [annotation()],
    });
    expect(list.map((d) => d.kind)).toEqual(['viewpoint', 'guide-point']);
    expect(list.some((d) => d.kind === 'initial')).toBe(false);
  });

  it('停用的观察点不提供', () => {
    const list = buildXrDestinations({
      ...base,
      viewpoints: [viewpoint({ enabled: false }), viewpoint({ id: 'vp-2', name: '后院' })],
    });
    expect(list.map((d) => d.id)).toEqual([INITIAL_DESTINATION_ID, 'vp-2']);
  });

  it('停用 / 无名的观察点与导览点不提供（菜单里分不清的条目不提供）', () => {
    const list = buildXrDestinations({
      ...base,
      viewpoints: [viewpoint({ name: '   ' })],
      guidePoints: [annotation({ title: '' })],
    });
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('initial');
  });

  it('导览点保持作者排序，且 key 与观察点不会撞（kind 前缀）', () => {
    const list = buildXrDestinations({
      ...base,
      viewpoints: [viewpoint({ id: 'same-id', name: '观察点' })],
      guidePoints: [annotation({ id: 'b', title: 'B' }), annotation({ id: 'a', title: 'A' })],
    });
    expect(list.map((d) => d.id)).toEqual([INITIAL_DESTINATION_ID, 'same-id', 'b', 'a']);
    expect(new Set(list.map((d) => d.key)).size).toBe(list.length);
    expect(list[2].key).toBe('guide-point:b');
  });

  it('空场景 → 空列表（运行时据此不给一个全是死按钮的菜单）', () => {
    expect(buildXrDestinations({ ...base, hasInitialCamera: false })).toEqual([]);
  });
});

describe('stepDestinationIndex（环形，与官方 Desktop 标注导览器同语义）', () => {
  it('向前 / 向后环绕', () => {
    expect(stepDestinationIndex(3, 0, 1)).toBe(1);
    expect(stepDestinationIndex(3, 2, 1)).toBe(0);
    expect(stepDestinationIndex(3, 0, -1)).toBe(2);
  });

  it('空列表 / 单元素永远落在 0（不产生 -1 这种非法下标）', () => {
    expect(stepDestinationIndex(0, 3, 1)).toBe(0);
    expect(stepDestinationIndex(1, 0, 1)).toBe(0);
    expect(stepDestinationIndex(1, 0, -1)).toBe(0);
  });

  it('当前下标非法（未指定 = -1）时从第 0 项开始', () => {
    // 非法下标先归 0，再走一步 → 1（-1 与 9 都不产生越界下标）。
    expect(stepDestinationIndex(4, -1, 1)).toBe(1);
    expect(stepDestinationIndex(4, 9, 1)).toBe(1);
    expect(stepDestinationIndex(4, -1, -1)).toBe(3);
  });
});

describe('destinationIndexByKey', () => {
  it('按 key 匹配而不是下标持久化', () => {
    const list = buildXrDestinations({ ...base, guidePoints: [annotation()] });
    expect(list.map((d) => d.kind)).toEqual(['initial', 'guide-point']);
    expect(destinationIndexByKey(list, 'guide-point:ann-1')).toBe(1);
    expect(destinationIndexByKey(list, 'ann-1')).toBe(-1);
    expect(destinationIndexByKey(list, '')).toBe(-1);
  });
});
