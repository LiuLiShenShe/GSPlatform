import { useEffect, useState } from 'react';
import type { OfficialXRViewerState } from './useSuperSplatXR';

export function XRPerformancePanel({ state }: { state: OfficialXRViewerState }) {
  const recorder = state.performanceRecorder;
  const [summary, setSummary] = useState<object | null>(null);
  useEffect(() => {
    if (!recorder) return;
    const refresh = () => setSummary(recorder.summary());
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  }, [recorder]);
  if (!recorder || state.xrMode) return null;

  const download = () => {
    recorder.stop();
    const url = URL.createObjectURL(new Blob([JSON.stringify(recorder.snapshot(), null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gsplatform-xr-diagnostics-${Date.now()}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSummary(recorder.summary());
  };

  return <section className="gs-xr__performance" data-testid="xr-performance-panel">
    <strong>本地性能记录（调试）</strong>
    <p>进入前开始，系统菜单退出 VR 后导出；HTML 面板不在沉浸视野中。最多 5 分钟，不上传。</p>
    <p>Performance Mode: <span data-testid="performance-mode">{state.performanceMode ? 'ON' : 'OFF'}</span>
      {' · '}Gaussian: {state.gsplats}</p>
    <button type="button" data-testid="performance-on" onClick={() => state.setPerformanceMode(true)}>性能 ON</button>
    <button type="button" data-testid="performance-off" onClick={() => state.setPerformanceMode(false)}>性能 OFF</button>
    <button type="button" data-testid="diagnostics-start" onClick={() => { recorder.start(); setSummary(recorder.summary()); }}>开始新记录</button>
    <button type="button" data-testid="diagnostics-stop" onClick={() => { recorder.stop(); setSummary(recorder.summary()); }}>停止</button>
    <button type="button" data-testid="diagnostics-export" onClick={download}>下载诊断 JSON</button>
    <p>此处切换仅本次 Runtime 生效，保留官方原有偏好。刷新时自动记录加载。</p>
    <details><summary>每秒聚合（不是 GPU FPS）</summary>
      <pre data-testid="performance-summary">{JSON.stringify(summary, null, 2)}</pre>
    </details>
  </section>;
}
