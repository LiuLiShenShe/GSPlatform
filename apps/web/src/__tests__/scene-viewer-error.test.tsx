/**
 * SSV-03 — 官方 Desktop Viewer 错误/重试 UI 测试。
 *
 * 独立文件：getSceneRuntime 模块 mock 为「抛错」，验证
 *   - 描述获取失败 → 显示错误面板（ov-error）+ 重试按钮
 *   - 点击重试 → 重新走完整 boot（再次调用 getSceneRuntime）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

const getSceneRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock('../scene-runtime/runtimeApi', () => ({
  getSceneRuntime: getSceneRuntimeMock,
  RuntimeApiError: class RuntimeApiError extends Error {
    kind: string;
    status: number | null;
    constructor(kind: string, status: number | null, message: string) {
      super(message);
      this.name = 'RuntimeApiError';
      this.kind = kind;
      this.status = status;
    }
  },
}));

// 官方 viewer 永远不会被创建（描述阶段就失败），只需存在性 stub
vi.mock('@playcanvas/supersplat-viewer/viewer', () => ({
  createViewer: vi.fn(async () => {
    throw new Error('createViewer should not be reached');
  }),
}));

vi.mock('../services/sceneApi', async () => {
  const { sceneFixtures } = await vi.importActual<typeof import('../fixtures/scenes')>('../fixtures/scenes');
  return {
    fetchSceneList: vi.fn(async () => sceneFixtures),
    findScene: vi.fn(async () => sceneFixtures[0]),
  };
});

beforeEach(() => {
  getSceneRuntimeMock.mockReset();
});

describe('SSV-03: 官方 Viewer 错误与重试', () => {
  it('描述获取失败时显示错误面板与错误详情', async () => {
    getSceneRuntimeMock.mockRejectedValue(new Error('网络异常：无法连接运行时服务'));
    renderApp({ route: '/scene/local-garden' });

    const err = await screen.findByTestId('ov-error');
    expect(err).toBeInTheDocument();
    expect(err.textContent).toContain('场景加载失败');
    expect(err.textContent).toContain('网络异常：无法连接运行时服务');
    expect(screen.getByTestId('ov-retry')).toBeInTheDocument();
  });

  it('点击重试重新拉取描述', async () => {
    getSceneRuntimeMock.mockRejectedValue(new Error('boom'));
    renderApp({ route: '/scene/local-garden' });

    await screen.findByTestId('ov-retry');
    expect(getSceneRuntimeMock).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('ov-retry'));
    await waitFor(() => expect(getSceneRuntimeMock).toHaveBeenCalledTimes(2));
  });
});
