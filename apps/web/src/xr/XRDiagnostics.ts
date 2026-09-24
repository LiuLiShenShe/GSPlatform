/**
 * WebXR 修复任务 — 浏览器 WebXR 能力诊断（§7）。
 *
 * 只做能力探测，不做任何渲染。结果同时 console 输出 + 页面可视化，
 * 因为用户需要在 Quest / PICO 头显内直接看到状态。
 */
import type { XRDiagnostics } from './xrTypes';

/** 收集浏览器侧 WebXR 诊断信息。 */
export async function collectDiagnostics(): Promise<XRDiagnostics> {
  const navigatorAny = navigator as unknown as {
    xr?: { isSessionSupported: (mode: string) => Promise<boolean> };
  };

  const diagnostic: XRDiagnostics = {
    secureContext: window.isSecureContext,
    navigatorXR: Boolean(navigatorAny.xr),
    userAgent: navigator.userAgent,
    protocol: window.location.protocol,
    origin: window.location.origin,
    topLevel: window.self === window.top,
    immersiveVrSupported: false,
    immersiveArSupported: false,
    renderer: null,
    viewerLoaded: false,
  };

  if (navigatorAny.xr) {
    try {
      diagnostic.immersiveVrSupported = await navigatorAny.xr.isSessionSupported('immersive-vr');
    } catch (error) {
      console.error('[xr] isSessionSupported(immersive-vr) failed', error);
    }
    try {
      diagnostic.immersiveArSupported = await navigatorAny.xr.isSessionSupported('immersive-ar');
    } catch (error) {
      console.error('[xr] isSessionSupported(immersive-ar) failed', error);
    }
  }

  console.log('[xr] diagnostics', diagnostic);
  return diagnostic;
}

/** 把诊断结果渲染为有序键值行（页面可视化，不依赖 F12）。 */
export function formatDiagnostics(d: XRDiagnostics): Array<[string, string]> {
  return [
    ['Secure Context', d.secureContext ? 'true' : 'false'],
    ['navigator.xr', d.navigatorXR ? 'true' : 'false'],
    ['Immersive VR', d.immersiveVrSupported ? 'supported' : 'unsupported'],
    ['Immersive AR', d.immersiveArSupported ? 'supported' : 'unsupported'],
    ['Browser UA', d.userAgent],
    ['Protocol', d.protocol],
    ['Origin', d.origin],
    ['Top-level', d.topLevel ? 'true' : 'false'],
    ['Viewer', d.viewerLoaded ? 'READY' : 'loading'],
    ['Renderer', d.renderer ?? '—'],
  ];
}
