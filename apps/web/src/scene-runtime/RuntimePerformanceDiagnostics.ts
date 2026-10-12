import type { SuperSplatRuntime } from './SuperSplatRuntime';
import type { SceneRuntimeDescriptorV1 } from './types';

type Metric = number | 'unavailable';
type FrameSource = 'xr-session-callback' | 'window-raf-estimate';
type FrameWindow = { intervals: number[]; cpu: number[]; stalls: number; frames: number };

export const DIAGNOSTIC_LIMITS = { seconds: 300, samples: 301, events: 128, resources: 2048, frames: 240 };

export function percentile(values: number[], fraction: number): Metric {
  if (!values.length) return 'unavailable';
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

export function diagnosticsEnabled(search: string, allowed: boolean): boolean {
  return allowed && new URLSearchParams(search).get('diagnostics') === '1';
}

function browserSummary(): object {
  const agent = navigator.userAgent;
  return {
    pico: /pico/i.test(agent),
    android: /Android\s+[\d.]+/.exec(agent)?.[0] ?? 'unavailable',
    browser: /(?:PicoBrowser|Chrome|Chromium)\/[\d.]+/i.exec(agent)?.[0] ?? 'unavailable',
    mobile: /Mobile|Pico|Quest/i.test(agent),
  };
}

function networkEnvironment(): string {
  if (location.hostname.endsWith('.trycloudflare.com')) return 'Quick Tunnel';
  if (['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    return location.protocol === 'https:' ? 'Local HTTPS' : 'Local HTTP (software only)';
  }
  return 'HTTPS (Stable Tunnel vs other entry unavailable)';
}

export class RuntimePerformanceDiagnostics {
  private runtime: SuperSplatRuntime | null = null;
  private descriptor: SceneRuntimeDescriptorV1 | null = null;
  private unsubs: (() => void)[] = [];
  private observer: PerformanceObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly openedAt = performance.now();
  private startedAt = this.openedAt;
  private recording = false;
  private samples: object[] = [];
  private events: object[] = [];
  private resources: object[] = [];
  private dropped = { samples: 0, events: 0, resources: 0, frames: 0 };
  private frames = this.emptyFrames();
  private cpuStarted: number | null = null;
  private skipInterval = true;
  private firstFrame: Metric = 'unavailable';
  private loadedAt: Metric = 'unavailable';
  private xrRequestedAt: number | null = null;
  private xrEnterDuration: Metric = 'unavailable';
  private xrStartedAt: Metric = 'unavailable';
  private lodCounts: number[] | 'unavailable' = 'unavailable';
  private requests = 0;
  private chunkRequests = 0;
  private transferBytes = 0;
  private decodedBytes = 0;
  private bytesUnavailable = 0;
  private resourceStalls = 0;
  private errors = 0;
  private errorsUnavailable = 0;

  private emptyFrames(): Record<FrameSource, FrameWindow> {
    return {
      'xr-session-callback': { intervals: [], cpu: [], stalls: 0, frames: 0 },
      'window-raf-estimate': { intervals: [], cpu: [], stalls: 0, frames: 0 },
    };
  }

  start(): void {
    if (this.recording) return;
    this.startedAt = performance.now();
    this.samples = [];
    this.events = [];
    this.resources = [];
    this.dropped = { samples: 0, events: 0, resources: 0, frames: 0 };
    this.frames = this.emptyFrames();
    this.skipInterval = true;
    this.requests = this.chunkRequests = this.transferBytes = this.decodedBytes = 0;
    this.bytesUnavailable = this.resourceStalls = this.errors = this.errorsUnavailable = 0;
    this.recording = true;
    this.event('recording-start');
    this.timer = setInterval(() => {
      this.aggregate();
      if (performance.now() - this.startedAt >= DIAGNOSTIC_LIMITS.seconds * 1000) this.stop('duration-limit');
    }, 1000);
    if (typeof PerformanceObserver !== 'undefined') {
      try {
        this.observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) this.resource(entry as PerformanceResourceTiming);
        });
        this.observer.observe({ type: 'resource', buffered: true });
      } catch {
        this.event('resource-timing-unavailable');
      }
    }
  }

  setDescriptor(descriptor: SceneRuntimeDescriptorV1): void {
    this.descriptor = descriptor;
  }

  setLodCounts(counts: unknown): void {
    if (Array.isArray(counts) && counts.length <= 16 && counts.length > 0 &&
      counts.every(value => Number.isSafeInteger(value) && value >= 0)) this.lodCounts = [...counts];
  }

  attach(runtime: SuperSplatRuntime): void {
    this.detach();
    this.runtime = runtime;
    this.unsubs.push(runtime.onEngineEvent('frameupdate', duration => {
      if (!this.recording) return;
      if (performance.now() - this.startedAt >= DIAGNOSTIC_LIMITS.seconds * 1000) {
        this.stop('duration-limit');
        return;
      }
      this.cpuStarted = performance.now();
      if (this.skipInterval) { this.skipInterval = false; return; }
      const bucket = this.frames[runtime.xrMode ? 'xr-session-callback' : 'window-raf-estimate'];
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return;
      bucket.frames += 1;
      if (duration > 50) bucket.stalls += 1;
      if (bucket.intervals.length < DIAGNOSTIC_LIMITS.frames) bucket.intervals.push(duration);
      else this.dropped.frames += 1;
    }), runtime.onEngineEvent('frameend', () => {
      if (this.firstFrame === 'unavailable' && runtime.app.stats.frame.gsplats > 0) {
        this.firstFrame = performance.now() - this.openedAt;
        this.event('first-gaussian-frame-observed');
      }
      if (!this.recording) return;
      const bucket = this.frames[runtime.xrMode ? 'xr-session-callback' : 'window-raf-estimate'];
      if (this.cpuStarted !== null && bucket.cpu.length < DIAGNOSTIC_LIMITS.frames) {
        bucket.cpu.push(performance.now() - this.cpuStarted);
      }
    }), runtime.onLoaded(loaded => {
      if (loaded && this.loadedAt === 'unavailable') this.loadedAt = performance.now() - this.openedAt;
      this.event(loaded ? 'loaded' : 'loading');
    }), runtime.onXRModeChanged(mode => {
      if (mode) {
        if (this.xrStartedAt === 'unavailable') this.xrStartedAt = performance.now() - this.openedAt;
        if (this.xrRequestedAt !== null && this.xrEnterDuration === 'unavailable') {
          this.xrEnterDuration = performance.now() - this.xrRequestedAt;
        }
      }
      this.event(mode ? 'xr-start' : 'xr-end');
      this.skipInterval = true;
      this.cpuStarted = null;
    }), runtime.onPerformanceModeChanged(() => this.event('performance-mode-change')));
    if (runtime.loaded && this.loadedAt === 'unavailable') this.loadedAt = performance.now() - this.openedAt;
    this.event('runtime-attached');
  }

  markXRRequest(): void {
    this.xrRequestedAt = performance.now();
    this.event('xr-request');
  }

  failure(): void {
    this.event('runtime-or-session-error');
  }

  private event(kind: string): void {
    if (!this.recording) return;
    if (this.events.length >= DIAGNOSTIC_LIMITS.events) { this.dropped.events += 1; return; }
    const entry = { elapsedMs: performance.now() - this.startedAt, kind, runtime: this.readRuntime() };
    if (this.events.length < DIAGNOSTIC_LIMITS.events) this.events.push(entry);
    else this.dropped.events += 1;
  }

  private readRuntime(): object | 'unavailable' {
    if (!this.runtime) return 'unavailable';
    try {
      const app = this.runtime.app;
      if (this.lodCounts === 'unavailable' && this.descriptor?.content.format !== 'lod-meta') {
        const count = this.runtime.getSingleFileGaussianCount();
        if (count !== null) this.setLodCounts([count]);
      }
      const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
      return {
        renderer: app.graphicsDevice.deviceType,
        performanceMode: this.runtime.getPerformanceMode(),
        cameraMode: this.runtime.cameraMode,
        xrMode: this.runtime.xrMode,
        renderedGaussians: app.stats.frame.gsplats,
        gaussianCountSource: 'PlayCanvas stats.frame.gsplats (engine count; unique per-eye count unavailable)',
        camera: this.runtime.getCameraPose(),
        cameraTargetSource: 'forward + bounds-derived distance, not exact orbit pivot',
        xr: this.runtime.getXRState(),
        worldTransform: this.runtime.worldTransformInfo(),
        bounds: this.runtime.getSceneBounds() ?? 'unavailable',
        resolution: { width: app.graphicsDevice.width, height: app.graphicsDevice.height },
        jsHeapBytesEstimate: memory?.usedJSHeapSize ?? 'unavailable',
        gpuMemoryBytes: 'unavailable',
      };
    } catch { return 'unavailable'; }
  }

  private resource(entry: PerformanceResourceTiming): void {
    if (!this.recording || entry.startTime < this.startedAt || !this.descriptor?.content.url) return;
    let url: URL;
    let content: URL;
    try {
      url = new URL(entry.name, location.origin);
      content = new URL(this.descriptor.content.url, location.origin);
    } catch { return; }
    const prefix = content.pathname.slice(0, content.pathname.lastIndexOf('/') + 1);
    if (url.origin !== content.origin || !url.pathname.startsWith(prefix)) return;
    const chunk = /\/\d+_\d+\//.test(url.pathname);
    const status = (entry as PerformanceResourceTiming & { responseStatus?: number }).responseStatus;
    this.requests += 1;
    if (chunk) this.chunkRequests += 1;
    this.transferBytes += entry.transferSize;
    this.decodedBytes += entry.decodedBodySize;
    if (!entry.transferSize && !entry.decodedBodySize) this.bytesUnavailable += 1;
    if (!status) this.errorsUnavailable += 1;
    if (status && status >= 400) this.errors += 1;
    if (entry.duration > 1000) this.resourceStalls += 1;
    const asset = chunk ? url.pathname.match(/\/\d+_\d+\/(?:meta\.json|[a-zA-Z0-9_]+\.webp)$/)?.[0] ?? 'chunk'
      : /\/(lod-meta\.json|scene\.sog)$/.exec(url.pathname)?.[1] ?? 'scene-resource';
    if (this.resources.length < DIAGNOSTIC_LIMITS.resources) {
      this.resources.push({ elapsedMs: entry.startTime - this.startedAt, asset,
        durationMs: entry.duration, transferBytes: entry.transferSize || 'unavailable-or-cache',
        decodedBytes: entry.decodedBodySize || 'unavailable', status: status || 'unavailable', chunk });
    } else this.dropped.resources += 1;
  }

  private aggregate(): void {
    if (!this.recording) return;
    const frames = Object.entries(this.frames).map(([source, bucket]) => {
      const median = percentile(bucket.intervals, 0.5);
      return { source, observedFrames: bucket.frames, frameTimeP50Ms: median,
        frameTimeP95Ms: percentile(bucket.intervals, 0.95),
        fpsMedianEstimate: typeof median === 'number' ? 1000 / median : 'unavailable',
        stallCountOver50Ms: bucket.stalls, cpuFrameElapsedP50Ms: percentile(bucket.cpu, 0.5),
        gpuTimeMs: 'unavailable' };
    });
    if (this.samples.length < DIAGNOSTIC_LIMITS.samples) {
      this.samples.push({ elapsedMs: performance.now() - this.startedAt, frames,
        runtime: this.readRuntime(), resources: this.resourceSummary() });
    } else this.dropped.samples += 1;
    this.frames = this.emptyFrames();
  }

  private resourceSummary(): object {
    return { completedRequests: this.requests, chunkResourceRequests: this.chunkRequests,
      observedTransferBytes: this.transferBytes, observedDecodedBytes: this.decodedBytes,
      bytesUnavailable: this.bytesUnavailable, stallsOver1000Ms: this.resourceStalls,
      observedHttpErrors: this.errors, statusUnavailable: this.errorsUnavailable,
      inFlightRequests: 'unavailable', decodeMs: 'unavailable', textureUploadMs: 'unavailable' };
  }

  snapshot(): object {
    return {
      schemaVersion: 1, recording: this.recording, limits: DIAGNOSTIC_LIMITS, dropped: this.dropped,
      sceneId: /^[a-zA-Z0-9_-]+$/.test(this.descriptor?.scene.id ?? '') ? this.descriptor?.scene.id : 'unavailable',
      assetVersion: /\/versions\/([a-zA-Z0-9_]+)\//.exec(this.descriptor?.content.url ?? '')?.[1] ?? 'unavailable',
      browser: browserSummary(), network: networkEnvironment(), lodCounts: this.lodCounts,
      timing: { timeToFirstGaussianFrameObservedMs: this.firstFrame, timeToLoadedMs: this.loadedAt,
        timeToFirstGaussianFromNavigationMs: typeof this.firstFrame === 'number' ? this.firstFrame + this.openedAt : 'unavailable',
        timeToLoadedFromNavigationMs: typeof this.loadedAt === 'number' ? this.loadedAt + this.openedAt : 'unavailable',
        timeToXRSessionStartMs: this.xrStartedAt, xrEnterDurationMs: this.xrEnterDuration,
        loadingOrigin: 'hook boot, not navigationStart',
        loadingDurationMs: this.loadedAt, gpuFPS: 'unavailable',
        cpuSubmissionTimeMs: 'unavailable',
        frameSource: 'Engine frameupdate intervals; XR uses native XRSession rAF; desktop window rAF, including on-demand idle ticks',
        cpuSource: 'JS elapsed from frameupdate to frameend; not GPU or isolated submission time' },
      initialCamera: this.descriptor?.presentation.initialCamera ?? 'unavailable',
      worldTransform: this.descriptor?.presentation.worldTransform ?? 'unavailable',
      runtime: this.readRuntime(), samples: [...this.samples], events: [...this.events],
      resources: [...this.resources], resourceSummary: this.resourceSummary(),
    };
  }

  summary(): object {
    return { recording: this.recording, samples: this.samples.length, last: this.samples.at(-1) ?? null,
      timing: { firstGaussianMs: this.firstFrame, loadedMs: this.loadedAt,
        xrSessionStartMs: this.xrStartedAt, xrEnterMs: this.xrEnterDuration },
      resources: this.resourceSummary(), dropped: this.dropped };
  }

  stop(reason = 'manual'): void {
    if (!this.recording) return;
    this.aggregate();
    this.event(`recording-stop-${reason}`);
    this.recording = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.observer?.disconnect();
    this.observer = null;
  }

  detach(): void {
    this.unsubs.forEach(unsubscribe => unsubscribe());
    this.unsubs = [];
    this.runtime = null;
  }

  destroy(): void {
    this.stop('destroy');
    this.detach();
  }
}
