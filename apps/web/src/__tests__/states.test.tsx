import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';
import { sceneFixtures } from '../fixtures/scenes';
import { myWorksFixtures } from '../fixtures/myWorks';

vi.mock('../services/sceneApi');
vi.mock('../services/worksApi');

import { fetchSceneList } from '../services/sceneApi';
import { fetchMyWorks } from '../services/worksApi';

const mockFetchScenes = vi.mocked(fetchSceneList);
const mockFetchWorks = vi.mocked(fetchMyWorks);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('首页与作品页加载 / 错误 / 空状态', () => {
  it('首页显示加载中状态', async () => {
    mockFetchScenes.mockReturnValueOnce(new Promise(() => {})); // 永不 resolve
    renderApp({ route: '/' });
    expect(await screen.findByText('正在加载场景…')).toBeInTheDocument();
  });

  it('首页错误状态可重试并恢复', async () => {
    mockFetchScenes.mockRejectedValueOnce(new Error('网络异常'));
    renderApp({ route: '/' });
    expect(await screen.findByText('场景加载失败')).toBeInTheDocument();
    mockFetchScenes.mockResolvedValueOnce(sceneFixtures);
    // antd auto-inserts space in 2-char CJK buttons
    await userEvent.click(screen.getByText('重 试'));
    expect(await screen.findByTestId('scene-grid')).toBeInTheDocument();
    expect(screen.getByText('上海陆家嘴天际线')).toBeInTheDocument();
  });

  it('首页空状态（无结果）', async () => {
    mockFetchScenes.mockResolvedValueOnce([]);
    renderApp({ route: '/' });
    expect(await screen.findByText(/没有符合条件的场景/)).toBeInTheDocument();
  });

  it('我的作品页错误状态可重试并恢复', async () => {
    mockFetchWorks.mockRejectedValueOnce(new Error('网络异常'));
    renderApp({ route: '/works' });
    expect(await screen.findByText('作品列表加载失败')).toBeInTheDocument();
    mockFetchWorks.mockResolvedValueOnce(myWorksFixtures);
    await userEvent.click(screen.getByText('重 试'));
    expect(await screen.findByText('全部 12')).toBeInTheDocument();
  });

  it('我的作品页空状态（空数组）', async () => {
    mockFetchWorks.mockResolvedValueOnce([]);
    renderApp({ route: '/works' });
    expect(await screen.findByText(/当前筛选条件下没有作品/)).toBeInTheDocument();
  });
});
