/**
 * FIX-03 §16 — PanoramaViewer 挂载/卸载契约测试。
 *
 * 覆盖：
 *   - 挂载 → 以等距柱状配置构造官方 @photo-sphere-viewer Viewer（2:1 球面映射、
 *     minFov/maxFov zoom 界、navbar zoom/fullscreen）；
 *   - ready → 加载完成态；panorama-error → 错误态（不伪造 360°）；
 *   - 卸载 → viewer.destroy()（释放 WebGL/事件/纹理，§4）+ 容器清空 + 只创建一次。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { PanoramaViewer } from '../features/media/PanoramaViewer';

// vi.hoisted：mock 工厂内可访问的实例记录（mock 被提升，外部普通变量不可引用）。
const { viewerInstances } = vi.hoisted(() => ({
  viewerInstances: [] as Array<{
    config: Record<string, unknown>;
    listeners: Record<string, Array<(e?: unknown) => void>>;
    destroyed: boolean;
  }>,
}));

vi.mock('@photo-sphere-viewer/core', () => ({
  Viewer: class {
    config: Record<string, unknown>;
    listeners: Record<string, Array<(e?: unknown) => void>> = {};
    destroyed = false;
    constructor(config: Record<string, unknown>) {
      this.config = config;
      viewerInstances.push(this);
    }
    addEventListener(type: string, cb: (e?: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }
    destroy() {
      this.destroyed = true;
      this.listeners = {};
    }
  },
}));

function trigger(instanceIndex: number, type: string, payload?: unknown): void {
  const listeners = viewerInstances[instanceIndex]?.listeners[type];
  if (!listeners || listeners.length === 0) throw new Error(`no "${type}" listener`);
  for (const cb of listeners) cb(payload);
}

beforeEach(() => {
  viewerInstances.length = 0;
});

describe('PanoramaViewer', () => {
  it('挂载 → 以 2:1 等距柱状配置构造 Viewer（minFov/maxFov/navbar）', () => {
    render(<PanoramaViewer mediaUrl="https://cdn.example/panorama.jpg" title="全景" />);
    expect(viewerInstances).toHaveLength(1);
    const config = viewerInstances[0].config;
    expect(config.panorama).toBe('https://cdn.example/panorama.jpg');
    expect(config.minFov).toBe(40);
    expect(config.maxFov).toBe(110);
    expect(config.mousewheel).toBe(true);
    expect(config.touchmoveTwoFingers).toBe(true);
    expect(config.navbar).toContain('zoom');
    expect(config.navbar).toContain('fullscreen');
    // 加载中占位可见
    expect(screen.getByTestId('panorama-loading')).toBeInTheDocument();
  });

  it('ready 事件 → 隐藏 loading（显示真实 360° 舞台）', () => {
    render(<PanoramaViewer mediaUrl="https://cdn.example/p.jpg" />);
    act(() => trigger(0, 'ready'));
    expect(screen.queryByTestId('panorama-loading')).toBeNull();
    expect(screen.getByTestId('annotation-media-panorama')).toBeInTheDocument();
  });

  it('panorama-error → 错误态（payload.error.message），不显示 360°', () => {
    render(<PanoramaViewer mediaUrl="https://cdn.example/broken.jpg" />);
    act(() => trigger(0, 'panorama-error', { error: new Error('HTTP 404') }));
    expect(screen.getByTestId('panorama-error')).toHaveTextContent('HTTP 404');
    expect(screen.queryByTestId('panorama-loading')).toBeNull();
  });

  it('卸载 → destroy() 释放（§4），不残留已销毁 viewer', () => {
    const { unmount } = render(<PanoramaViewer mediaUrl="https://cdn.example/p.jpg" />);
    unmount();
    expect(viewerInstances).toHaveLength(1);
    expect(viewerInstances[0].destroyed).toBe(true);
  });

  it('mediaUrl 为 null → 不构造 viewer，不渲染', () => {
    const { container } = render(<PanoramaViewer mediaUrl={null} />);
    expect(viewerInstances).toHaveLength(0);
    expect(container.querySelector('.gs-panorama')).toBeNull();
  });
});