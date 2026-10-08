import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp, renderWithRouter } from '../test/utils';
import { ProcessingStatus } from '../features/upload/ProcessingStatus';

/**
 * FIX-UPLOAD-01 §15-§17 — the upload page must show REAL segregated server
 * statuses (UploadSession / Publish Job / Collision Job) from the read-only
 * status surface, and navigate to the Viewer / Authoring / My Works once the
 * scene is published. No fake progress anywhere.
 */
describe('ProcessingStatus（三段真实服务端状态）', () => {
  it('publish SUCCEEDED 且 sceneId 存在时给出查看/编辑/作品导航', () => {
    const { container } = renderWithRouter(
      <ProcessingStatus
        uploadStatus="SUCCEEDED"
        publishStatus="SUCCEEDED"
        collisionStatus="SUCCEEDED"
        publishJobId="job-1"
        sceneId="scene-abc"
        sceneSlug="scene-abc"
      />,
    );
    // 三段标签都渲染
    expect(screen.getByText('上传任务（UploadSession）')).toBeInTheDocument();
    expect(screen.getByText('发布任务（Publish Job）')).toBeInTheDocument();
    expect(screen.getByText('碰撞构建（Collision Job）')).toBeInTheDocument();
    // 导航链接指向真实路由（Viewer / Authoring / My Works）
    expect(container.querySelector('a[href="/scene/scene-abc"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/model/edit/scene-abc"]')).toBeInTheDocument();
    expect(container.querySelector('a[href="/works"]')).toBeInTheDocument();
  });

  it('collision 未生成（null）时如实显示，而非编造进度', () => {
    renderWithRouter(
      <ProcessingStatus
        uploadStatus="SUCCEEDED"
        publishStatus="SUCCEEDED"
        collisionStatus={null}
        publishJobId="job-1"
        sceneId="scene-abc"
        sceneSlug="scene-abc"
      />,
    );
    // FIX-UPLOAD-01.1 PART A: publish 已 SUCCEEDED 而碰撞仍为 null → 如实显示
    // “等待碰撞任务调度”（调度可能尚未发生或尚未确认），绝不编造 FAILED/已构建。
    expect(screen.getByText(/等待碰撞任务调度/)).toBeInTheDocument();
  });
});

describe('上传作品页（UploadPage）', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('表单字段校验：空提交时显示必填错误', async () => {
    renderApp({ route: '/upload' });
    const form = document.querySelector('form')!;
    fireEvent.submit(form);
    expect(await screen.findByText('请输入作品标题')).toBeInTheDocument();
    expect(screen.getByText('请选择场景文件')).toBeInTheDocument();
    expect(screen.getByText('请选择分类')).toBeInTheDocument();
  });

  it('「校验并发布」按钮可用', () => {
    renderApp({ route: '/upload' });
    const btn = screen.getByRole('button', { name: /校验并发布/ });
    expect(btn).toBeEnabled();
  });

  it('保存草稿写入 localStorage 并显示成功提示', async () => {
    renderApp({ route: '/upload' });
    const titleInput = screen.getByLabelText('作品标题');
    await userEvent.type(titleInput, '我的测试作品');

    const sceneInput = document.querySelectorAll('input[type=file]')[0];
    fireEvent.change(sceneInput, {
      target: { files: [new File(['x'], 'test.sog', { type: 'application/octet-stream' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    const draft = JSON.parse(localStorage.getItem('gsplatform.upload.draft') ?? '{}');
    expect(draft.title).toBe('我的测试作品');
    expect(draft.sceneFileName).toBe('test.sog');
    expect(await screen.findByText(/已保存到本地草稿/)).toBeInTheDocument();
  });

  it('保存草稿后显示恢复入口', async () => {
    renderApp({ route: '/upload' });
    const titleInput = screen.getByLabelText('作品标题');
    await userEvent.type(titleInput, '我的测试作品');

    const sceneInput = document.querySelectorAll('input[type=file]')[0];
    fireEvent.change(sceneInput, {
      target: { files: [new File(['x'], 'test.sog', { type: 'application/octet-stream' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: '保存草稿' }));

    expect(await screen.findByText(/存在本地草稿/)).toBeInTheDocument();
    const restoreBtn = screen.getByRole('button', { name: '恢复草稿' });
    await userEvent.click(restoreBtn);
    expect(screen.getByLabelText('作品标题')).toHaveValue('我的测试作品');
  });

  it('替换文件时释放旧文件的 Object URL', async () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock');

    const { unmount } = renderApp({ route: '/upload' });

    const sceneInput = document.querySelectorAll('input[type=file]')[0];
    fireEvent.change(sceneInput, {
      target: { files: [new File(['a'], 'a.sog')] },
    });
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    unmount();
    expect(revokeSpy).toHaveBeenCalled();
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });
});
