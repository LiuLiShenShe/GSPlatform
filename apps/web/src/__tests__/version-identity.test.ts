/**
 * GS-DESKTOP-04 follow-up §四 —— SceneVersion 身份稳定性比较（纯函数）。
 *
 * ## 为什么不能用 `content.url`
 *
 * 两个不同的 SceneVersion 可能复用同一个内容地址（重新发布同一份资产 /
 * 回滚到相同 `asset_version`），因此「保存前后 URL 相同」**不能**证明版本
 * 没有切换。权威身份是 `GET /scenes/{slug}/versions` 的 `currentVersionId`
 * （服务端直接读 `Scene.current_version_id`）。
 *
 * ## 本文件锁定的契约
 *
 *  1. 两侧都读到且版本 ID 相同 → `unchanged`（内容 URL 是否相同**不参与**）；
 *  2. 两侧都读到但版本 ID 不同 → `changed`（无论内容 URL 是否相同）；
 *  3. 任意一侧读取失败 → `unknown`，**绝不**当成 `unchanged`；
 *  4. 两侧都是 null（场景没有版本）→ `unchanged`（明确观测到「没有版本」）。
 */
import { describe, expect, it } from 'vitest';
import type { CameraPose } from '@playcanvas/supersplat-viewer/settings';
import {
  compareVersionIdentity,
  versionStabilityMessage,
  type VersionIdentity,
} from '../scene-runtime/versionIdentity';
import { confirmInitialCameraSave } from '../scene-runtime/initialCameraSync';
import type { SceneRuntimeDescriptorV1 } from '../scene-runtime/types';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';

/** 保存前后都读到同一个版本 ID；内容 URL 故意相同（不可作为身份证据）。 */
const v1 = '0f7c2e51-2c1c-4a45-9d3e-8b6f5a4d3c2b';
const v2 = '9a1d4b60-77e1-4d88-b2f0-3c5e6a7b8c9d';

function known(versionId: string | null, contentUrl: string | null = '/api/v1/scenes/x/versions/a/sog'): VersionIdentity {
  return { status: 'known', versionId, contentUrl };
}

const unknown: VersionIdentity = { status: 'unknown' };

describe('compareVersionIdentity（保存期间版本稳定性）', () => {
  it('版本 ID 相同 + 内容 URL 相同 → unchanged（正常继续）', () => {
    expect(compareVersionIdentity(known(v1), known(v1))).toBe('unchanged');
  });

  it('版本 ID 相同 + 内容 URL 不同 → unchanged（身份只看版本 ID）', () => {
    expect(compareVersionIdentity(known(v1), known(v1, '/api/v1/scenes/x/versions/b/sog'))).toBe(
      'unchanged',
    );
  });

  it('版本 ID 不同 + 内容 URL 相同 → changed（URL 相同不能证明版本未切换）', () => {
    expect(compareVersionIdentity(known(v1), known(v2))).toBe('changed');
  });

  it('版本 ID 不同 + 内容 URL 不同 → changed', () => {
    expect(
      compareVersionIdentity(known(v1, '/a/sog'), known(v2, '/b/sog')),
    ).toBe('changed');
  });

  it('保存前读取失败（unknown）→ unknown，不得当成未变化', () => {
    expect(compareVersionIdentity(unknown, known(v1))).toBe('unknown');
  });

  it('保存后读取失败（unknown）→ unknown，不得当成未变化', () => {
    expect(compareVersionIdentity(known(v1), unknown)).toBe('unknown');
  });

  it('两侧都读取失败 → unknown', () => {
    expect(compareVersionIdentity(unknown, unknown)).toBe('unknown');
  });

  it('两侧都是 null（场景没有版本，明确观测到）→ unchanged', () => {
    expect(compareVersionIdentity(known(null), known(null))).toBe('unchanged');
  });

  it('从「没有版本」变成「有版本」→ changed', () => {
    expect(compareVersionIdentity(known(null), known(v1))).toBe('changed');
  });

  it('从「有版本」变成「没有版本」→ changed（版本被移除/重指向）', () => {
    expect(compareVersionIdentity(known(v1), known(null))).toBe('changed');
  });
});

describe('versionStabilityMessage（用户提示）', () => {
  it('changed → 明确提示版本已切换、需要重新保存', () => {
    const msg = versionStabilityMessage('changed');
    expect(msg).toContain('版本');
    expect(msg).toContain('重新保存');
  });

  it('unknown → 明确提示无法确认版本（不说成已同步）', () => {
    const msg = versionStabilityMessage('unknown');
    expect(msg).toContain('无法确认');
    expect(msg).toContain('不同步');
  });

  it('unchanged → 空串（无需提示）', () => {
    expect(versionStabilityMessage('unchanged')).toBe('');
  });
});

// --------------------------------------------------------------------------- //
// 保存链路（confirmInitialCameraSave）—— 页面侧 verifyInitialViewUsed /
// persistInitialView 的唯一判定入口，这里锁定它的全部分支。
//
// 该函数同时把关两件事（GS-DESKTOP-04 follow-up §三 + §四）：
//   1. 完整姿态：position + target + FOV 都必须被描述符采用；
//   2. 版本身份：保存前后的 currentVersionId 必须一致。
// --------------------------------------------------------------------------- //

const SAVED: CameraPose = { position: [3.7, 0.7, 2.5], target: [0.0, 0.6, 0.0], fov: 47 };
/** 「只改 FOV」的保存：位置/目标不变，FOV 47 → 85。 */
const FOV_85: CameraPose = { ...SAVED, fov: 85 };

function descriptorWith(pose: CameraPose | null, contentUrl: string | null = '/api/v1/scenes/x/versions/a/sog'): SceneRuntimeDescriptorV1 {
  return {
    ...runtimeDescriptorFixture,
    content: { url: contentUrl, format: 'sog' },
    presentation: {
      ...runtimeDescriptorFixture.presentation,
      initialCamera: pose
        ? {
            position: { x: pose.position[0], y: pose.position[1], z: pose.position[2] },
            target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] },
            fov: pose.fov,
          }
        : { position: null, target: null, fov: null },
    },
  };
}

describe('confirmInitialCameraSave（保存确认链：完整姿态 + 版本身份）', () => {
  const same = () => [known(v1), known(v1)] as const;

  it('版本 ID 相同 + 内容 URL 相同 + 完整姿态已采用 → confirmed', () => {
    const [before, after] = same();
    expect(confirmInitialCameraSave(SAVED, descriptorWith(SAVED), before, after)).toEqual({
      status: 'confirmed',
    });
  });

  it('版本 ID 相同 + 内容 URL 相同 + FOV 错误 → not-adopted（pose-mismatch）', () => {
    const [before, after] = same();
    expect(
      confirmInitialCameraSave(SAVED, descriptorWith({ ...SAVED, fov: 85 }), before, after),
    ).toEqual({ status: 'not-adopted', reason: 'pose-mismatch' });
  });

  it('描述符 FOV 为 null → not-adopted（pose-mismatch）', () => {
    const [before, after] = same();
    const desc = descriptorWith(SAVED);
    desc.presentation.initialCamera.fov = null;
    expect(confirmInitialCameraSave(SAVED, desc, before, after)).toEqual({
      status: 'not-adopted',
      reason: 'pose-mismatch',
    });
  });

  it('描述符回读失败（null）→ not-adopted（descriptor-missing）', () => {
    const [before, after] = same();
    expect(confirmInitialCameraSave(SAVED, null, before, after)).toEqual({
      status: 'not-adopted',
      reason: 'descriptor-missing',
    });
  });

  it('版本 ID 不同 + 内容 URL 相同 → version-unsafe（changed）', () => {
    const before = known(v1, '/api/v1/scenes/x/versions/a/sog');
    const after = known(v2, '/api/v1/scenes/x/versions/a/sog');
    expect(confirmInitialCameraSave(SAVED, descriptorWith(SAVED), before, after)).toEqual({
      status: 'version-unsafe',
      stability: 'changed',
    });
  });

  it('版本 ID 不同 + 内容 URL 不同 → version-unsafe（changed）', () => {
    const before = known(v1, '/api/v1/scenes/x/versions/a/sog');
    const after = known(v2, '/api/v1/scenes/x/versions/b/sog');
    expect(confirmInitialCameraSave(SAVED, descriptorWith(SAVED), before, after)).toEqual({
      status: 'version-unsafe',
      stability: 'changed',
    });
  });

  it('版本身份读取失败 → version-unsafe（unknown），不得当成未变化', () => {
    expect(
      confirmInitialCameraSave(SAVED, descriptorWith(SAVED), known(v1), unknown),
    ).toEqual({ status: 'version-unsafe', stability: 'unknown' });
  });

  it('姿态与版本都不通过时，姿态问题优先报告（更接近根因）', () => {
    const before = known(v1);
    const after = known(v2);
    expect(
      confirmInitialCameraSave(SAVED, descriptorWith({ ...SAVED, fov: 85 }), before, after),
    ).toEqual({ status: 'not-adopted', reason: 'pose-mismatch' });
  });

  it('只改 FOV 的保存：后端已采用新 FOV → confirmed（可进入 synced）', () => {
    const [before, after] = same();
    expect(
      confirmInitialCameraSave(FOV_85, descriptorWith(FOV_85), before, after),
    ).toEqual({ status: 'confirmed' });
  });

  it('只改 FOV 的保存：后端仍是旧 FOV → not-adopted', () => {
    const [before, after] = same();
    expect(
      confirmInitialCameraSave(FOV_85, descriptorWith(SAVED), before, after),
    ).toEqual({ status: 'not-adopted', reason: 'pose-mismatch' });
  });

  it('版本变化后，在新版本上重新保存 → confirmed（可以正常同步）', () => {
    // 第一次保存：保存期间版本从 v1 切到 v2 → 拒绝同步。
    expect(
      confirmInitialCameraSave(SAVED, descriptorWith(SAVED), known(v1), known(v2)),
    ).toEqual({ status: 'version-unsafe', stability: 'changed' });
    // 用户在当前版本（v2）重新保存：前后都读到 v2 → 正常确认。
    expect(
      confirmInitialCameraSave(SAVED, descriptorWith(SAVED), known(v2), known(v2)),
    ).toEqual({ status: 'confirmed' });
  });
});
