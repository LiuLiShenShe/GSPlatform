/**
 * FIX-03 §9/§10/§16 — CollisionPanel「真实能力」UI 测试。
 *
 * 断言：
 *   - 物理参数（重力/坡度限制/台阶高度/玩家高度）**不再以可调控件出现**
 *     （无 spinbutton，无「保存参数」按钮），而是在 Unsupported 提示中以
 *     <del> 划线标注「不支持」（§9：不得让用户以为可配置）；
 *   - 构建碰撞请求只携带 mode（不再发送无效物理参数）；
 *   - 启用碰撞 Switch 仍是真实能力（collisionEnabled → runtime 加载碰撞网格）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollisionPanel } from '../features/authoring/CollisionPanel';
import { buildCollision, getCollision, rebuildCollision, type CollisionAsset } from '../services/collisionApi';
import { getSceneProcessing, type SceneProcessingSettings } from '../services/sceneProcessingApi';

vi.mock('../services/collisionApi', () => ({
  getCollision: vi.fn(),
  buildCollision: vi.fn(),
  updateCollision: vi.fn(),
  rebuildCollision: vi.fn(),
}));
vi.mock('../services/sceneProcessingApi', () => ({ getSceneProcessing: vi.fn() }));

const mockedGetCollision = vi.mocked(getCollision);
const mockedBuildCollision = vi.mocked(buildCollision);
const mockedGetProcessing = vi.mocked(getSceneProcessing);

function makeProcessing(): SceneProcessingSettings {
  return {
    sceneType: 'PLANT_OBJECT', conversionProfile: 'balanced', collisionPolicy: 'MANUAL_ONLY',
    calibration: { state: 'UNVERIFIED', stale: false, physicalWalkAllowed: false },
    collisionDecision: { reasonCode: 'POLICY_MANUAL_ONLY', shouldBuild: false },
  };
}

function makeAsset(overrides: Partial<CollisionAsset> = {}): CollisionAsset {
  return {
    id: 'col-1',
    sceneId: 'scene-1',
    mode: 'OUTDOOR',
    status: 'SUCCEEDED',
    gravity: 9.81,
    slopeLimitDegrees: 45,
    stepOffset: 0.3,
    playerHeight: 1.8,
    collisionEnabled: true,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('CollisionPanel（FIX-03 §9/§10）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetProcessing.mockResolvedValue(makeProcessing());
  });

  it('物理参数不可配置：无 spinbutton、无保存参数，且以 <del> 标注不支持（§9）', async () => {
    mockedGetCollision.mockResolvedValue(makeAsset());
    const { container } = render(<CollisionPanel sceneId="scene-1" isOwner />);

    const notice = await screen.findByTestId('collision-unsupported-notice');
    expect(notice).toBeInTheDocument();
    // 四个物理参数全部以删除线标注「不支持」（提示用户 DB 字段仅兼容、不可配置）。
    expect(notice.querySelectorAll('del')).toHaveLength(4);
    // 没有任何可调数字输入 / 保存参数按钮 —— 不得出现「看起来能配、实际无效」的 UI。
    expect(container.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(container.querySelectorAll('.ant-input-number')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /保存参数/ })).not.toBeInTheDocument();
  });

  it('未标定 → 明确确认非物理测试后构建，不发送无效物理参数', async () => {
    mockedGetCollision.mockRejectedValue({ status: 404 });
    mockedBuildCollision.mockResolvedValue({ jobId: 'job-1', status: 'QUEUED', message: 'ok' });
    render(<CollisionPanel sceneId="scene-1" isOwner />);

    // antd Button 的图标 aria-label 会并入可访问名 —— 用正则子串匹配。
    const buildBtn = await screen.findByRole('button', { name: /构建碰撞/ });
    expect(buildBtn).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认仅生成非物理测试碰撞/ }));
    await waitFor(() => expect(buildBtn).toBeEnabled());
    await userEvent.click(buildBtn);
    expect(mockedBuildCollision).toHaveBeenCalledWith('scene-1', {
      mode: 'OUTDOOR', acknowledge_unverified_scale: true,
    });
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('gravity');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('slopeLimitDegrees');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('stepOffset');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('playerHeight');
  });

  it('已创建资产 → 启用碰撞 Switch 存在（真实能力）且无物理参数可调 UI', async () => {
    mockedGetCollision.mockResolvedValue(makeAsset());
    const { container } = render(<CollisionPanel sceneId="scene-1" isOwner />);

    expect(await screen.findByTestId('collision-enabled-switch')).toBeInTheDocument();
    expect(screen.getByTestId('collision-enabled-switch')).toBeDisabled();
    expect(container.querySelectorAll('.ant-input-number')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /保存参数/ })).not.toBeInTheDocument();
  });

  it('显示权威策略、尺度和失败独立性；确认后允许手动重建', async () => {
    mockedGetCollision.mockResolvedValue(makeAsset({ status: 'FAILED', errorMessage: 'timeout' }));
    vi.mocked(rebuildCollision).mockResolvedValue({ jobId: 'job-2', status: 'QUEUED', message: 'ok' });
    render(<CollisionPanel sceneId="scene-1" isOwner />);
    expect(await screen.findByTestId('collision-processing-policy')).toHaveTextContent('PLANT_OBJECT');
    expect(screen.getByTestId('collision-processing-policy')).toHaveTextContent('POLICY_MANUAL_ONLY');
    expect(await screen.findByText(/timeout；碰撞失败不影响已发布场景查看/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /我确认仅生成非物理测试碰撞/ }));
    await userEvent.click(screen.getByRole('button', { name: /重建碰撞/ }));
    expect(rebuildCollision).toHaveBeenCalledWith('scene-1', undefined, true);
  });

  it('只读用户不能手动构建或确认尺度', async () => {
    mockedGetCollision.mockRejectedValue({ status: 404 });
    render(<CollisionPanel sceneId="scene-1" isOwner={false} />);
    expect(await screen.findByRole('button', { name: /构建碰撞/ })).toBeDisabled();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('策略读取失败时禁止构建，而不是假定默认允许', async () => {
    mockedGetCollision.mockRejectedValue({ status: 404 });
    mockedGetProcessing.mockRejectedValue(new Error('network'));
    render(<CollisionPanel sceneId="scene-1" isOwner />);
    expect(await screen.findByText('处理策略读取失败，请刷新后重试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /构建碰撞/ })).toBeDisabled();
  });
});
