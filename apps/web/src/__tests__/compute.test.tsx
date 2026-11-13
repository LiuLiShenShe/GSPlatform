import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/utils';

const mocks = vi.hoisted(() => ({
  fetchProfiles: vi.fn(),
  fetchCapabilities: vi.fn(),
  submitReconstruction: vi.fn(),
  fetchJob: vi.fn(),
  fetchSegmentationPreview: vi.fn(),
  cancelJob: vi.fn(),
  createUploadSession: vi.fn(),
  ResumableUploader: vi.fn(),
}));

vi.mock('../features/compute/computeApi', () => ({
  fetchProfiles: mocks.fetchProfiles,
  fetchCapabilities: mocks.fetchCapabilities,
  submitReconstruction: mocks.submitReconstruction,
  fetchJob: mocks.fetchJob,
  fetchSegmentationPreview: mocks.fetchSegmentationPreview,
  cancelJob: mocks.cancelJob,
}));

vi.mock('../features/upload/ResumableUploader', () => ({
  createUploadSession: mocks.createUploadSession,
  ResumableUploader: mocks.ResumableUploader,
  UploadCancelledError: class UploadCancelledError extends Error {
    name = 'UploadCancelledError';
  },
}));

const PROFILES = [
  { name: 'draft', version: 1, maxInputBytes: 1_048_576_000, maxImages: 80, maxVideoSeconds: 300, iterations: 1200, stages: ['PROBING', 'EXTRACTING'] },
  { name: 'standard', version: 1, maxInputBytes: 4_294_967_296, maxImages: 300, maxVideoSeconds: 1200, iterations: 8000, stages: ['PROBING', 'EXTRACTING'] },
  { name: 'high', version: 1, maxInputBytes: 8_589_934_592, maxImages: 800, maxVideoSeconds: 2400, iterations: 30_000, stages: ['PROBING', 'EXTRACTING'] },
];

const CAPABILITIES_OK = {
  ok: true,
  tools: { ffmpeg: '/usr/bin/ffmpeg', colmap: '/usr/bin/colmap' },
  gpu: { available: false, name: 'CPU', vramMb: 0 },
  problems: [],
};

const JOB_RUNNING = {
  id: 'job-1',
  sceneId: 'scene-1',
  kind: 'RECONSTRUCT',
  status: 'RUNNING',
  progress: 42,
  stage: 'FEATURES',
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** 选一个合法视频文件并等待真实上传链路（mock 会话 + 完成事件）走完。 */
async function addVideoFile(): Promise<void> {
  const input = document.querySelector('input[type=file]')!;
  fireEvent.change(input, {
    target: { files: [new File(['x'], 'test.mp4', { type: 'video/mp4' })] },
  });
  await screen.findByText(/全部上传完成/);
}

describe('免费计算页（ComputePage）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.fetchProfiles.mockResolvedValue(PROFILES);
    mocks.fetchCapabilities.mockResolvedValue(CAPABILITIES_OK);
    mocks.submitReconstruction.mockResolvedValue({
      jobId: 'job-1',
      status: 'QUEUED',
      stage: null,
      progress: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      sceneId: 'scene-1',
    });
    mocks.fetchJob.mockResolvedValue(JOB_RUNNING);
    mocks.fetchSegmentationPreview.mockResolvedValue({ ready: false, frames: [] });
    mocks.cancelJob.mockResolvedValue({
      ...JOB_RUNNING,
      status: 'CANCELLED',
    });
    mocks.createUploadSession.mockResolvedValue({
      uploadId: 'up-1',
      status: 'CREATED',
      offset: 0,
      totalSize: 100,
      chunkMaxBytes: 8 * 1024 * 1024,
    });
    mocks.ResumableUploader.mockImplementation((_file, session, onEvent) => ({
      run: async () => {
        onEvent({
          type: 'completed',
          result: { uploadId: session.uploadId, status: 'UPLOADED', jobId: null },
        });
      },
      cancel: vi.fn(async () => {}),
    }));
  });

  it('未选文件时「下一步」按钮不可用', () => {
    renderApp({ route: '/compute' });
    expect(screen.getByRole('button', { name: /下一步/ })).toBeDisabled();
  });

  it('添加有效文件后真实上传完成，可进入参数确认步骤', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    expect(mocks.createUploadSession).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'RECONSTRUCT', format: 'mp4' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    expect(screen.getByText('我拥有素材权利并同意处理规则')).toBeInTheDocument();
  });

  it('权利确认未勾选时提交按钮不可用并提示', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    const submit = screen.getByRole('button', { name: /提交计算/ });
    expect(submit).toBeDisabled();
    expect(screen.getByText(/请先确认您拥有素材权利/)).toBeInTheDocument();
  });

  it('勾选权利后提交按钮可用（原「后端未接入」占位行为已移除）', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    await userEvent.click(screen.getByRole('checkbox'));
    const submit = screen.getByRole('button', { name: /提交计算/ });
    expect(submit).toBeEnabled();
  });

  it('提交后进入排队与计算步骤并轮询展示真实阶段', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /提交计算/ }));

    expect(mocks.submitReconstruction).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadIds: ['up-1'],
        profile: 'draft',
        sceneTitle: 'test',
        visibility: 'PUBLIC',
      }),
    );
    // 轮询 GET /jobs/{id} 返回 RUNNING + FEATURES 阶段，页面展示中文阶段名
    expect(await screen.findByText('特征提取')).toBeInTheDocument();
  });

  it('重建输出默认公开，素材仍私有；明确选择私有后保持私有', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    expect(mocks.createUploadSession).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'RECONSTRUCT', visibility: 'PRIVATE' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    expect(screen.getByText('公开场景可被任何获得地址的人查看。')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('combobox', { name: '可见性' }));
    await userEvent.click(screen.getByText('私有', { selector: '.ant-select-item-option-content' }));
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /提交计算/ }));
    expect(mocks.submitReconstruction).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'PRIVATE' }),
    );
  });

  it('能力探测受限时展示警告但仍允许继续', async () => {
    mocks.fetchCapabilities.mockResolvedValue({
      ...CAPABILITIES_OK,
      ok: false,
      problems: ['未检测到可用 GPU，将使用 CPU 回退'],
    });
    renderApp({ route: '/compute' });
    await addVideoFile();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    expect(await screen.findByText('计算能力受限')).toBeInTheDocument();
    expect(screen.getByText(/未检测到可用 GPU/)).toBeInTheDocument();
  });

  it('刷新前的 beforeunload 提醒在有未保存输入时触发', async () => {
    const spy = vi.spyOn(window, 'addEventListener');
    renderApp({ route: '/compute' });
    const input = document.querySelector('input[type=file]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'video.mp4', { type: 'video/mp4' })] },
    });
    await waitFor(() => expect(mocks.createUploadSession).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith('beforeunload', expect.any(Function));
    spy.mockRestore();
  });

  it('目标模式要求提示词，并把保留目标参数交给真实提交接口', async () => {
    renderApp({ route: '/compute' });
    await addVideoFile();
    await userEvent.click(screen.getByRole('button', { name: /下一步：参数确认/ }));
    await userEvent.click(screen.getByRole('combobox', { name: '重建模式' }));
    await userEvent.click(screen.getByText('提示词目标重建', { selector: '.ant-select-item-option-content' }));
    await userEvent.click(screen.getByRole('checkbox'));
    const submit = screen.getByRole('button', { name: /提交计算/ });
    expect(submit).toBeDisabled();
    await userEvent.type(screen.getByLabelText('分割提示词'), 'potted plant; blue cube');
    await userEvent.click(submit);
    expect(mocks.submitReconstruction).toHaveBeenCalledWith(expect.objectContaining({
      segmentation: { mode: 'KEEP_PROMPTED_OBJECT', prompt: 'potted plant; blue cube' },
    }));
  });

  it.each([null, { sceneSlug: 'plant', versionId: 'version-1', assetVersion: 'v1',
    editUrl: 'https://invalid.example/model/edit/plant', viewUrl: '/scene/plant' }])(
    '成功任务缺少有效发布结果时保持在任务页', async result => {
      localStorage.setItem('gs-reconstruction-job', 'job-1');
      mocks.fetchJob.mockResolvedValue({ ...JOB_RUNNING, status: 'SUCCEEDED', result });
      const { router } = renderApp({ route: '/compute' });
      await waitFor(() => expect(mocks.fetchJob).toHaveBeenCalled());
      expect(router.state.location.pathname).toBe('/compute');
    });

  it('成功后用后端给出的真实 slug 和版本进入尺度标定', async () => {
    localStorage.setItem('gs-reconstruction-job', 'job-1');
    const editUrl = '/model/edit/shanghai-lujiazui?workspace=calibration&version=version-1';
    mocks.fetchJob.mockResolvedValue({ ...JOB_RUNNING, status: 'SUCCEEDED', result: {
      sceneSlug: 'shanghai-lujiazui', versionId: 'version-1', assetVersion: 'v1', editUrl,
      viewUrl: '/scene/shanghai-lujiazui',
    } });
    const { router } = renderApp({ route: '/compute' });
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe(editUrl));
  });

  it('批量照片上传最多同时创建三个会话，并在完成后继续队列', async () => {
    const finish: (() => void)[] = [];
    mocks.ResumableUploader.mockImplementation((_file, session, onEvent) => ({
      run: () => new Promise<void>(resolve => finish.push(() => {
        onEvent({ type: 'completed', result: { uploadId: session.uploadId, status: 'UPLOADED', jobId: null } });
        resolve();
      })), cancel: vi.fn(async () => {}),
    }));
    renderApp({ route: '/compute' });
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files:
      Array.from({ length: 6 }, (_, i) => new File(['x'], `${i}.jpg`, { type: 'image/jpeg' })),
    } });
    await waitFor(() => expect(mocks.createUploadSession).toHaveBeenCalledTimes(3));
    finish.shift()!();
    await waitFor(() => expect(mocks.createUploadSession).toHaveBeenCalledTimes(4));
    for (const complete of finish.splice(0)) complete();
    await waitFor(() => expect(mocks.createUploadSession).toHaveBeenCalledTimes(6));
    for (const complete of finish.splice(0)) complete();
    expect(await screen.findByText(/全部上传完成/)).toBeInTheDocument();
  });
});
