import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from '../test/utils';

vi.mock('../services/sceneApi', async () => {
  const { sceneFixtures } = await vi.importActual<typeof import('../fixtures/scenes')>('../fixtures/scenes');
  return {
    fetchSceneList: vi.fn(async () => sceneFixtures),
    findScene: vi.fn(async () => sceneFixtures[0]),
  };
});

vi.mock('../services/worksApi', async () => {
  const { myWorksFixtures } = await vi.importActual('../fixtures/myWorks');
  return {
    fetchMyWorks: vi.fn(async () => myWorksFixtures),
  };
});

describe('五个核心路由与 404 页面', () => {
  it('首页 / 可直接访问', async () => {
    renderApp({ route: '/' });
    expect(await screen.findByText('热门作品')).toBeInTheDocument();
    expect(await screen.findByTestId('scene-grid')).toBeInTheDocument();
  });

  it('/works 我的作品页', async () => {
    renderApp({ route: '/works' });
    expect(await screen.findByText('全部 12')).toBeInTheDocument();
    expect(screen.getByLabelText('搜索作品标题（服务端匹配）')).toBeInTheDocument();
  });

  it('/compute 免费计算页（三步流程）', () => {
    renderApp({ route: '/compute' });
    // The Steps item title "上传素材" is rendered, no sidebar duplication
    expect(screen.getByText('上传素材')).toBeInTheDocument();
    expect(screen.getByText('下一步：参数确认')).toBeInTheDocument();
  });

  it('/upload 上传作品页', () => {
    renderApp({ route: '/upload' });
    expect(screen.getByLabelText('作品标题')).toBeInTheDocument();
  });

  it('/scene/:sceneId 使用全屏 Viewer 挂载区且无平台侧边栏', async () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    expect(screen.queryByTestId('platform-sider')).not.toBeInTheDocument();
    expect(await screen.findByTestId('viewer-mount')).toBeInTheDocument();
    // Phase 02：真实 Viewer 挂载区（iframe 由 ViewerAdapter 注入）
    expect(screen.getByTestId('viewer-canvas-host').querySelector('iframe')).toBeInTheDocument();
  });

  it('/health-ui 保留 Phase 00 健康页面', async () => {
    renderApp({ route: '/health-ui' });
    expect(await screen.findByText('Web Build Health')).toBeInTheDocument();
  });

  it('未知路由渲染 404 页面', async () => {
    renderApp({ route: '/a-route-that-does-not-exist' });
    expect(await screen.findByText('404')).toBeInTheDocument();
    expect(screen.getByText('页面不存在或已被移除。')).toBeInTheDocument();
  });
});
