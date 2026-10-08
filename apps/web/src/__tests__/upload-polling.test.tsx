import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, renderHook, screen } from '@testing-library/react';
import { renderApp } from '../test/utils';
import {
  PROCESSING_MAX_BACKOFF_MS,
  PROCESSING_OBSERVATION_LIMIT_MS,
  PROCESSING_POLL_INTERVAL_MS,
  shouldStopProcessingPoll,
  useUploadProcessingPoll,
} from '../features/upload/useUploadProcessingPoll';
import type { UploadProcessingStatus } from '../features/upload/ResumableUploader';

/**
 * FIX-UPLOAD-01.1 §A — RED-first tests for the processing-poll lifecycle.
 *
 * The OLD UploadPage stop condition was:
 *     (upload SUCCEEDED/FAILED) && (publish SUCCEEDED/FAILED/null) → stop
 * which terminated the poll as soon as publish SUCCEEDED — while the auto
 * collision job had not even been dispatched (collision null), or was still
 * QUEUED/RUNNING.  These tests lock the CORRECT semantics (§A2): the poll
 * keeps watching after publish SUCCEEDED until the collision job reaches a
 * terminal state, with cleanup / stale-response guards / bounded backoff /
 * observation cap (§A4).
 */

vi.mock('../features/upload/ResumableUploader', () => ({
  createUploadSession: vi.fn(),
  ResumableUploader: vi.fn(),
  fetchUploadProcessingStatus: vi.fn(),
}));

import {
  fetchUploadProcessingStatus,
  ResumableUploader,
  createUploadSession,
  type CompleteResult,
  type UploadEvent,
  type UploadSessionInfo,
} from '../features/upload/ResumableUploader';

function status(over: Partial<UploadProcessingStatus> = {}): UploadProcessingStatus {
  return {
    uploadId: 'up-1',
    status: 'SUCCEEDED',
    sceneId: 'scene-1',
    sceneSlug: 'scene-1',
    publishJobId: 'job-p1',
    publishStatus: 'SUCCEEDED',
    collisionJobId: 'job-c1',
    collisionStatus: null,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ── §A2 — pure terminal predicate ───────────────────────────────────────────
describe('shouldStopProcessingPoll（§A2 停止条件）', () => {
  it('publish SUCCEEDED + collision null → 不停止（等待调度）', () => {
    expect(shouldStopProcessingPoll(status({ collisionStatus: null }))).toBe(false);
  });
  it('publish SUCCEEDED + collision QUEUED → 不停止', () => {
    expect(shouldStopProcessingPoll(status({ collisionStatus: 'QUEUED' }))).toBe(false);
  });
  it('publish SUCCEEDED + collision RUNNING → 不停止', () => {
    expect(shouldStopProcessingPoll(status({ collisionStatus: 'RUNNING' }))).toBe(false);
  });
  it('publish SUCCEEDED + collision SUCCEEDED → 停止', () => {
    expect(shouldStopProcessingPoll(status({ collisionStatus: 'SUCCEEDED' }))).toBe(true);
  });
  it('publish SUCCEEDED + collision FAILED → 停止', () => {
    expect(shouldStopProcessingPoll(status({ collisionStatus: 'FAILED' }))).toBe(true);
  });
  it('publish FAILED（即使 upload SUCCEEDED）→ 停止', () => {
    expect(shouldStopProcessingPoll(status({ publishStatus: 'FAILED', collisionStatus: null }))).toBe(true);
  });
  it('upload FAILED → 停止', () => {
    expect(shouldStopProcessingPoll(status({ status: 'FAILED' }))).toBe(true);
  });
  it('upload RUNNING / publish null → 不停止', () => {
    expect(shouldStopProcessingPoll(status({ status: 'RUNNING', publishStatus: null, collisionStatus: null }))).toBe(false);
    expect(shouldStopProcessingPoll(status({ publishStatus: null, collisionStatus: null }))).toBe(false);
  });
});

// ── §A1/§A2/§E6 — hook lifecycle with a controlled sequence ────────────────
describe('useUploadProcessingPoll（轮询生命周期）', () => {
  it('publish SUCCEEDED 后不提前终止：持续观察到 collision 终态', async () => {
    const seq = [
      status({ status: 'RUNNING', publishStatus: null, collisionStatus: null }), // poll 1
      status({ collisionStatus: null }), // poll 2 — publish SUCCEEDED, collision pending
      status({ collisionStatus: 'QUEUED' }), // poll 3
      status({ collisionStatus: 'RUNNING' }), // poll 4
      status({ collisionStatus: 'SUCCEEDED' }), // poll 5 — terminal
    ];
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => seq.shift() ?? status({}));

    const { result } = renderHook(() => useUploadProcessingPoll('up-1', true));

    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); // poll 1
    expect(result.current.polling).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 2
    expect(result.current.publishStatus).toBe('SUCCEEDED');
    expect(result.current.collisionStatus).toBe(null);
    expect(result.current.polling).toBe(true); // ← 旧实现此处已停止（P1-A）

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 3
    expect(result.current.collisionStatus).toBe('QUEUED');
    expect(result.current.polling).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 4
    expect(result.current.collisionStatus).toBe('RUNNING');
    expect(result.current.polling).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 5
    expect(result.current.collisionStatus).toBe('SUCCEEDED');
    expect(result.current.polling).toBe(false);
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(5);
  });

  it('collision FAILED → 停止，不将整个上传显示为失败', async () => {
    const seq = [status({ collisionStatus: 'RUNNING' }), status({ collisionStatus: 'FAILED' })];
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => seq.shift() ?? status({}));
    const { result } = renderHook(() => useUploadProcessingPoll('up-1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); });
    expect(result.current.collisionStatus).toBe('FAILED');
    expect(result.current.polling).toBe(false);
    expect(result.current.uploadStatus).toBe('SUCCEEDED');
  });

  it('一段时间内 collision 尚未出现：不提前结束、不显示虚假失败', async () => {
    const seq = [
      status({ collisionStatus: null }),
      status({ collisionStatus: null }),
      status({ collisionStatus: 'SUCCEEDED' }),
    ];
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => seq.shift() ?? status({}));
    const { result } = renderHook(() => useUploadProcessingPoll('up-1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); // tick 1 — null
    expect(result.current.polling).toBe(true);
    expect(result.current.collisionStatus).toBe(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // tick 2 — null
    expect(result.current.polling).toBe(true); // 继续观察，未提前结束
    expect(result.current.collisionStatus).toBe(null); // 不显示虚假失败
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // tick 3
    expect(result.current.collisionStatus).toBe('SUCCEEDED');
    expect(result.current.polling).toBe(false);
  });

  it('unmount 后不再发起请求（无残留轮询）', async () => {
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => status({ collisionStatus: 'RUNNING' }));
    const { unmount } = renderHook(() => useUploadProcessingPoll('up-1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(1);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS * 5); });
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(1); // 无泄漏
  });

  it('旧 uploadId 响应不得污染新上传', async () => {
    // 即使 fetch 返回旧 uploadId 的 payload，也要被守卫丢弃（且不驱动终态）。
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => status({ uploadId: 'old-up', collisionStatus: 'SUCCEEDED' }));
    const { result } = renderHook(() => useUploadProcessingPoll('new-up', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.collisionStatus).toBe(null); // 旧响应未污染
    expect(result.current.polling).toBe(true); // 继续观察，未被旧响应终止
  });

  it('网络错误 → 不伪造终态，指数退避（带上限）后恢复', async () => {
    let calls = 0;
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => {
      calls += 1;
      if (calls <= 4) throw new Error('network down');
      return status({ collisionStatus: 'RUNNING' });
    });
    const { result } = renderHook(() => useUploadProcessingPoll('up-1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); // tick 1 — 错误
    expect(result.current.polling).toBe(true); // 不因错误停止
    expect(result.current.collisionStatus).toBe(null); // 不伪造终态

    // 退避序列：6s → 12s → 24s → 48s（被上限 30s 截断）
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS * 2); }); // tick 2 — 错误
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS * 4); }); // tick 3 — 错误
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS * 8); }); // tick 4 — 错误
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(4);

    // 第 5 次退避应为 PROCESSING_MAX_BACKOFF_MS（30s 上限）：不足上限不触发…
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_MAX_BACKOFF_MS - 1000); });
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(4);
    // …满上限后 tick 5 恢复。
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(5);
    expect(result.current.collisionStatus).toBe('RUNNING');
    expect(result.current.polling).toBe(true);
  });

  it('观察上限 → 停止并标记 unconfirmed；reQuery 恢复观察', async () => {
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => status({ collisionStatus: null }));
    const { result } = renderHook(() => useUploadProcessingPoll('up-1', true));
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_OBSERVATION_LIMIT_MS + PROCESSING_POLL_INTERVAL_MS); });
    expect(result.current.unconfirmed).toBe(true);
    expect(result.current.polling).toBe(false);
    // 服务端任务从未被前端标为 FAILED
    expect(result.current.collisionStatus).toBe(null);
    act(() => { result.current.reQuery(); });
    expect(result.current.unconfirmed).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.polling).toBe(true);
  });
});


// ── §E6 — 真实时序：渲染 UploadPage，驱动完整序列 ──────────────────────────
describe('UploadPage 真实轮询时序（§E6）', () => {
  const setupUpload = async (): Promise<void> => {
    fireEvent.change(screen.getByLabelText('作品标题'), { target: { value: '时序测试作品' } });
    // category is a required Select without a default — open and pick the first.
    fireEvent.mouseDown(screen.getByLabelText('分类'));
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const opt = document.querySelector('.ant-select-item-option') as HTMLElement;
    if (opt) fireEvent.click(opt);
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    const sceneInput = document.querySelectorAll('input[type=file]')[0] as HTMLInputElement;
    const file = new File(['x'], 'test.ply', { type: 'application/octet-stream' });
    Object.defineProperty(file, 'size', { value: 4 });
    fireEvent.change(sceneInput, { target: { files: [file] } });
    // rc-upload commits the fileList to the form asynchronously — let it land
    // before submit, otherwise validateFields fails on the (still-empty) field.
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    fireEvent.click(screen.getByRole('button', { name: /校验并发布/ }));
    // flush the async startUpload (validateFields → createUploadSession → run)
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  };

  const mockUploaderFlow = (): void => {
    (createUploadSession as Mock).mockResolvedValue({
      uploadId: 'up-1', status: 'CREATED', offset: 0, totalSize: 4, chunkMaxBytes: 4,
    } satisfies UploadSessionInfo);
    (ResumableUploader as Mock).mockImplementation(function MockUploader(
      _file: File,
      _session: UploadSessionInfo,
      onEvent: (e: UploadEvent) => void,
    ) {
      return {
        run: async () => {
          onEvent({
            type: 'completed',
            result: {
              uploadId: 'up-1', status: 'QUEUED', jobId: 'job-p1',
              sceneId: 'scene-1', sceneSlug: 'scene-1',
            } satisfies CompleteResult,
          });
        },
        pause: () => {},
        resume: () => {},
        cancel: async () => {},
      };
    });
  };

  it('publish SUCCEEDED→collision null→QUEUED→RUNNING→SUCCEEDED 一路观察，查看场景可用', async () => {
    const seq = [
      status({ status: 'RUNNING', publishStatus: null, collisionStatus: null }),
      status({ collisionStatus: null }), // 等待碰撞调度
      status({ collisionStatus: 'QUEUED' }),
      status({ collisionStatus: 'RUNNING' }),
      status({ collisionStatus: 'SUCCEEDED' }),
    ];
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => seq.shift() ?? status({}));
    mockUploaderFlow();

    renderApp({ route: '/upload' });
    await setupUpload();

    // complete 事件 → phase processing → 轮询启动（timer 0）。
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); // poll 1
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 2
    // publish SUCCEEDED + collision null → 页面显示等待碰撞调度，且不停止。
    // (getByText — not findByText: waitFor + vitest fake timers hangs here.)
    expect(screen.getByText(/等待碰撞任务调度/)).toBeInTheDocument();
    expect(screen.queryByText(/状态尚未确认/)).not.toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 3 QUEUED
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 4 RUNNING
    // 已发布场景的查看按钮立即可用（不等待碰撞）。
    expect(document.querySelector('a[href="/scene/scene-1"]')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 5 SUCCEEDED
    expect(screen.getByText(/碰撞资产已生成/)).toBeInTheDocument();
    expect(screen.queryByText(/等待碰撞任务调度/)).not.toBeInTheDocument();
    expect((fetchUploadProcessingStatus as Mock).mock.calls.length).toBe(5);
  });

  it('collision FAILED：场景仍可浏览，碰撞显示失败', async () => {
    const seq = [status({ collisionStatus: 'RUNNING' }), status({ collisionStatus: 'FAILED' })];
    (fetchUploadProcessingStatus as Mock).mockImplementation(async () => seq.shift() ?? status({}));
    mockUploaderFlow();

    renderApp({ route: '/upload' });
    await setupUpload();

    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); // poll 1 RUNNING
    await act(async () => { await vi.advanceTimersByTimeAsync(PROCESSING_POLL_INTERVAL_MS); }); // poll 2 FAILED
    // 碰撞失败 → 查看场景仍可用（作品未失败）；碰撞显示失败。
    expect(screen.getByText(/碰撞构建失败/)).toBeInTheDocument();
    expect(document.querySelector('a[href="/scene/scene-1"]')).toBeInTheDocument();
    expect(screen.queryByText(/上传失败/)).not.toBeInTheDocument();
  });
});
