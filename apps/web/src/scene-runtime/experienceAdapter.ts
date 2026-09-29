/**
 * Experience Adapter V2（SSV-05/06）—— 把 SceneRuntimeDescriptorV1 完整映射为官方
 * ExperienceSettings v2。
 *
 * 官方 schema（defaultSettings() / validateSettings()）是唯一 runtime schema，
 * 不新建 ViewerSettingsV3 / XRSettings / DesktopSettings。
 *
 * SSV-05 映射 ScenePresentation 全部渲染字段：
 *   - initial camera        → cameras[0].initial（fov clamp 进官方 authoring 界）
 *   - background color      → background.color
 *   - equirectangular 全景  → background.skyboxUrl
 *   - tonemapping           → tonemapping
 *   - high precision        → highPrecisionRendering
 *   - post effects（单一结构化 JSONB）→ postEffectSettings（每个数值 clamp 进官方
 *     POST_EFFECT_RANGES，保证 limits: true 校验通过）
 *
 * SSV-06 映射标注 / 背景音频：
 *   - annotations           → settings.annotations[]（position/title/text/camera/extras；
 *     extras 固定协议 { gsplatform: { annotationId, contentType } }；HTML sanitize；
 *     title/text 截断进官方 ANNOTATION_LIMITS；数量 cap 25）
 *   - backgroundAudio       → settings.soundUrl（官方能力；禁止第二套同时播放的音频）
 *
 * 旧场景缺失的字段一律落在 defaultSettings() 官方默认上 —— 绝不产生非法 settings；
 * 产物始终能通过官方 validateSettings(settings, { limits: true })。
 */
import {
  ANNOTATION_LIMITS,
  CAMERA_FOV_RANGE,
  DEFAULT_CAMERA_FOV,
  POST_EFFECT_RANGES,
  defaultSettings,
  validateSettings,
  type ExperienceSettings,
  type PostEffectSettings,
} from '@playcanvas/supersplat-viewer/settings';
import type { SceneRuntimeDescriptorV1 } from './types';
import { SceneTransformAdapter } from './SceneTransformAdapter';

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
  // FIX-02 §5-§9：世界变换 W 统一施加到 gsplat 实体；初始相机 / 标注 / 视角点
  // 全部经 adapter 从 SCENE 空间换算到 RUNTIME 空间，与移动后的场景保持一致。
  const adapter = SceneTransformAdapter.fromWorldTransform(pres.worldTransform);

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

  // 6) initial camera —— 描述里同时有 position + target 才映射（显式 null 语义，
  //    FIX-02 §3：绝不用 position != [0,0,0] 猜测）；fov 存在则 clamp 进官方
  //    authoring 界（limits: true 校验要求）。经世界变换换算到 RUNTIME 空间。
  const cam = pres.initialCamera;
  if (cam.position && cam.target) {
    const fov =
      typeof cam.fov === 'number' && Number.isFinite(cam.fov) ? cam.fov : DEFAULT_CAMERA_FOV;
    const runtimeCam = adapter.sceneToRuntimeCamera({
      position: cam.position,
      target: cam.target,
      fov,
    });
    settings.cameras = [
      {
        initial: {
          position: [runtimeCam.position.x, runtimeCam.position.y, runtimeCam.position.z],
          target: [runtimeCam.target.x, runtimeCam.target.y, runtimeCam.target.z],
          fov: clamp(runtimeCam.fov, CAMERA_FOV_RANGE.min, CAMERA_FOV_RANGE.max),
        },
      },
    ];
  }

  // 7) background audio —— 由 GSPlatform 自建 BackgroundAudioController 管理（FIX-03 §5）：
  //    官方 ExperienceSettings 仅 soundUrl 且无 volume/loop/enabled API，**不再写入**
  //    settings.soundUrl。页面层从 descriptor.backgroundAudio 配置独立控制器。
  //    注意：官方 settings.soundUrl 不可用后，ExperienceSettings.soundUrl 保持 undefined。

  // 8) annotations —— SSV-06：官方 annotations[]（position/title/text/camera/extras）。
  //    每个 annotation 都带 extras 固定协议 { gsplatform: { annotationId, contentType } }，
  //    页面依据 annotationId 解析（禁止用数组 index 当数据库 ID）。
  //    FIX-02 §14：每个 official annotation 的 camera.initial 来自该标注**自己**的
  //    camera（经世界变换换算），不再是 settings.cameras[0]。
  settings.annotations = buildAnnotations(descriptor, settings, adapter);

  // 官方校验：作者侧限值全开，任何字段越界立即抛错。
  validateSettings(settings, { limits: true });
  return settings;
}

/**
 * 把 descriptor.annotations 映射为官方 settings.annotations（SSV-06 + FIX-02 §14）。
 *
 * - 仅保留 enabled 标注，数量 cap 进官方 ANNOTATION_LIMITS.maxCount。
 * - title / text 做 HTML sanitize（剥标签成纯文本）后截断进官方
 *   ANNOTATION_LIMITS.titleMax / textMax。
 * - extras 为固定协议 { gsplatform: { annotationId, contentType } }。
 * - camera.initial **来自该标注自己的 camera**（cameraPosition/cameraTarget/cameraFov，
 *   拾取时保存的 Viewer pose），经世界变换换算到 RUNTIME 空间；官方 hotspot 点击后
 *   camera navigation 由官方执行（fly 到该 camera）。当标注未作者化相机时逐条回落到
 *   场景初始相机（换算后），而不是把 settings.cameras[0] 无条件共享给所有标注。
 * - 标注锚点 anchor 同样经世界变换换算到 RUNTIME 空间（与移动后的高斯对齐）。
 */
export function buildAnnotations(
  descriptor: SceneRuntimeDescriptorV1,
  settings: Pick<ExperienceSettings, 'cameras'>,
  adapter: SceneTransformAdapter = SceneTransformAdapter.fromWorldTransform(
    descriptor.presentation.worldTransform,
  ),
): {
  position: [number, number, number];
  title: string;
  text: string;
  extras: { gsplatform: { annotationId: string; contentType: string } };
  camera: { initial: { position: [number, number, number]; target: [number, number, number]; fov: number } };
}[] {
  // 场景初始相机（换算到 RUNTIME 空间）—— 未作者化相机标注的回落值。
  const base = settings.cameras[0]?.initial;
  const fallbackPos: [number, number, number] = base
    ? [base.position[0], base.position[1], base.position[2]]
    : [0, 2, 0];
  const fallbackTarget: [number, number, number] = base
    ? [base.target[0], base.target[1], base.target[2]]
    : [2, 2, 0];
  const fallbackFov = base ? base.fov : DEFAULT_CAMERA_FOV;

  return descriptor.annotations
    .filter((a) => a.enabled !== false)
    .slice(0, ANNOTATION_LIMITS.maxCount)
    .map((a) => {
      const title = sanitizeAnnotationText(a.title).slice(0, ANNOTATION_LIMITS.titleMax);
      const text = sanitizeAnnotationText(a.textContent).slice(0, ANNOTATION_LIMITS.textMax);

      // 锚点 → RUNTIME 空间（与被世界变换移动后的高斯表面一致）。
      const anchor = adapter.sceneToRuntimePoint(a.anchor);

      // camera：优先该标注自己的相机（position+target 都存在时），经世界变换换算；
      // 否则逐条回落场景初始相机。
      let camPos: [number, number, number] = fallbackPos;
      let camTarget: [number, number, number] = fallbackTarget;
      let fov = fallbackFov;
      if (a.cameraPosition && a.cameraTarget) {
        const rt = adapter.sceneToRuntimeCamera({
          position: a.cameraPosition,
          target: a.cameraTarget,
          fov:
            typeof a.cameraFov === 'number' && Number.isFinite(a.cameraFov)
              ? a.cameraFov
              : fallbackFov,
        });
        camPos = [rt.position.x, rt.position.y, rt.position.z];
        camTarget = [rt.target.x, rt.target.y, rt.target.z];
        fov = rt.fov;
      } else if (typeof a.fov === 'number' && Number.isFinite(a.fov)) {
        fov = a.fov;
      }
      fov = clamp(fov, CAMERA_FOV_RANGE.min, CAMERA_FOV_RANGE.max);

      return {
        position: [anchor.x, anchor.y, anchor.z],
        title: title || '标注',
        text,
        extras: { gsplatform: { annotationId: a.id, contentType: a.contentType } },
        camera: { initial: { position: camPos, target: camTarget, fov } },
      };
    });
}

/** 剥掉 HTML 标签（含 script/style/注释），返回纯文本 —— TEXT 标注内容必须 sanitize。 */
function sanitizeAnnotationText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
