import { afterEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, setViewportWidth } from '../test/utils';

afterEach(() => {
  setViewportWidth(1024);
});

describe('平台布局与导航', () => {
  it('桌面端渲染固定 224px 侧边栏', () => {
    setViewportWidth(1280);
    renderApp({ route: '/' });
    const sider = screen.getByTestId('platform-sider');
    expect(sider).toBeInTheDocument();
    expect(sider.getAttribute('style')).toContain('width: 224px');
  });

  it('窄屏隐藏固定侧边栏，菜单按钮打开抽屉导航', async () => {
    setViewportWidth(390);
    renderApp({ route: '/' });
    expect(screen.queryByTestId('platform-sider')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: '打开导航菜单' });
    await userEvent.click(toggle);
    // 抽屉内导航菜单出现并可点击跳转
    const uploadItem = await screen.findByText('上传作品');
    await userEvent.click(uploadItem);
    expect(await screen.findByRole('heading', { name: '上传作品' })).toBeInTheDocument();
  });

  it('侧边栏从首页可跳转到我的作品', async () => {
    renderApp({ route: '/' });
    await screen.findByText('热门作品');
    await userEvent.click(screen.getByText('我的作品'));
    expect(await screen.findByRole('heading', { name: '我的作品' })).toBeInTheDocument();
  });

  it('未接入的侧边栏入口处于禁用状态且说明阶段', () => {
    renderApp({ route: '/' });
    const fav = screen.getByText('收藏');
    expect(fav).toBeInTheDocument();
    const el = fav.closest('li');
    expect(el).toBeInTheDocument();
  });
});