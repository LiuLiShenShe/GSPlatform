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
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CollisionPanel } from '../features/authoring/CollisionPanel';
import { buildCollision, getCollision, type CollisionAsset } from '../services/collisionApi';

vi.mock('../services/collisionApi', () => ({
  getCollision: vi.fn(),
  buildCollision: vi.fn(),
  updateCollision: vi.fn(),
  rebuildCollision: vi.fn(),
}));

const mockedGetCollision = vi.mocked(getCollision);
const mockedBuildCollision = vi.mocked(buildCollision);

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

  it('未创建资产 → 构建请求只携带 mode（不发送无效物理参数）', async () => {
    mockedGetCollision.mockRejectedValue({ status: 404 });
    mockedBuildCollision.mockResolvedValue({ jobId: 'job-1', status: 'QUEUED', message: 'ok' });
    render(<CollisionPanel sceneId="scene-1" isOwner />);

    // antd Button 的图标 aria-label 会并入可访问名 —— 用正则子串匹配。
    const buildBtn = await screen.findByRole('button', { name: /构建碰撞/ });
    await userEvent.click(buildBtn);
    expect(mockedBuildCollision).toHaveBeenCalledWith('scene-1', { mode: 'OUTDOOR' });
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('gravity');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('slopeLimitDegrees');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('stepOffset');
    expect(mockedBuildCollision.mock.calls[0][1]).not.toHaveProperty('playerHeight');
  });

  it('已创建资产 → 启用碰撞 Switch 存在（真实能力）且无物理参数可调 UI', async () => {
    mockedGetCollision.mockResolvedValue(makeAsset());
    const { container } = render(<CollisionPanel sceneId="scene-1" isOwner />);

    expect(await screen.findByTestId('collision-enabled-switch')).toBeInTheDocument();
    expect(container.querySelectorAll('.ant-input-number')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /保存参数/ })).not.toBeInTheDocument();
  });
});