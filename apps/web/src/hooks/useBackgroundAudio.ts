/**
 * useBackgroundAudio（FIX-03 §5/§6/§7）—— 运行时页面接入 BackgroundAudioController 的
 * React hook。
 *
 * - descriptor.backgroundAudio 变化 → configure()（url 变化重建 <audio>，volume/loop/
 *   enabled 即时生效；enabled=false → 暂停）。
 * - 首次用户 gesture（pointerdown/keydown/touchstart，一次性）→ start() 满足浏览器
 *   autoplay 政策；此后播放被拒绝也自动挂一次性 gesture 重试（controller 内部）。
 * - 场景切换（sceneId 变）或页面卸载 → destroy()（暂停 + 释放媒体资源）。
 *
 * 返回 { pause, resume } 供标注媒体 ducking（§7 固定策略：AUDIO/VIDEO 播放时暂停背景，
 * 结束/关闭/暂停时恢复）—— 直接传给 AnnotationMediaOverlay 的 onPlaybackChange。
 */
import { useCallback, useEffect, useRef } from 'react';
import {
  BackgroundAudioController,
  type BackgroundAudioInput,
} from '../features/media/BackgroundAudioController';
import type { RuntimeBackgroundAudio } from '../scene-runtime/types';
import { resolveRuntimeAssetUrl } from '../scene-runtime/assetUrl';

export interface BackgroundAudioControllerApi {
  /** 标注媒体开始播放 → 暂停背景（ducking）。惰性：未启用时安全。 */
  pause: () => void;
  /** 标注媒体结束/关闭 → 恢复背景（若仍启用且已解锁）。 */
  resume: () => void;
}

export function useBackgroundAudio(
  backgroundAudio: RuntimeBackgroundAudio | null,
  sceneId: string,
): BackgroundAudioControllerApi {
  const controllerRef = useRef<BackgroundAudioController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new BackgroundAudioController();
  }

  // 配置：descriptor.backgroundAudio 变化 → configure（对比当前场景）。
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    let input: BackgroundAudioInput;
    if (backgroundAudio && backgroundAudio.enabled) {
      // URL 解析为绝对运行时资源地址（跨源/相对路径会 404）。
      input = {
        url: backgroundAudio.url ? resolveRuntimeAssetUrl(backgroundAudio.url) : null,
        volume: backgroundAudio.volume,
        loop: backgroundAudio.loop,
        enabled: backgroundAudio.enabled,
      };
    } else {
      input = { url: null, volume: 1, loop: false, enabled: false };
    }
    controller.configure(input);
  }, [backgroundAudio]);

  // 场景切换 / 卸载 → 停止并释放（§6 scene-change cleanup + unload）。
  // 注意：**不**清空 ref —— destroy() 将控制器状态复位为干净初始态，场景切换后
  // configure() 会立刻重新应用新场景配置；卸载后组件不再渲染，无残留风险。
  useEffect(() => {
    return () => controllerRef.current?.destroy();
  }, [sceneId]);

  // 首次用户 gesture 解锁 autoplay（start() 幂等：已解锁时 play() 是无害 no-op）。
  // 场景切换 destroy() 会复位 unlocked 标记 —— 不设 once，切换后的下一次 gesture
  // 自动重新解锁。
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return undefined;
    const unlock = () => controller.start();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }, []);

  const pause = useCallback(() => controllerRef.current?.pause(), []);
  const resume = useCallback(() => controllerRef.current?.resume(), []);

  return { pause, resume };
}