import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import type { WorkSummary } from '../fixtures/myWorks';

/**
 * GS-NEXT-10 — 作品卡操作与后端真实状态对齐。
 *
 * 之前：ARCHIVED 被映射成 FAILED，「恢复」只在 FAILED 显示，已归档/回收站
 * 作品在 UI 上没有恢复入口。这里锁定新契约：
 *   - 已归档 → 可恢复（回到归档前状态），可查看；
 *   - 回收站 → 可恢复，不能查看/编辑，不再显示「删除」；
 *   - 已删除作品只出现在「回收站」标签，不进「全部」。
 */

let rows: WorkSummary[] = [];

vi.mock('../services/worksApi', () => ({
  fetchMyWorks: vi.fn(async () => rows),
  updateScene: vi.fn(async () => ({})),
  archiveScene: vi.fn(async () => {}),
  restoreScene: vi.fn(async () => ({
    message: '场景已恢复',
    status: 'PUBLISHED',
    legacy: false,
    fromRecycleBin: true,
    stillArchived: false,
  })),
  deleteScene: vi.fn(async () => {}),
}));

const poster = 'data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';

function work(id: string, title: string, status: WorkSummary['status']): WorkSummary {
  return {
    id,
    title,
    status,
    updatedAt: '2026-10-19',
    progress: null,
    sceneId: status === 'PUBLISHED' || status === 'ARCHIVED' ? id : null,
    poster,
  };
}

describe('GS-NEXT-10 作品卡恢复入口', () => {
  beforeEach(() => {
    rows = [
      work('live-1', '已发布作品', 'PUBLISHED'),
      work('arch-1', '已归档作品', 'ARCHIVED'),
      work('bin-1', '回收站作品', 'DELETED'),
    ];
  });

  it('已归档作品显示「已归档」标签与恢复按钮，不再冒充失败', async () => {
    renderApp({ route: '/works' });
    const card = await screen.findByTestId('works-card-arch-1');
    expect(within(card).getByText('已归档')).toBeInTheDocument();
    expect(within(card).queryByText('失败')).not.toBeInTheDocument();
    expect(within(card).getByTestId('works-restore-arch-1')).toBeInTheDocument();
    // 归档作品仍可预览
    expect(within(card).getByRole('button', { name: '查看' })).toBeInTheDocument();
  });

  it('回收站作品可恢复，且不显示删除按钮', async () => {
    renderApp({ route: '/works?status=DELETED' });
    const card = await screen.findByTestId('works-card-bin-1');
    expect(within(card).getByText('回收站')).toBeInTheDocument();
    expect(within(card).getByTestId('works-restore-bin-1')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '删除' })).not.toBeInTheDocument();
    // 已删除场景的 detail/PATCH 都 404 —— 不给用户死按钮，只留「恢复」。
    expect(within(card).queryByRole('button', { name: '查看' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '编辑' })).not.toBeInTheDocument();
  });

  it('已删除作品不出现在「全部」，只出现在「回收站」标签', async () => {
    renderApp({ route: '/works' });
    expect(await screen.findByText('全部 2')).toBeInTheDocument();
    expect(screen.queryByTestId('works-card-bin-1')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /回收站 1/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /回收站 1/ }));
    expect(await screen.findByTestId('works-card-bin-1')).toBeInTheDocument();
    expect(screen.queryByTestId('works-card-live-1')).not.toBeInTheDocument();
  });

  it('已发布作品可以归档，但没有恢复按钮', async () => {
    renderApp({ route: '/works' });
    const card = await screen.findByTestId('works-card-live-1');
    expect(within(card).getByRole('button', { name: '归档' })).toBeInTheDocument();
    expect(within(card).queryByTestId('works-restore-live-1')).not.toBeInTheDocument();
  });

  it('恢复按钮走 owner 恢复接口并刷新列表', async () => {
    const { restoreScene } = await import('../services/worksApi');
    renderApp({ route: '/works?status=DELETED' });
    const card = await screen.findByTestId('works-card-bin-1');
    await userEvent.click(within(card).getByTestId('works-restore-bin-1'));
    // 确认气泡里的「恢复」与卡片按钮同名（antd 还会渲染成「恢 复」），
    // 因此按容器定位：气泡底部按钮区里的主按钮才是真正的确认。
    const bar = await waitFor(() => {
      const el = document.querySelector('.ant-popconfirm-buttons');
      if (!el) throw new Error('popconfirm not open');
      return el as HTMLElement;
    });
    const confirm = within(bar)
      .getAllByRole('button')
      .find((b) => b.className.includes('ant-btn-primary'));
    expect(confirm).toBeTruthy();
    await userEvent.click(confirm as HTMLElement);
    expect(restoreScene).toHaveBeenCalledWith('bin-1');
    expect(await screen.findByText('已从回收站恢复，作品与资产都还在')).toBeInTheDocument();
  });
});