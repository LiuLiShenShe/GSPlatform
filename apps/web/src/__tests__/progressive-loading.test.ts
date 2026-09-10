import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProgressAggregator,
  LodSwitcher,
  LoadSession,
  fetchArrayBufferWithProgress,
  LOD_LEVELS,
  phaseLabel,
  type LODAssetRef,
  type LoadProgress,
  type ViewerHandle,
} from '@gsplatform/viewer';

// ---------------------------------------------------------------------------
// 通用 LOD 定义
// ---------------------------------------------------------------------------

const lods: LODAssetRef[] = [
  { level: 'low', assetUrl: '/local-scenes/progressive-test/low.sog', gaussians: 5940, size: 512 },
  { level: 'medium', assetUrl: '/local-scenes/progressive-test/medium.sog', gaussians: 20790, size: 1024 },
  { level: 'high', assetUrl: '/local-scenes/progressive-test/high.sog', gaussians: 59400, size: 2048 },
];

// ---------------------------------------------------------------------------
// ProgressAggregator：权重、单调性、不确定进度
// ---------------------------------------------------------------------------

describe('ProgressAggregator', () => {
  it('从 PREPARING 开始，manifest 就绪后到 5%', () => {
    const agg = new ProgressAggregator();
    expect(agg.phase).toBe('PREPARING');
    expect(agg.percent).toBeNull();
    agg.manifestReady();
    expect(agg.percent).toBe(5);
    expect(agg.indeterminate).toBe(false);
  });

  it('low 段内由真实字节驱动百分比（5% -> 29.9% 钳制）', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('low', 1000);
    agg.fetchProgress('low', 500);
    // 5 + (30-5) * 0.5 = 17.5
    expect(agg.percent).toBeCloseTo(17.5, 5);
    agg.fetchProgress('low', 1000);
    // 钳制在段尾之前，等 decode/applied 事件推过段尾
    expect(agg.percent).toBeLessThan(30);
    expect(agg.percent).toBeCloseTo(5 + 25 * 0.999, 5);
    expect(agg.phase).toBe('FETCHING_LOW'); // fetch 阶段尚未标记可交互
  });

  it('百分比永不回退（单调不降）', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('low', 1000);
    agg.fetchProgress('low', 900);
    const before = agg.percent!;
    agg.fetchProgress('low', 100); // 反序字节不应拉低百分比
    expect(agg.percent).toBeGreaterThanOrEqual(before);
  });

  it('decode/applied 事件把提 percent 推到低段终点，首帧后 45%', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('low', 1000);
    agg.fetchProgress('low', 1000);
    agg.fetchComplete('low');
    agg.decoded('low'); // 30 + 6 = 36
    expect(agg.percent).toBeCloseTo(36, 5);
    agg.applied('low'); // 42
    expect(agg.percent).toBeCloseTo(42, 5);
    expect(agg.phase).toBe('INTERACTIVE_LOW');
    agg.firstFrame('low'); // 45
    expect(agg.percent).toBeCloseTo(45, 5);
  });

  it('medium 段 45%->55%->70%，phase 变成 STREAMING_HIGH', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('medium', 1000);
    agg.fetchProgress('medium', 500); // 45+10*0.5=50
    expect(agg.percent).toBeCloseTo(50, 5);
    agg.fetchProgress('medium', 1000);
    agg.fetchComplete('medium');
    agg.decoded('medium'); // 55+7.5=62.5
    expect(agg.percent).toBeCloseTo(62.5, 5);
    agg.applied('medium'); // 70
    expect(agg.percent).toBeCloseTo(70, 5);
    agg.firstFrame('medium');
    expect(agg.phase).toBe('STREAMING_HIGH');
  });

  it('high 段 70%->92%->…100%，首帧后 phase=READY', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('high', 1000);
    agg.fetchProgress('high', 500); // 70+22*0.5=81
    expect(agg.percent).toBeCloseTo(81, 5);
    agg.fetchProgress('high', 1000);
    agg.fetchComplete('high');
    agg.decoded('high'); // 92+2.5=94.5
    expect(agg.percent).toBeCloseTo(94.5, 5);
    agg.applied('high'); // 97
    expect(agg.percent).toBeCloseTo(97, 5);
    agg.firstFrame('high'); // 100
    expect(agg.percent).toBe(100);
    expect(agg.phase).toBe('READY');
  });

  it('无 Content-Length 时显示不确定进度，不伪造百分比', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('low', null);
    expect(agg.indeterminate).toBe(true);
    expect(agg.percent).toBeNull();
    agg.fetchProgress('low', 100);
    expect(agg.percent).toBeNull(); // 没有 total 不计算
  });

  it('`fetchProgress` 只在当前 LOD 段内有效，其它 LOD 的字节不越权', () => {
    const agg = new ProgressAggregator();
    agg.manifestReady();
    agg.fetchStart('low', 1000);
    agg.fetchProgress('low', 1000);
    const lowVal = agg.percent!;
    agg.fetchStart('medium', 1000);
    agg.fetchProgress('medium', 0); // 新段从 base 开始，不跳变
    expect(agg.percent).toBeCloseTo(45, 5);
    expect(agg.percent).toBeGreaterThanOrEqual(lowVal - 0.001);
  });

  it('phaseLabel 覆盖所有状态机状态且非空', () => {
    for (const phase of ['PREPARING', 'FETCHING_LOW', 'DECODING_LOW', 'INTERACTIVE_LOW', 'STREAMING_HIGH', 'READY', 'ERROR', 'CANCELLED'] as const) {
      expect(phaseLabel(phase).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// LodSwitcher：失败降级决策
// ---------------------------------------------------------------------------

describe('LodSwitcher', () => {
  it('初始 currentLevel 是 low', () => {
    const switcher = new LodSwitcher(lods);
    expect(switcher.currentLevel).toBe('low');
  });

  it('settle 提升到 medium/high', () => {
    const switcher = new LodSwitcher(lods);
    switcher.settle('medium');
    expect(switcher.currentLevel).toBe('medium');
    switcher.settle('high');
    expect(switcher.currentLevel).toBe('high');
  });

  it('medium 失败时保留 low（degraded=true）', () => {
    const switcher = new LodSwitcher(lods);
    const decision = switcher.onFailure('medium');
    expect(decision.next).toBe('low');
    expect(decision.degraded).toBe(true);
  });

  it('high 已 settle 后再失败 high 则保留 medium', () => {
    const switcher = new LodSwitcher(lods);
    switcher.settle('medium');
    const decision = switcher.onFailure('high');
    expect(decision.next).toBe('medium');
    expect(decision.degraded).toBe(true);
  });

  it('low 失败时仍返回 low（无更低可用，由调用方决定 fatal）', () => {
    const switcher = new LodSwitcher(lods);
    const decision = switcher.onFailure('low');
    expect(decision.next).toBe('low');
    expect(decision.degraded).toBe(false);
  });

  it('hasHigher 依据更高档判断', () => {
    const switcher = new LodSwitcher(lods);
    expect(switcher.hasHigher('low')).toBe(true);
    expect(switcher.hasHigher('medium')).toBe(true);
    expect(switcher.hasHigher('high')).toBe(false);
  });

  it('LOD_LEVELS 顺序是 low->medium->high', () => {
    expect(LOD_LEVELS).toEqual(['low', 'medium', 'high']);
  });
});

// ---------------------------------------------------------------------------
// fetchArrayBufferWithProgress：真实字节进度、无长度不确定
// ---------------------------------------------------------------------------

describe('fetchArrayBufferWithProgress', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubResponse(bodyChunks: Uint8Array[], contentLength: string | null) {
    const headers = new Headers();
    if (contentLength !== null) headers.set('Content-Length', contentLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of bodyChunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return { ok: true, status: 200, headers, body: stream } as Response;
  }

  it('有 Content-Length 时按字节上报 loaded/total', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const resp = stubResponse([body.slice(0, 3), body.slice(3)], '8');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(resp));

    const events: Array<[number, number | null]> = [];
    const bytes = await fetchArrayBufferWithProgress('http://x/low.sog', 'low', (loaded, total) => {
      events.push([loaded, total]);
    });
    expect(bytes).toEqual(body);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual([3, 8]);
    expect(events[1]).toEqual([8, 8]);
  });

  it('无 Content-Length 时 total=null（调用方显示不确定进度）', async () => {
    const body = new Uint8Array([9, 9, 9]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stubResponse([body], null)));
    const totals: Array<number | null> = [];
    const bytes = await fetchArrayBufferWithProgress('http://x/low.sog', 'low', (_l, total) => {
      totals.push(total);
    });
    expect(bytes).toEqual(body);
    expect(totals.every((t) => t === null)).toBe(true);
  });

  it('HTTP 404 抛错（供上层映射 SCENE_NOT_FOUND）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response));
    await expect(
      fetchArrayBufferWithProgress('http://x/missing.sog', 'high', () => undefined),
    ).rejects.toThrow(/404/);
  });
});

// ---------------------------------------------------------------------------
// LoadSession：整条会话（事件驱动、sessionId 过滤、取消）
// ---------------------------------------------------------------------------

/** 模拟 viewer 监听表，便于测试里手动触发 embed 事件。 */
type ListenerMap = Record<string, Array<(...args: unknown[]) => void>>;

/**
 * 模拟 embed：loadScene 会按 descriptor 里的 lod/sessionId 时序派发
 * decoded -> applied -> firstFrame，与真实 embed 的 postStage 一致。
 */
function createMockHandle(listenerMap: ListenerMap): ViewerHandle {
  return {
    async loadScene(descriptor) {
      const ld = descriptor as unknown as { lod?: string; sessionId?: string };
      if (ld && ld.lod && ld.sessionId) {
        queueMicrotask(() => {
          for (const stage of ['decoded', 'applied', 'firstFrame'] as const) {
            listenerMap['lodState']?.forEach((fn) =>
              fn({ sessionId: ld.sessionId, lod: ld.lod, stage }),
            );
          }
        });
      }
    },
    async resetCamera() {},
    async setCameraMode() {},
    async resize() {},
    async getStats() {
      return { fps: 60, frameTimeMs: 16.6, splatCount: 1, renderer: 'webgl2' };
    },
    destroy() {},
    on(type: string, listener: (...args: unknown[]) => void) {
      (listenerMap[type] ??= []).push(listener);
      return () => {
        listenerMap[type] = (listenerMap[type] ?? []).filter((l) => l !== listener);
      };
    },
  };
}

/**
 * 模拟 headless SwiftShader 的 P03-001 卡死：场景 decode/apply 成功
 * （decoded/applied 正常到达），但 firstFrame 永不到达且 loadScene ACK
 * 永不返回（embed 在 firstFrame 等待之后才发 ACK）。host-side grace 应
 * 在精短窗口后兜底 settle firstFrame。
 */
function createStallingHandle(listenerMap: ListenerMap): ViewerHandle {
  return {
    async loadScene(descriptor) {
      const ld = descriptor as unknown as { lod?: string; sessionId?: string };
      if (ld && ld.lod && ld.sessionId) {
        queueMicrotask(() => {
          for (const stage of ['decoded', 'applied'] as const) {
            listenerMap['lodState']?.forEach((fn) =>
              fn({ sessionId: ld.sessionId, lod: ld.lod, stage }),
            );
          }
          // firstFrame 永不派发 — 模拟 iframe timer/合成器挂起
        });
      }
      // ACK 永不 resolve — loadScene 命令等待 firstFrame 后才回包
      return new Promise<void>(() => {});
    },
    async resetCamera() {},
    async setCameraMode() {},
    async resize() {},
    async getStats() {
      return { fps: 60, frameTimeMs: 16.6, splatCount: 1, renderer: 'webgl2' };
    },
    destroy() {},
    on(type: string, listener: (...args: unknown[]) => void) {
      (listenerMap[type] ??= []).push(listener);
      return () => {
        listenerMap[type] = (listenerMap[type] ?? []).filter((l) => l !== listener);
      };
    },
  };
}

describe('LoadSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** 让 fetch 返回一段假 SOG 字节，Content-Length 精确。 */
  function stubAssets() {
    const body = new Uint8Array(256);
    for (let i = 0; i < body.length; i++) body[i] = i;
    const responses: Record<string, Response> = {};
    for (const lod of lods) {
      responses[lod.assetUrl] = {
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Length': String(body.length) }),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
      } as Response;
    }
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(responses[url])));
  }

  it('三档资产全部就绪后 resolve ready，进度 0→100 单调完成', async () => {
    stubAssets();
    const listeners: ListenerMap = {};
    const handle = createMockHandle(listeners);
    const progress: LoadProgress[] = [];
    const session = new LoadSession(handle, { id: 'p', lods }, 'sess-1', {
      onProgress: (p) => progress.push(p),
    });

    const result = await session.start(new AbortController().signal);

    expect(result.status).toBe('ready');
    const last = progress[progress.length - 1];
    expect(last.percent).toBe(100);
    expect(last.phase).toBe('READY');
    // 单调：任意后一项 percent >= 前一项（null = indeterminate，跳过不比）
    const numeric = progress.map((p) => p.percent).filter((p): p is number => p != null);
    for (let i = 1; i < numeric.length; i++) {
      expect(numeric[i]).toBeGreaterThanOrEqual(numeric[i - 1]);
    }
  });

  it('加载途中 cancel() 后 resolve cancelled', async () => {
    stubAssets();
    const listeners: ListenerMap = {};
    const handle = createMockHandle(listeners);
    const session = new LoadSession(handle, { id: 'p', lods }, 'sess-2', {
      onProgress: () => undefined,
    });

    const promise = session.start(new AbortController().signal);
    // 不等事件，直接取消
    session.cancel();
    const result = await promise;
    expect(result.status).toBe('cancelled');
  });

  it('low 下载失败时返回 error（无可用可交互版本）', async () => {
    const body = new Uint8Array(8);
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      Promise.resolve(
        url === lods[0].assetUrl
          ? { ok: false, status: 404 } as Response
          : { ok: true, status: 200, headers: new Headers({ 'Content-Length': '8' }), body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); } }) } as Response,
      ),
    ));
    const listeners: ListenerMap = {};
    const handle = createMockHandle(listeners);
    const session = new LoadSession(handle, { id: 'p', lods }, 'sess-3', {
      onProgress: () => undefined,
    });
    const result = await session.start(new AbortController().signal);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.code).toBe('SCENE_NOT_FOUND');
    }
  });

  it('medium 失败时保留 low（session 返回 error 指向保留档）', async () => {
    const body = new Uint8Array(8);
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === lods[1].assetUrl) {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, headers: new Headers({ 'Content-Length': '8' }), body: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(body); c.close(); } }) } as Response);
    }));
    const listeners: ListenerMap = {};
    const handle = createMockHandle(listeners);

    const session = new LoadSession(handle, { id: 'p', lods }, 'sess-4', {
      onProgress: () => undefined,
    });
    const result = await session.start(new AbortController().signal);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.lod).toBe('low');
    }
  });

  it('忽略非本 session（stale）的 lodState 事件', async () => {
    stubAssets();
    const listeners: ListenerMap = {};
    const handle = createMockHandle(listeners);
    const progress: LoadProgress[] = [];
    const session = new LoadSession(handle, { id: 'p', lods }, 'fresh', {
      onProgress: (p) => progress.push(p),
    });

    const started = session.start(new AbortController().signal);
    // 先发一个旧 session 的 firstFrame，不应让进度跳到 100
    listenerMapFire(listeners, 'lodState', { sessionId: 'stale', lod: 'high', stage: 'firstFrame' });

    const result = await started;
    const last = progress[progress.length - 1];
    // 只有 fresh 的 firstFrame 驱动到 100
    expect(result.status).toBe('ready');
    expect(last.percent).toBe(100);
  });

  it('嵌入端 firstFrame 超时后由 host-side grace 兜底，仍 resolve ready', async () => {
    // 模拟 headless SwiftShader 的 P03-001 状态：
    // - decoded/applied 正常到达（场景应用成功）
    // - firstFrame 永不到达（iframe 的 postrender / timer 挂起）
    // - loadScene ACK 也永不返回（embed 在 firstFrame 等待后才发 ACK）
    // host-side grace 在精短窗口后兜底 settle firstFrame，session 到达 READY
    stubAssets();
    const listeners: ListenerMap = {};
    const stallingHandle = createStallingHandle(listeners);
    const progress: LoadProgress[] = [];
    const session = new LoadSession(stallingHandle, { id: 'p', lods }, 'grace-test', {
      onProgress: (p) => progress.push(p),
    }, {
      // 极短 grace，让单元测试在 1s 内结束
      ackGraceMs: 50,
      firstFrameGraceMs: 50,
    });

    const result = await session.start(new AbortController().signal);
    expect(result.status).toBe('ready');
    const last = progress[progress.length - 1];
    expect(last.percent).toBe(100);
    expect(last.phase).toBe('READY');
  });
});

/** 向监听表指定事件类型派发一个 payload。 */
function listenerMapFire(
  listeners: ListenerMap,
  type: string,
  payload: unknown,
): void {
  listeners[type]?.forEach((fn) => fn(payload));
}