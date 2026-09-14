import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

vi.mock('../services/sceneApi', async () => {
  const { sceneFixtures } = await vi.importActual<typeof import('../fixtures/scenes')>('../fixtures/scenes');
  return {
    fetchSceneList: vi.fn(async () => sceneFixtures),
    findScene: vi.fn(async () => sceneFixtures[0]),
  };
});

describe('首页搜索', () => {
  it('输入关键词后按 Enter 提交并过滤结果', async () => {
    renderApp({ route: '/' });
    const input = await screen.findByLabelText('搜索场景、作者…');
    await userEvent.type(input, '东京塔');
    await userEvent.keyboard('{Enter}');
    const grid = await screen.findByTestId('scene-grid');
    expect(grid.children.length).toBe(1);
    expect(screen.getByText('东京塔落日全景')).toBeInTheDocument();
  });

  it('URL 查询参数 q 存在时首页按关键词预过滤', async () => {
    renderApp({ route: '/?q=桂林' });
    const grid = await screen.findByTestId('scene-grid');
    expect(grid.children.length).toBe(1);
    expect(screen.getByText('桂林阳朔喀斯特地貌')).toBeInTheDocument();
  });

  it('无匹配关键词时显示空状态', async () => {
    renderApp({ route: '/?q=不存在的关键词xyz' });
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
  });

  it('点击「清空搜索条件」恢复完整列表', async () => {
    renderApp({ route: '/?q=不存在的关键词xyz' });
    expect(await screen.findByText(/没有匹配/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '清空搜索条件' }));
    const grid = await screen.findByTestId('scene-grid');
    expect(grid.children.length).toBe(12);
  });

  it('分类按钮切换后内容改变（城市分类）', async () => {
    renderApp({ route: '/' });
    await screen.findByTestId('scene-grid');
    await userEvent.click(screen.getByRole('button', { name: '城市' }));
    const grid = await screen.findByTestId('scene-grid');
    // 城市: 上海陆家嘴 + 东京塔 → 2
    expect(grid.children.length).toBe(2);
    expect(screen.getByText('上海陆家嘴天际线')).toBeInTheDocument();
    expect(screen.getByText('东京塔落日全景')).toBeInTheDocument();
  });
});