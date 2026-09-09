import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

describe('免费计算页（ComputePage）', () => {
  it('未选文件时「下一步」按钮不可用', () => {
    renderApp({ route: '/compute' });
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
  });

  it('添加有效文件后可进入参数确认步骤', async () => {
    renderApp({ route: '/compute' });
    // The Upload.Dragger renders as a div; find the file input via the hidden input
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'test.mp4', { type: 'video/mp4' })] },
    });
    expect(await screen.findByText(/已选择 1 个文件/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    expect(screen.getByText('我拥有素材权利并同意处理规则')).toBeInTheDocument();
  });

  it('权利确认未勾选时提交按钮不可用', async () => {
    renderApp({ route: '/compute' });
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'test.mp4', { type: 'video/mp4' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    const submit = screen.getByRole('button', { name: /提交计算/ });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/请先确认您拥有素材权利/)).toBeInTheDocument();
  });

  it('勾选权利后提交按钮仍禁用并提示后端未接入', async () => {
    renderApp({ route: '/compute' });
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'test.mp4', { type: 'video/mp4' })] },
    });
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    await userEvent.click(screen.getByRole('checkbox'));
    const submit = screen.getByRole('button', { name: /提交计算/ });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/计算服务将在 Phase 06\/07 接入/)).toBeInTheDocument();
  });

  it('刷新前的 beforeunload 提醒在有未保存输入时触发', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    renderApp({ route: '/compute' });
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'video.mp4', { type: 'video/mp4' })] },
    });
    expect(spy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    spy.mockRestore();
  });
});
