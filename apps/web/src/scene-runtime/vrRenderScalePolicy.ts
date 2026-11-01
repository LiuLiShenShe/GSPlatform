/**
 * VR 渲染分辨率策略（真实头显性能旋钮）。
 *
 * 官方 supersplat-viewer 1.35.0 在 `createApp` 里把
 * `graphicsDevice.maxPixelRatio = window.devicePixelRatio`，并明确注释：
 * 「Set maxPixelRatio so the XR framebuffer scale factor is computed correctly.
 * Regular rendering bypasses maxPixelRatio via the custom initCanvas sizing.」
 *
 * 即 —— 引擎 `XrManager.start` 计算 XRWebGLLayer 的 framebufferScaleFactor 时
 * 用的就是 `gd.maxPixelRatio / window.devicePixelRatio`（playcanvas 2.22.4
 * `XrManager#start`）。官方 viewer 把它钉成 1（全分辨率）。我们在会话**创建前**
 * 把 `maxPixelRatio` 乘上 scale，就等价于在头显里降低每眼渲染分辨率；网页版
 * 渲染走自定义 canvas 尺寸、不读 maxPixelRatio，所以画面不受影响。
 *
 * 关键约束：WebXR 的 layer 尺寸在 `startXR` 时固化，会话内无法更改 —— 所以
 * 取值必须在进入 VR 之前决定（值在 `SuperSplatRuntime.startVR()` 内施加）。
 *
 * 偏好（可选）存在 localStorage；`null` = 未启用，跟随官方 100% 默认。
 */
export const XR_RENDER_SCALE_STORAGE_KEY = 'gsplatform.vrRenderScale';

export const XR_RENDER_SCALE_MIN = 0.3;
export const XR_RENDER_SCALE_MAX = 1;

export interface XrRenderScaleOption {
  /** 实际生效比例（0 < value ≤ 1）；`null` 表示「跟随官方默认（不施加）」。 */
  value: number | null;
  label: string;
}

/**
 * UI 可选项。注意：选「原生 100%」存的是 `null` —— 不施加 maxPixelRatio 改动，
 * 完全等于官方默认行为（不引入额外副作用，恢复迁移到新头显时干净）。
 */
export const XR_RENDER_SCALE_OPTIONS: readonly XrRenderScaleOption[] = [
  { value: null, label: '原生 100%（默认）' },
  { value: 0.85, label: '85%' },
  { value: 0.7, label: '70%（推荐）' },
  { value: 0.55, label: '55%' },
];

/** 把任意输入规整为合法 scale；非法/越界 → null（= 不施加）。 */
export function clampVrRenderScale(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return Math.min(XR_RENDER_SCALE_MAX, Math.max(XR_RENDER_SCALE_MIN, value));
}

/** 读取已持久化的偏好（无 → null）。localStorage 不可访问时不抛。 */
export function readVrRenderScalePreference(): number | null {
  try {
    const raw = localStorage.getItem(XR_RENDER_SCALE_STORAGE_KEY);
    if (raw === null) return null;
    return clampVrRenderScale(Number(raw));
  } catch {
    return null;
  }
}

/** 持久化偏好（null = 清除 = 回到官方默认）。localStorage 不可访问时不抛。 */
export function writeVrRenderScalePreference(scale: number | null): void {
  try {
    if (scale === null) {
      localStorage.removeItem(XR_RENDER_SCALE_STORAGE_KEY);
    } else {
      localStorage.setItem(XR_RENDER_SCALE_STORAGE_KEY, String(clampVrRenderScale(scale)));
    }
  } catch {
    /* localStorage 不可访问：偏好不持久化，本会话仍可临时生效。 */
  }
}
