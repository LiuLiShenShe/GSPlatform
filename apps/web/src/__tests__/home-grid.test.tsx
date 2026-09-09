import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, setViewportWidth } from '../test/utils';

afterEach(() => {
  setViewportWidth(1024);
});

describe('首页 SceneCard 与交互', () => {
  it('1600px 视口严格 5 列，卡片数量正确', async () => {
    setViewportWidth(1600);
    renderApp({ route: '/' });
    const grid = await screen.findByTestId('scene-grid');
    expect(grid).toHaveAttribute('data-columns', '5');
    expect(grid.children.length).toBe(12);
  });

  it('360px 窄屏降为 1 列', async () => {
    setViewportWidth(360);
    renderApp({ route: '/' });
    const grid = await screen.findByTestId('scene-grid');
    expect(grid).toHaveAttribute('data-columns', '1');
  });

  it('768px 显示 3 列', async () => {
    setViewportWidth(768);
    renderApp({ route: '/' });
    const grid = await screen.findByTestId('scene-grid');
    expect(grid).toHaveAttribute('data-columns', '3');
  });

  it('点击场景卡片可打开对应场景', async () => {
    renderApp({ route: '/' });
    const card = await screen.findByRole('link', { name: '打开场景 上海陆家嘴天际线' });
    await userEvent.click(card);
    expect(await screen.findByTestId('scene-viewer-page')).toBeInTheDocument();
  });

  it('键盘 Enter 可打开场景卡片', async () => {
    renderApp({ route: '/' });
    const card = await screen.findByRole('link', { name: '打开场景 东京塔落日全景' });
    card.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('scene-viewer-page')).toBeInTheDocument();
  });

  it('收藏按钮不触发页面跳转，而是提示阶段信息', async () => {
    renderApp({ route: '/' });
    const favBtn = await screen.findByRole('button', { name: '收藏 上海陆家嘴天际线' });
    await userEvent.click(favBtn);
    // 未跳转到 viewer 页面
    expect(screen.queryByTestId('scene-viewer-page')).not.toBeInTheDocument();
    // antd message 提示出现
    expect(await screen.findByText(/收藏功能将在 Phase 08 接入/)).toBeInTheDocument();
  });
});