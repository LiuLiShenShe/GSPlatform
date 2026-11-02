/**
 * GS-UI-01 后续修正 —— 拾取模式「拖动转视角 / 单击落点」的指针转发契约。
 *
 * 真实浏览器取证（`/tmp/pick_orbit_probe*.cjs`）证明：
 *   - 拾取 overlay 盖住画布时，官方相机对拖动/滚轮完全无响应（用户反馈「卡住」）；
 *   - 把合成 PointerEvent 派发到画布可以驱动官方相机 —— 但前提是
 *     `screenX/screenY` 携带位移、`pointerId` 一致、且 `setPointerCapture`
 *     不能因为「合成指针」抛 NotFoundError。
 *
 * 本文件锁住这三条，避免以后改回「只盖住画面」或丢掉 screen 坐标。
 */
import { describe, expect, it } from 'vitest';
import {
  findForwardCanvas,
  forwardPickPointer,
  forwardPickWheel,
  isPickDrag,
  PICK_DRAG_THRESHOLD_PX,
  samplePickPointer,
  type PickPointerSample,
} from '../features/authoring/pickPointerForwarding';

const sample = (over: Partial<PickPointerSample> = {}): PickPointerSample => ({
  clientX: 100,
  clientY: 200,
  screenX: 100,
  screenY: 200,
  pointerId: 3,
  ...over,
});

/** 一个会记录派发事件、且指针捕获会抛错的假画布（模拟官方输入源的调用）。 */
function fakeCanvas() {
  const canvas = document.createElement('canvas');
  const received: Event[] = [];
  canvas.addEventListener('pointerdown', (e) => received.push(e));
  canvas.addEventListener('pointermove', (e) => received.push(e));
  canvas.addEventListener('pointerup', (e) => received.push(e));
  canvas.addEventListener('wheel', (e) => received.push(e));
  // 真实浏览器里对合成 pointerId 调 setPointerCapture 会抛 NotFoundError。
  canvas.setPointerCapture = () => {
    throw new Error('NotFoundError: synthetic pointer cannot be captured');
  };
  canvas.releasePointerCapture = () => {
    throw new Error('NotFoundError: synthetic pointer cannot be captured');
  };
  return { canvas, received };
}

describe('isPickDrag', () => {
  it('未按下（无起点）不算拖动', () => {
    expect(isPickDrag(null, sample())).toBe(false);
  });

  it('阈值内算点击、超过阈值算拖动', () => {
    const start = sample({ screenX: 10, screenY: 10 });
    expect(isPickDrag(start, sample({ screenX: 10 + PICK_DRAG_THRESHOLD_PX, screenY: 10 }))).toBe(false);
    expect(isPickDrag(start, sample({ screenX: 10 + PICK_DRAG_THRESHOLD_PX + 0.5, screenY: 10 }))).toBe(true);
    // 斜向位移按欧氏距离判定
    expect(isPickDrag(start, sample({ screenX: 13, screenY: 13 }))).toBe(true);
  });
});

describe('findForwardCanvas', () => {
  it('在 viewer 容器里找到官方 canvas', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="mount"><canvas></canvas></div>';
    expect(findForwardCanvas(root)).toBe(root.querySelector('canvas'));
  });

  it('没有 canvas / 没有容器时返回 null', () => {
    expect(findForwardCanvas(document.createElement('div'))).toBeNull();
    expect(findForwardCanvas(null)).toBeNull();
  });
});

describe('forwardPickPointer', () => {
  it('pointerdown 用 button=0 并携带 screen 坐标（官方输入源靠 screen 差算位移）', () => {
    const { canvas, received } = fakeCanvas();
    forwardPickPointer(canvas, 'pointerdown', sample({ screenX: 321, screenY: 654 }));
    expect(received).toHaveLength(1);
    const e = received[0] as PointerEvent;
    expect(e.type).toBe('pointerdown');
    expect(e.button).toBe(0);
    expect(e.buttons).toBe(1);
    expect(e.screenX).toBe(321);
    expect(e.screenY).toBe(654);
    expect(e.pointerType).toBe('mouse');
    expect(e.pointerId).toBe(3);
  });

  it('pointermove / pointerup 用 button=-1 —— 官方只在 button=0 的 pointerup 上做 click-focus', () => {
    const { canvas, received } = fakeCanvas();
    forwardPickPointer(canvas, 'pointermove', sample());
    forwardPickPointer(canvas, 'pointerup', sample());
    expect(received.map((e) => (e as PointerEvent).button)).toEqual([-1, -1]);
    expect(received.map((e) => e.type)).toEqual(['pointermove', 'pointerup']);
  });

  it('合成指针的 setPointerCapture 抛错不阻断派发，且派发后恢复原方法', () => {
    const { canvas, received } = fakeCanvas();
    const capture = canvas.setPointerCapture;
    const release = canvas.releasePointerCapture;
    expect(() => forwardPickPointer(canvas, 'pointerdown', sample())).not.toThrow();
    expect(received).toHaveLength(1);
    // 打桩只发生在派发期间，之后必须还原（否则真实指针捕获被永久禁用）。
    expect(canvas.setPointerCapture).toBe(capture);
    expect(canvas.releasePointerCapture).toBe(release);
  });
});

describe('forwardPickWheel', () => {
  it('合成 wheel 携带 deltaY（官方滚轮处理器只读 delta）', () => {
    const { canvas, received } = fakeCanvas();
    forwardPickWheel(canvas, { deltaX: 0, deltaY: -240, deltaMode: 0 });
    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('wheel');
    expect((received[0] as WheelEvent).deltaY).toBe(-240);
  });

  it('保留修饰键（Shift+滚轮=平移、Ctrl+滚轮=旋转语义不变）', () => {
    const { canvas, received } = fakeCanvas();
    forwardPickWheel(canvas, { deltaX: 10, deltaY: 0, deltaMode: 0, shiftKey: true });
    const e = received[0] as WheelEvent;
    expect(e.shiftKey).toBe(true);
    expect(e.ctrlKey).toBe(false);
    expect(e.deltaX).toBe(10);
  });
});

describe('samplePickPointer', () => {
  it('只取官方输入源需要的字段', () => {
    const spy = { clientX: 1, clientY: 2, screenX: 3, screenY: 4, pointerId: 5, button: 9 };
    expect(samplePickPointer(spy)).toEqual({
      clientX: 1,
      clientY: 2,
      screenX: 3,
      screenY: 4,
      pointerId: 5,
    });
  });
});
