import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

describe('全屏 Scene Viewer 外壳', () => {
  it('无平台侧边栏，渲染挂载区域', () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    expect(screen.queryByTestId('platform-sider')).not.toBeInTheDocument();
    expect(screen.getByTestId('viewer-mount')).toBeInTheDocument();
  });

  it('右侧面板按钮顺序：作者 / 收藏 / 分享 / 问 AI / 详情', () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    const panel = screen.getByLabelText('场景操作面板');
    const buttons = within(panel)
      .getAllByRole('button')
      .map((btn) => btn.textContent?.trim());
    expect(buttons).toEqual(['作者', '收藏', '分享', '问 AI', '详情']);
  });

  it('底部工具条顺序：Reset / Orbit-Fly / Performance / Quality / Help', () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    const toolbar = screen.getByLabelText('Viewer 工具条');
    const text = toolbar.textContent ?? '';
    expect(text).toContain('Reset');
    expect(text).toContain('Orbit');
    expect(text).toContain('Fly');
    expect(text).toContain('Performance');
    expect(text).toContain('Quality');
    expect(text).toContain('Help');
    expect(text.indexOf('Reset')).toBeLessThan(text.indexOf('Orbit'));
    expect(text.indexOf('Performance')).toBeLessThan(text.indexOf('Quality'));
  });

  it('未实现按钮禁用，不伪造 Viewer 能力', () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    const toolbar = screen.getByLabelText('Viewer 工具条');
    const reset = within(toolbar).getByRole('button', { name: /Reset/ });
    const perf = within(toolbar).getByRole('button', { name: /Performance/ });
    expect(reset).toBeDisabled();
    expect(perf).toBeDisabled();
  });

  it('点击 Help 打开说明面板', async () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    await userEvent.click(screen.getByRole('button', { name: /Help/ }));
    expect(await screen.findByText(/Phase 02 将在此挂载区域集成 SuperSplat/)).toBeInTheDocument();
    expect(screen.getByText(/本阶段不展示伪造的 3D 渲染/)).toBeInTheDocument();
  });

  it('场景标题显示 sceneId，返回按钮可回到首页', async () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    expect(screen.getByText('场景 shanghai-lujiazui')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '关闭场景' }));
    expect(await screen.findByText('热门作品')).toBeInTheDocument();
  });

  it('右侧按钮顺序测试详情面板', async () => {
    renderApp({ route: '/scene/shanghai-lujiazui' });
    await userEvent.click(screen.getByRole('button', { name: '详情' }));
    expect(await screen.findByText('高斯点数')).toBeInTheDocument();
  });
});