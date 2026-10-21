/**
 * GS-NEXT-11 §6 — 版本管理面板的前端契约。
 *
 * 锁定：
 *   - 当前版本有明显标记，其它历史版本可以「切换」；
 *   - 资产/清单缺失的版本禁用切换并说明原因（不能点出必失败的按钮）；
 *   - 切换后重新读取列表（服务器真相）并通知上层刷新描述符；
 *   - 409 并发冲突给出明确提示，而不是静默重试；
 *   - 空间绑定 STALE 时提示「空间配置需要重新确认」。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRouter } from '../test/utils';
import { VersionPanel } from '../features/authoring/VersionPanel';
import type { SceneVersionList } from '../services/versionApi';

const listSceneVersions = vi.fn();
const activateSceneVersion = vi.fn();

vi.mock('../services/versionApi', () => ({
  listSceneVersions: (...args: unknown[]) => listSceneVersions(...args),
  activateSceneVersion: (...args: unknown[]) => activateSceneVersion(...args),
}));

function item(overrides: Partial<SceneVersionList['items'][number]> = {}) {
  return {
    id: 'v-old',
    assetVersion: 'abcdef012345',
    format: 'streamed-sog',
    sizeBytes: 2 * 1024 * 1024,
    sha256: null,
    gaussianCount: 12000,
    lodLevels: 3,
    createdAt: '2026-10-18T10:00:00Z',
    isCurrent: false,
    manifestReady: true,
    assetsReady: true,
    entryName: 'lod-meta.json',
    ...overrides,
  };
}

function listing(overrides: Partial<SceneVersionList> = {}): SceneVersionList {
  return {
    items: [
      item({ id: 'v-new', isCurrent: true, createdAt: '2026-10-20T10:00:00Z', gaussianCount: 20000 }),
      item(),
    ],
    meta: { limit: 50, nextCursor: null, total: 2 },
    currentVersionId: 'v-new',
    spatial: {
      state: 'VALID',
      boundVersionId: 'v-new',
      requiresConfirmation: false,
      staleAt: null,
    },
    ...overrides,
  };
}

beforeEach(() => {
  listSceneVersions.mockReset();
  activateSceneVersion.mockReset();
});

describe('版本管理面板', () => {
  it('显示历史版本并标记当前版本', async () => {
    listSceneVersions.mockResolvedValue(listing());
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={() => {}} />);

    expect(await screen.findByTestId('version-item-v-new')).toBeInTheDocument();
    expect(screen.getByTestId('version-current-v-new')).toBeInTheDocument();
    // 当前版本没有「切换」按钮；历史版本有。
    expect(screen.queryByTestId('version-activate-v-new')).not.toBeInTheDocument();
    expect(screen.getByTestId('version-activate-v-old')).toBeInTheDocument();
    // 明确告诉用户「现在正在展示哪个版本」。
    expect(screen.getByText(/当前正在展示/)).toBeInTheDocument();
  });

  it('确认后调用切换接口、重新读取列表并通知上层刷新', async () => {
    listSceneVersions
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(
        listing({
          items: [
            item({ id: 'v-new', createdAt: '2026-10-20T10:00:00Z'}),
            item({ id: 'v-old', isCurrent: true }),
          ],
          currentVersionId: 'v-old',
          spatial: {
            state: 'STALE',
            boundVersionId: 'v-new',
            requiresConfirmation: true,
            staleAt: '2026-10-20T12:00:00Z',
          },
        }),
      );
    activateSceneVersion.mockResolvedValue({
      message: '已切换当前版本',
      sceneId: 'demo',
      previousVersionId: 'v-new',
      currentVersionId: 'v-old',
      changed: true,
      spatial: {
        state: 'STALE',
        boundVersionId: 'v-new',
        requiresConfirmation: true,
        staleAt: '2026-10-20T12:00:00Z',
      },
      collisionPolicy: 'MANUAL_ONLY',
      affectedSpatialFeatures: ['initialCamera', 'viewpoints'],
    });
    const onSwitched = vi.fn();
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={onSwitched} />);

    await userEvent.click(await screen.findByTestId('version-activate-v-old'));
    const bar = await waitFor(() => {
      const el = document.querySelector('.ant-popconfirm-buttons');
      if (!el) throw new Error('popconfirm not open');
      return el as HTMLElement;
    });
    const confirm = within(bar)
      .getAllByRole('button')
      .find((b) => b.className.includes('ant-btn-primary'));
    await userEvent.click(confirm as HTMLElement);

    await waitFor(() => {
      expect(activateSceneVersion).toHaveBeenCalledWith('demo', 'v-old', 'v-new');
    });
    // 服务器真相：列表被重新读取，当前标记随之移动。
    await waitFor(() => {
      expect(screen.getByTestId('version-current-v-old')).toBeInTheDocument();
    });
    expect(onSwitched).toHaveBeenCalledWith({ currentVersionId: 'v-old', spatialStale: true });
    expect(screen.getByTestId('version-spatial-stale')).toBeInTheDocument();
  });

  it('409 并发冲突：提示并刷新，不静默重试', async () => {
    listSceneVersions.mockResolvedValue(listing());
    activateSceneVersion.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { code: 'CONFLICT', message: '当前版本已被改变' } },
    });
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={() => {}} />);

    await userEvent.click(await screen.findByTestId('version-activate-v-old'));
    const bar = await waitFor(() =>
      document.querySelector('.ant-popconfirm-buttons') as HTMLElement,
    );
    const confirm = within(bar)
      .getAllByRole('button')
      .find((b) => b.className.includes('ant-btn-primary'));
    await userEvent.click(confirm as HTMLElement);

    expect(await screen.findByText(/已被其他操作/)).toBeInTheDocument();
    // 只发起过一次切换 —— 冲突不会被当作可重试的瞬时错误。
    expect(activateSceneVersion).toHaveBeenCalledTimes(1);
    expect(listSceneVersions).toHaveBeenCalledTimes(2);
  });

  it('资产缺失的历史版本禁用切换并说明原因', async () => {
    listSceneVersions.mockResolvedValue(
      listing({
        items: [
          item({ id: 'v-new', isCurrent: true }),
          item({ id: 'v-broken', assetsReady: false }),
        ],
        currentVersionId: 'v-new',
      }),
    );
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={() => {}} />);

    const button = await screen.findByTestId('version-activate-v-broken');
    expect(button).toBeDisabled();
    expect(screen.getAllByText('资产缺失').length).toBeGreaterThan(0);
  });

  it('空列表给出明确说明', async () => {
    listSceneVersions.mockResolvedValue(
      listing({ items: [], currentVersionId: null, meta: { limit: 50, nextCursor: null, total: 0 } }),
    );
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={() => {}} />);
    expect(await screen.findByTestId('version-empty')).toBeInTheDocument();
  });

  it('GS-NEXT-12：逐项列出待重新确认 / 已绑定当前版本的空间配置', async () => {
    listSceneVersions.mockResolvedValue(
      listing({
        spatial: {
          state: 'STALE',
          boundVersionId: 'v-new',
          requiresConfirmation: true,
          staleAt: '2026-10-21T10:00:00Z',
          revision: 2,
          pendingFeatures: ['viewpoints', 'annotations', 'collision'],
          confirmedFeatures: ['initialCamera'],
        },
      }),
    );
    renderWithRouter(<VersionPanel sceneId="demo" onSwitched={() => {}} />);

    const pending = await screen.findByTestId('version-spatial-pending');
    expect(pending).toHaveTextContent('观察点');
    expect(pending).toHaveTextContent('标注');
    expect(pending).toHaveTextContent('碰撞');
    expect(pending).not.toHaveTextContent('初始视角');
    const confirmed = screen.getByTestId('version-spatial-confirmed');
    expect(confirmed).toHaveTextContent('初始视角');
  });
});