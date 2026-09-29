/**
 * BackgroundAudioController（FIX-03 §5/§6/§7）—— GSPlatform 自己管理 Background Audio。
 *
 * 策略（§5，固定）：**不再使用官方 ExperienceSettings.soundUrl**（官方无 volume /
 * loop / enabled / mute API）。由本控制器管理单一 <audio> 元素：
 *
 *   - enabled / url / volume(0..1) / loop 全部真实生效；
 *   - 遵守浏览器 autoplay 政策：不绕过 —— 首次用户 gesture（指针/键盘）后才开始播放，
 *     播放被浏览器拒绝时挂一次性 gesture 重试；
 *   - pause() / resume() 供标注媒体 ducking（§7：AUDIO/VIDEO 播放时暂停背景，
 *     结束/关闭后恢复 —— 采用「暂停-恢复」而非音量压低，保证不争抢）；
 *   - destroy()：场景切换/页面卸载停止并释放资源（暂停 + 清 src + load 复位）。
 */
export interface BackgroundAudioInput {
  url: string | null;
  volume: number;
  loop: boolean;
  enabled: boolean;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(Math.max(v, 0), 1);
}

export class BackgroundAudioController {
  /** 当前资源配置（含 url，用于比对变化）。 */
  private settings: BackgroundAudioInput = { url: null, volume: 1, loop: false, enabled: false };

  private audio: HTMLAudioElement | null = null;

  /** 是否已获得用户 gesture 解锁（start() 调用过）。 */
  private unlocked = false;

  /** 标注媒体播放导致的暂停标记（resume() 清除）。 */
  private pausedByDuck = false;

  private gestureCleanup: (() => void) | null = null;

  /** 当前启用状态 + 有 url。 */
  get active(): boolean {
    return this.settings.enabled && Boolean(this.settings.url) && Boolean(this.audio);
  }

  get volume(): number {
    return this.settings.volume;
  }

  /**
   * 配置（url 变化 → 重建元素；enabled 关闭 → 暂停）。幂等。
   * 页面在 descriptor.backgroundAudio 变化时调用。
   */
  configure(input: BackgroundAudioInput): void {
    const next: BackgroundAudioInput = {
      url: input.url,
      volume: clamp01(input.volume),
      loop: Boolean(input.loop),
      enabled: Boolean(input.enabled),
    };
    const urlChanged = next.url !== this.settings.url;
    this.settings = next;

    if (urlChanged || !this.audio) {
      this.teardownAudio();
      if (this.settings.enabled && this.settings.url) {
        // 惰性创建；不自动 play（autoplay 政策由 start() 经 gesture 解锁）。
        const el = new Audio(this.settings.url);
        el.preload = 'auto';
        el.loop = this.settings.loop;
        el.volume = this.settings.volume;
        this.audio = el;
      }
    } else if (this.audio) {
      this.audio.loop = this.settings.loop;
      this.audio.volume = this.settings.volume;
    }

    if (!this.settings.enabled) {
      this.pauseInternal();
    } else if (this.unlocked && !this.pausedByDuck) {
      this.playInternal();
    }
  }

  /** 首次用户 gesture 后调用（autoplay 合规）。幂等。 */
  start(): void {
    this.unlocked = true;
    if (this.settings.enabled && !this.pausedByDuck) this.playInternal();
  }

  /** 标注媒体播放时暂停背景（§7 ducking 策略）。 */
  pause(): void {
    this.pausedByDuck = true;
    this.pauseInternal();
  }

  /** 标注媒体结束/关闭后恢复背景（若仍启用且已解锁）。 */
  resume(): void {
    this.pausedByDuck = false;
    if (this.settings.enabled && this.unlocked) this.playInternal();
  }

  /** 立即停止并释放（场景切换 / 卸载）。幂等。 */
  destroy(): void {
    this.gestureCleanup?.();
    this.gestureCleanup = null;
    this.teardownAudio();
    this.settings = { url: null, volume: 1, loop: false, enabled: false };
    this.unlocked = false;
  }

  // ------------------------------------------------------------------ //
  // 内部
  // ------------------------------------------------------------------ //

  private playInternal(): void {
    if (!this.audio || !this.settings.enabled) return;
    const result = this.audio.play();
    // play() 规范返回 Promise；个别环境（jsdom / 旧实现）可能返回 undefined ——
    // 仅当真是 Promise 时挂 gesture 重试，避免对 undefined 调 .catch 抛错。
    if (result && typeof result.catch === 'function') {
      void result.catch(() => {
        // 浏览器仍拒绝（如新元素需新 gesture）→ 挂一次性 gesture 重试，不抛错。
        this.attachGestureRetry();
      });
    }
  }

  private pauseInternal(): void {
    this.audio?.pause();
  }

  private teardownAudio(): void {
    if (!this.audio) return;
    const el = this.audio;
    this.audio = null;
    try {
      el.pause();
      el.removeAttribute('src');
      el.load(); // 释放媒体资源
      (el as unknown as { srcObject?: unknown }).srcObject = null;
    } catch {
      // 已销毁/异常 —— 忽略。
    }
  }

  /** 一次性 gesture 重试监听（播放被拒后自动清理）。 */
  private attachGestureRetry(): void {
    if (this.gestureCleanup) return;
    const unlock = () => {
      this.cleanupGesture();
      this.playInternal();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
    this.gestureCleanup = () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
  }

  private cleanupGesture(): void {
    this.gestureCleanup?.();
    this.gestureCleanup = null;
  }
}