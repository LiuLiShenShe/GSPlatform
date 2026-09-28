import { expect, test } from './fresh-browser';

test('Background audio: 官方 soundUrl 创建唯一 Audio 实例（不建第二套）', async ({ page }) => {
  // 在页面脚本前 patch Audio 构造器，记录官方 viewer 创建的音频实例 src。
  await page.addInitScript(() => {
    (window as unknown as { __audioSrcs: string[] }).__audioSrcs = [];
    const Orig = window.Audio;
    const Patched = function (this: HTMLAudioElement, src?: string) {
      const a = new Orig(src) as HTMLAudioElement;
      (window as unknown as { __audioSrcs: string[] }).__audioSrcs.push(src ?? '');
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
  // 官方 loaded 后创建 Audio(soundUrl)。
  await page.waitForFunction(
    () => (window as unknown as { __audioSrcs: string[] }).__audioSrcs.length > 0,
    { timeout: 30000 },
  );
  const srcs = await page.evaluate(() => (window as unknown as { __audioSrcs: string[] }).__audioSrcs);
  console.log('official Audio instances:', JSON.stringify(srcs));
  expect(srcs.length).toBe(1); // 唯一播放来源
  expect(srcs[0]).toContain('/api/v1/scenes/r-8c4e2264e86a/presentation/background-audio');
});
