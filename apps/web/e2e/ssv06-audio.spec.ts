import { expect, test } from './fresh-browser';

/**
 * FIX-03 §5/§6/§7/§15 —— 背景音频（Background Audio）真实浏览器取证。
 *
 * 背景音频不再走官方 ExperienceSettings.soundUrl（官方无 volume/loop/enabled API），
 * 改由 GSPlatform 自建 BackgroundAudioController 管理单一 <audio> 元素。本 spec 验证：
 *   - §5：唯一 Audio 实例由 GSPlatform 控制器创建（src 解析为背景音频 URL）；
 *   - §6：volume / loop 真实作用到元素；遵守 autoplay 政策（无用户手势前不播放），
 *         首次用户手势后播放；
 *   - §7：打开 AUDIO 标注 → 暂停背景（ducking 策略），关闭 Overlay → 恢复；
 *   - §6：切换到无背景音频的场景 → 旧音频元素被 teardown（清 src + load 复位）。
 */

/** 页面侧读取第一个（也是唯一）背景音频元素的脚本片段（避免重复内联）。 */
const firstAudioJs = `(window.__audioEls ?? [])[0]`;

test('FIX-03 background audio: GSPlatform 控制器管理 volume/loop/gesture/ducking/scene-cleanup', async ({ page }) => {
  // 页面脚本前 patch Audio：记录创建的元素并暴露 teardown 信号（清 src / load / pause）。
  await page.addInitScript(() => {
    (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls = [];
    const Orig = window.Audio;
    const Patched = function (this: HTMLAudioElement, src?: string) {
      const a = new Orig(src) as HTMLAudioElement;
      const ext = a as unknown as Record<string, unknown>;
      ext.__srcRemoved = false;
      ext.__loadCount = 0;
      const origRemove = a.removeAttribute.bind(a);
      a.removeAttribute = (name: string) => {
        if (name === 'src') ext.__srcRemoved = true;
        return origRemove(name);
      };
      const origLoad = a.load.bind(a);
      a.load = () => {
        ext.__loadCount = (ext.__loadCount as number) + 1;
        return origLoad();
      };
      (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls.push(a);
      return a;
    } as unknown as typeof Audio;
    Patched.prototype = Orig.prototype;
    (window as unknown as { Audio: typeof Audio }).Audio = Patched;
  });

  await page.goto('/scene/r-8c4e2264e86a');
  await page.waitForSelector('canvas', { state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ov-diagnostics"]');
    if (!el) return false;
    try { return JSON.parse(el.textContent ?? '{}').loaded === true; } catch { return false; }
  }, { timeout: 90000 });

  // §5：GSPlatform 控制器创建唯一 Audio 实例（不再由官方 soundUrl 创建）。
  await page.waitForFunction(
    () => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls.length > 0,
    { timeout: 30000 },
  );
  const count = await page.evaluate(
    () => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls.length,
  );
  expect(count).toBe(1);
  const src = await page.evaluate(() => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls[0].src);
  console.log('GSPlatform background audio src:', src);
  expect(src).toContain('/api/v1/scenes/r-8c4e2264e86a/presentation/background-audio');

  // §6：volume / loop 真实作用到元素（descriptor: volume=0.6, loop=true, enabled=true）。
  const vol = await page.evaluate(() => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls[0].volume);
  const loop = await page.evaluate(() => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls[0].loop);
  expect(vol).toBeCloseTo(0.6, 2);
  expect(loop).toBe(true);

  // §6：autoplay 政策 —— 无用户手势前不播放（paused=true）。
  expect(
    await page.evaluate(() => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls[0].paused),
  ).toBe(true);

  // §6：首次用户手势（pointerdown）后开始播放。
  await page.mouse.click(400, 300);
  await page.waitForFunction(() => {
    const els = (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls;
    return els.length > 0 && !els[0].paused;
  }, { timeout: 15000 });
  console.log('background audio playing after gesture: OK');

  // §7 ducking：打开 AUDIO 标注 → 背景暂停。关闭 → 背景恢复。
  const hotspots = page.locator('.sse-annotation-hotspots .sse-annotation-hotspot');
  await expect(hotspots).toHaveCount(5, { timeout: 30000 });
  await hotspots.nth(3).evaluate((el) => (el as HTMLElement).click());
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid^="annotation-media-overlay-"]');
      return el !== null && el.getAttribute('data-content-type') === 'AUDIO';
    },
    { timeout: 15000 },
  );
  await page.waitForFunction(() => {
    const els = (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls;
    return els.length > 0 && els[0].paused;
  }, { timeout: 15000 });
  console.log('background audio ducked (paused) while AUDIO annotation plays: OK');

  await page.click('[data-testid="annotation-media-overlay-close"]');
  await page.waitForFunction(() => {
    const els = (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls;
    return els.length > 0 && !els[0].paused;
  }, { timeout: 15000 });
  console.log('background audio resumed after overlay close: OK');

  // §6：切换到无背景音频的场景（小体积单文件 SOG，避免 headless SwiftShader
  // 已知崩溃基线）→ 旧音频 teardown（清 src + load 复位 + 暂停）。
  await page.evaluate(() => {
    window.history.pushState({}, '', '/scene/fix02-semantics');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.waitForFunction(() => {
    const els = (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls;
    const el = els[0] as HTMLAudioElement & Record<string, unknown>;
    return el !== undefined && el.__srcRemoved === true && (el.__loadCount as number) > 0;
  }, { timeout: 30000 });
  const stillCount = await page.evaluate(
    () => (window as unknown as { __audioEls: HTMLAudioElement[] }).__audioEls.length,
  );
  console.log('old background audio torn down on scene switch, total Audio els:', stillCount);
  expect(stillCount).toBe(1); // 新场景无背景音频 → 不再创建新元素
});
