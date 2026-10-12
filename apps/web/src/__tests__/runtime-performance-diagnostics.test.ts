import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventHandler } from 'playcanvas';
import { DIAGNOSTIC_LIMITS, diagnosticsEnabled, percentile, RuntimePerformanceDiagnostics } from '../scene-runtime/RuntimePerformanceDiagnostics';
import { runtimeDescriptorFixture } from '../scene-runtime/__fixtures__/descriptor';
import type { SuperSplatRuntime } from '../scene-runtime/SuperSplatRuntime';

function fixture() {
  const app = new EventHandler();
  const events = new EventHandler();
  let xrMode: 'vr' | null = null;
  const subscribe = (target: EventHandler, name: string, callback: (...args: unknown[]) => void) => {
    target.on(name, callback);
    return () => target.off(name, callback);
  };
  const runtime = {
    app: Object.assign(app, { graphicsDevice: { deviceType: 'webgl2', width: 800, height: 600 }, stats: { frame: { gsplats: 1788 } } }),
    loaded: false,
    get xrMode() { return xrMode; },
    getPerformanceMode: () => true,
    getSingleFileGaussianCount: () => 1788,
    getCameraPose: () => ({ position: [1, 2, 3], target: [0, 2, 3], fov: 60 }),
    getXRState: () => ({ active: Boolean(xrMode), rigPosition: [1, 0, 3] }),
    worldTransformInfo: () => ({ identity: true }),
    getSceneBounds: () => ({ min: [-1, -1, -1], max: [1, 1, 1], size: [2, 2, 2] }),
    onEngineEvent: (name: string, callback: (...args: unknown[]) => void) => subscribe(app, name, callback),
    onLoaded: (callback: (...args: unknown[]) => void) => subscribe(events, 'loaded', callback),
    onXRModeChanged: (callback: (...args: unknown[]) => void) => subscribe(events, 'xr', callback),
    onPerformanceModeChanged: (callback: (...args: unknown[]) => void) => subscribe(events, 'performance', callback),
  } as unknown as SuperSplatRuntime;
  return { app, events, runtime, enter: () => { xrMode = 'vr'; events.fire('xr', 'vr'); } };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('VR-01C bounded local diagnostics', () => {
  it('requires both query opt-in and environment enablement', () => {
    expect(diagnosticsEnabled('?diagnostics=1', false)).toBe(false);
    expect(diagnosticsEnabled('?diagnostics=0', true)).toBe(false);
    expect(diagnosticsEnabled('?diagnostics=1&share=secret', true)).toBe(true);
  });

  it('records real event intervals separately from GPU timing, and cleans listeners', () => {
    vi.useFakeTimers();
    const { app, events, runtime, enter } = fixture();
    const recorder = new RuntimePerformanceDiagnostics();
    recorder.start(); recorder.attach(runtime);
    recorder.setDescriptor(runtimeDescriptorFixture);
    recorder.setLodCounts([13090324, 3927097, 1309032]);
    app.fire('frameupdate', 16); app.fire('frameend');
    app.fire('frameupdate', 20); app.fire('frameend');
    vi.advanceTimersByTime(1000);
    recorder.markXRRequest(); enter();
    app.fire('frameupdate', 10); app.fire('frameend');
    app.fire('frameupdate', 12); app.fire('frameend');
    app.fire('frameupdate', 80); app.fire('frameend');
    vi.advanceTimersByTime(1000);
    events.fire('loaded', true);
    recorder.failure(); recorder.stop();
    const report = JSON.parse(JSON.stringify(recorder.snapshot()));
    expect(report.samples[0].frames[1].frameTimeP50Ms).toBe(20);
    expect(report.samples[1].frames[0].observedFrames).toBe(2);
    expect(report.samples[1].frames[0].stallCountOver50Ms).toBe(1);
    expect(report.samples[1].frames[0].gpuTimeMs).toBe('unavailable');
    expect(report.events.map((entry: { kind: string }) => entry.kind)).toContain('xr-start');
    expect(report.timing.timeToXRSessionStartMs).toBeTypeOf('number');
    expect(report.events.map((entry: { kind: string }) => entry.kind)).toContain('runtime-or-session-error');
    recorder.destroy();
    expect(app.hasEvent('frameupdate')).toBe(false);
    expect(app.hasEvent('frameend')).toBe(false);
    expect(events.hasEvent('xr')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces duration and entry limits, even when frames or requests spike', () => {
    vi.useFakeTimers();
    const { app, events, runtime } = fixture();
    const recorder = new RuntimePerformanceDiagnostics();
    recorder.start(); recorder.attach(runtime);
    for (let frame = 0; frame < 1200; frame += 1) { app.fire('frameupdate', 1); app.fire('frameend'); }
    for (let event = 0; event < 2000; event += 1) events.fire('performance');
    vi.advanceTimersByTime(400000);
    const report = JSON.parse(JSON.stringify(recorder.snapshot()));
    expect(report.recording).toBe(false);
    expect(report.samples.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.samples);
    expect(report.events.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.events);
    expect(report.dropped.frames).toBeGreaterThan(0);
    expect(report.dropped.events).toBeGreaterThan(0);
    expect(report.resources.length).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.resources);
    recorder.destroy();
  });

  it('whitelists resource fields, ignores unrelated URLs and never exports secrets', () => {
    let observe: (list: { getEntries: () => object[] }) => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('PerformanceObserver', class {
      constructor(callback: typeof observe) { observe = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const recorder = new RuntimePerformanceDiagnostics();
    const descriptor = { ...runtimeDescriptorFixture,
      content: { ...runtimeDescriptorFixture.content, url: '/api/v1/scenes/scene/assets/versions/abc123/lod-meta.json?share=SECRET' } };
    recorder.setDescriptor(descriptor); recorder.start();
    const resource = { name: `${location.origin}/api/v1/scenes/scene/assets/versions/abc123/0_1/means_l.webp?token=SECRET`,
      startTime: performance.now() + 1, duration: 1400, transferSize: 500, decodedBodySize: 400, responseStatus: 503 };
    observe({ getEntries: () => [resource, { ...resource, name: 'https://other.invalid/auth?jwt=SECRET' }] });
    const report = JSON.parse(JSON.stringify(recorder.snapshot()));
    expect(report.resourceSummary.chunkResourceRequests).toBe(1);
    expect(report.resourceSummary.observedTransferBytes).toBe(500);
    expect(report.resourceSummary.observedHttpErrors).toBe(1);
    expect(report.resourceSummary.stallsOver1000Ms).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/SECRET|Cookie|Authorization|jwt=|share=/);
    recorder.destroy(); expect(disconnect).toHaveBeenCalled();
  });

  it('does not invent missing percentiles or LOD counts', () => {
    expect(percentile([], 0.5)).toBe('unavailable');
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    const recorder = new RuntimePerformanceDiagnostics();
    recorder.setLodCounts([NaN]);
    expect(JSON.parse(JSON.stringify(recorder.snapshot())).lodCounts).toBe('unavailable');
    recorder.destroy();
  });
});
