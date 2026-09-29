/**
 * FIX-03 §16 — BackgroundAudioController 单元测试。
 *
 * 覆盖（§5/§6/§7）：
 *   - configure：enabled+url → 创建 <audio>；volume/loop 真实生效；url 变化重建；
 *   - 遵守 autoplay：未 start() 不自动 play；start() 后播放；
 *   - ducking 策略：pause()/resume() 暂停/恢复背景（§7 固定「暂停-恢复」）；
 *   - enabled=false → 暂停并释放；destroy() → 场景切换/卸载清理（gesture 监听摘除、
 *     媒体资源释放）；
 *   - 播放被拒（自动播放政策）→ 挂一次性 gesture 重试，下一次 gesture 恢复播放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundAudioController } from '../features/media/BackgroundAudioController';

class MockAudioElement {
  static instances: MockAudioElement[] = [];
  src: string | null = null;
  preload = 'auto';
  loop = false;
  volume = 1;
  played = 0;
  pausedTimes = 0;
  loadedTimes = 0;
  removedSrc = false;
  playResult: Promise<void> = Promise.resolve();

  constructor(src?: string) {
    this.src = src ?? null;
    MockAudioElement.instances.push(this);
  }
  play() {
    this.played += 1;
    return this.playResult;
  }
  pause() {
    this.pausedTimes += 1;
  }
  load() {
    this.loadedTimes += 1;
  }
  removeAttribute(attr: string) {
    if (attr === 'src') this.removedSrc = true;
  }
  set srcObject(_v: unknown) {}
}

beforeEach(() => {
  MockAudioElement.instances = [];
  vi.stubGlobal('Audio', MockAudioElement as unknown as typeof Audio);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BackgroundAudioController', () => {
  it('configure(enabled+url) → 不自动播放（无 gesture 未解锁）；start() 恢复播放', () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/bg.mp3', volume: 0.5, loop: true, enabled: true });
    const el = MockAudioElement.instances[0];
    expect(el).toBeDefined();
    expect(el.src).toBe('https://cdn/bg.mp3');
    expect(el.volume).toBe(0.5);
    expect(el.loop).toBe(true);
    expect(el.played).toBe(0); // autoplay 合规：未解锁不播

    c.start();
    expect(el.played).toBe(1);
    c.destroy();
  });

  it('volume/loop 更新即时生效（不重建元素）；url 变化才重建', () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: true });
    const first = MockAudioElement.instances[0];
    c.configure({ url: 'https://cdn/a.mp3', volume: 0.3, loop: true, enabled: true });
    expect(MockAudioElement.instances).toHaveLength(1); // 同 url 复用
    expect(first.volume).toBe(0.3);
    expect(first.loop).toBe(true);

    c.configure({ url: 'https://cdn/b.mp3', volume: 0.8, loop: false, enabled: true });
    expect(MockAudioElement.instances).toHaveLength(2); // url 变化重建（旧元素释放）
    const second = MockAudioElement.instances[1];
    expect(second.src).toBe('https://cdn/b.mp3');
    expect(first.pausedTimes).toBeGreaterThanOrEqual(1); // 旧元素被 teardown pause
    c.destroy();
  });

  it('§7 ducking：pause() 暂停背景并标记；resume() 在结束/关闭后恢复', () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: true, enabled: true });
    c.start();
    const el = MockAudioElement.instances[0];
    const playedBefore = el.played;

    c.pause(); // 标注 AUDIO/VIDEO 开始播放
    expect(el.pausedTimes).toBeGreaterThanOrEqual(1);

    const playedAfterPause = el.played;
    c.resume(); // 标注结束
    expect(el.played).toBe(playedAfterPause + 1); // resumed
    expect(el.played).toBeGreaterThan(playedBefore);
    c.destroy();
  });

  it('enabled=false → 暂停（configure 关闭即停）；re-enable 且已解锁才恢复', () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: true });
    c.start();
    const el = MockAudioElement.instances[0];
    const playedBefore = el.played;

    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: false });
    expect(el.pausedTimes).toBeGreaterThanOrEqual(1);

    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: true });
    expect(el.played).toBeGreaterThan(playedBefore); // 已解锁 → 恢复
    c.destroy();
  });

  it('§6 scene-change cleanup：destroy() 释放媒体资源并复位（paused/清 src/load）', () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: true });
    c.start();
    const el = MockAudioElement.instances[0];

    c.destroy();
    expect(MockAudioElement.instances[0].pausedTimes).toBeGreaterThanOrEqual(1);
    expect(el.removedSrc).toBe(true);
    expect(el.loadedTimes).toBeGreaterThanOrEqual(1);

    // destroy 后同实例可安全复用于新场景（页面不重建时优雅复用）。
    c.configure({ url: 'https://cdn/b.mp3', volume: 0.6, loop: false, enabled: true });
    expect(MockAudioElement.instances).toHaveLength(2);
    c.destroy();
  });

  it('autoplay 拒绝 → 挂一次性 gesture 重试；下一次 user gesture 后恢复播放', async () => {
    const c = new BackgroundAudioController();
    c.configure({ url: 'https://cdn/a.mp3', volume: 1, loop: false, enabled: true });
    const el = MockAudioElement.instances[0];
    // 模拟浏览器首次拒绝 play（autoplay 政策）
    el.playResult = Promise.reject(new Error('NotAllowedError'));
    c.start();
    expect(el.played).toBeGreaterThanOrEqual(1);

    // 等 catch 分支执行完，gesture 重试监听已挂上
    await Promise.resolve();
    await Promise.resolve();

    el.playResult = Promise.resolve();
    window.dispatchEvent(new Event('pointerdown'));
    expect(el.played).toBeGreaterThanOrEqual(2); // gesture 后重试成功
    c.destroy();
  });
});