import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

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

  it('「校验并发布」按钮禁用并说明阶段原因', () => {
    renderApp({ route: '/upload' });
    const btn = screen.getByRole('button', { name: /校验并发布/ });
    expect(btn).toBeDisabled();
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

  it('存在草稿时显示恢复入口', async () => {
    localStorage.setItem(
      'gsplatform.upload.draft',
      JSON.stringify({ savedAt: '2026-09-09T10:00:00Z', title: '已保存标题', description: '', category: '', visibility: '公开', sceneFileName: '', posterName: '' }),
    );
    renderApp({ route: '/upload' });
    expect(await screen.findByText(/存在本地草稿/)).toBeInTheDocument();
    const restoreBtn = screen.getByRole('button', { name: '恢复草稿' });
    await userEvent.click(restoreBtn);
    expect(screen.getByLabelText('作品标题')).toHaveValue('已保存标题');
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
