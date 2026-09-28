/**
 * Experience Adapter V2（SSV-05）—— 把 SceneRuntimeDescriptorV1 完整映射为官方
 * ExperienceSettings v2。
 *
 * 官方 schema（defaultSettings() / validateSettings()）是唯一 runtime schema，
 * 不新建 ViewerSettingsV3 / XRSettings / DesktopSettings。
 *
 * 本阶段映射 ScenePresentation 全部渲染字段：
 *   - initial camera        → cameras[0].initial（fov clamp 进官方 authoring 界）
 *   - background color      → background.color
 *   - equirectangular 全景  → background.skyboxUrl
 *   - tonemapping           → tonemapping
 *   - high precision        → highPrecisionRendering
 *   - post effects（单一结构化 JSONB）→ postEffectSettings（每个数值 clamp 进官方
 *     POST_EFFECT_RANGES，保证 limits: true 校验通过）
 *
 * 旧场景缺失的字段一律落在 defaultSettings() 官方默认上 —— 绝不产生非法 settings；
 * 产物始终能通过官方 validateSettings(settings, { limits: true })。
 */
import {
  CAMERA_FOV_RANGE,
  DEFAULT_CAMERA_FOV,
  POST_EFFECT_RANGES,
  defaultSettings,
  validateSettings,
  type ExperienceSettings,
  type PostEffectSettings,
} from '@playcanvas/supersplat-viewer/settings';
import type { SceneRuntimeDescriptorV1 } from './types';

const TONEMAPPING_VALUES = [
  'none',
  'linear',
  'filmic',
  'hejl',
  'aces',
  'aces2',
  'neutral',
] as const;

type Tonemapping = (typeof TONEMAPPING_VALUES)[number];

function isTonemapping(value: unknown): value is Tonemapping {
  return typeof value === 'string' && (TONEMAPPING_VALUES as readonly string[]).includes(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 非有限数值 → fallback，再 clamp 进官方范围。 */
function clampNum(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return clamp(num, range.min, range.max);
}

/** 把描述里的 Vec3 归一化 0..1 RGB 映射为官方 [r, g, b] 元组。 */
function toRgbTuple(color: { x: number; y: number; z: number } | null): [number, number, number] | null {
  if (!color) return null;
  return [color.x, color.y, color.z];
}

function clampTint(tint: unknown): [number, number, number] {
  if (
    Array.isArray(tint) &&
    tint.length === 3 &&
    tint.every((v) => typeof v === 'number' && Number.isFinite(v))
  ) {
    return [clamp(tint[0], 0, 1), clamp(tint[1], 0, 1), clamp(tint[2], 0, 1)];
  }
  return [1, 1, 1];
}

/**
 * 把 runtime 的 post-effects 文档（可能部分缺失 / 越界）归一化为合法的官方
 * postEffectSettings：以官方 defaultPostEffectSettings() 起底，逐 effect 覆盖，
 * 每个数值 clamp 进官方 POST_EFFECT_RANGES。null → 官方默认（全关）。
 */
function buildPostEffectSettings(raw: {
  sharpness?: { enabled?: boolean; amount?: number };
  bloom?: { enabled?: boolean; intensity?: number; blurLevel?: number };
  grading?: { enabled?: boolean; brightness?: number; contrast?: number; saturation?: number; tint?: unknown };
  vignette?: { enabled?: boolean; intensity?: number; inner?: number; outer?: number; curvature?: number };
  fringing?: { enabled?: boolean; intensity?: number };
} | null): PostEffectSettings {
  const base = defaultSettings('environment').postEffectSettings;
  if (!raw) return base;
  const R = POST_EFFECT_RANGES;

  base.sharpness.enabled = Boolean(raw.sharpness?.enabled);
  base.sharpness.amount = clampNum(raw.sharpness?.amount, R.sharpness.amount, 0);

  base.bloom.enabled = Boolean(raw.bloom?.enabled);
  base.bloom.intensity = clampNum(raw.bloom?.intensity, R.bloom.intensity, 0.05);
  base.bloom.blurLevel = clampNum(raw.bloom?.blurLevel, R.bloom.blurLevel, 2);

  base.grading.enabled = Boolean(raw.grading?.enabled);
  base.grading.brightness = clampNum(raw.grading?.brightness, R.grading.brightness, 1);
  base.grading.contrast = clampNum(raw.grading?.contrast, R.grading.contrast, 1);
  base.grading.saturation = clampNum(raw.grading?.saturation, R.grading.saturation, 1);
  base.grading.tint = clampTint(raw.grading?.tint);

  base.vignette.enabled = Boolean(raw.vignette?.enabled);
  base.vignette.intensity = clampNum(raw.vignette?.intensity, R.vignette.intensity, 0.5);
  base.vignette.inner = clampNum(raw.vignette?.inner, R.vignette.inner, 0.3);
  base.vignette.outer = clampNum(raw.vignette?.outer, R.vignette.outer, 0.75);
  base.vignette.curvature = clampNum(raw.vignette?.curvature, R.vignette.curvature, 1);

  base.fringing.enabled = Boolean(raw.fringing?.enabled);
  base.fringing.intensity = clampNum(raw.fringing?.intensity, R.fringing.intensity, 0.5);

  return base;
}

/**
 * 生成合法 ExperienceSettings v2。
 *
 * @param descriptor - SSV-01 运行时场景合同。
 * @param fit - 无初始相机时官方 default 相机的摆放方式（默认 environment）。
 * @throws 若产物无法通过官方 validateSettings(settings, { limits: true })。
 */
export function buildExperienceSettings(
  descriptor: SceneRuntimeDescriptorV1,
  fit: 'environment' | 'object' = 'environment',
): ExperienceSettings {
  const settings = defaultSettings(fit);
  const pres = descriptor.presentation;

  // 1) background color —— 存在时覆盖官方默认。
  const bgColor = toRgbTuple(pres.background.color);
  if (bgColor) {
    settings.background.color = bgColor;
  }

  // 2) skybox —— equirectangular 全景资源 URL（同一来源资产 URL）。
  if (pres.background.type === 'equirectangular' && pres.background.url) {
    settings.background.skyboxUrl = pres.background.url;
  }

  // 3) tonemapping —— 旧场景/未知值留在官方默认（'linear'）。
  if (isTonemapping(pres.tonemapping)) {
    settings.tonemapping = pres.tonemapping;
  }

  // 4) high precision rendering。
  settings.highPrecisionRendering = Boolean(pres.highPrecisionRendering);

  // 5) post effects —— 单一结构化 JSONB → 官方 postEffectSettings（clamp 界内）。
  settings.postEffectSettings = buildPostEffectSettings(pres.postEffects);

  // 6) initial camera —— 描述里同时有 position + target 才映射；
  //    fov 存在则 clamp 进官方 authoring 界（limits: true 校验要求）。
  const cam = pres.initialCamera;
  if (cam.position && cam.target) {
    const fov =
      typeof cam.fov === 'number' && Number.isFinite(cam.fov) ? cam.fov : DEFAULT_CAMERA_FOV;
    settings.cameras = [
      {
        initial: {
          position: [cam.position.x, cam.position.y, cam.position.z],
          target: [cam.target.x, cam.target.y, cam.target.z],
          fov: clamp(fov, CAMERA_FOV_RANGE.min, CAMERA_FOV_RANGE.max),
        },
      },
    ];
  }

  // 7) sound / annotations / anim —— 不在本阶段映射（保持官方默认）。

  // 官方校验：作者侧限值全开，任何字段越界立即抛错。
  validateSettings(settings, { limits: true });
  return settings;
}
