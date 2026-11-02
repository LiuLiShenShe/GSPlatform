/**
 * 拾取模式下「转视角」与「点选落点」的指针转发（GS-UI-01 后续修正）。
 *
 * 官方 SuperSplat Viewer 在 orbit 模式下把「鼠标拖动」交给键盘-鼠标输入源
 * （画布上 pointerdown/move/up，位移用 screenX/screenY 差），把「单击」当作
 * 「聚焦到点击点」（orbitTarget:set，相机目标被移动）。创作页拾取模式原本用
 * 一个全屏透明 overlay 盖住画布 → 相机完全被锁死，用户反馈「点增加标记点
 * 之后卡住」（想转一下视角看落点都不行）。
 *
 * 这里在 overlay 上做手势判别：
 *   - 拖动超过 {@link PICK_DRAG_THRESHOLD_PX} → 把合成 pointer 事件转发到画布，
 *     官方相机正常转视角；
 *   - 单击（未超过阈值）→ 不转发（否则官方会做 click-focus），由宿主落点。
 *
 * 转发必须满足官方的三个隐含前提（否则相机纹丝不动）：
 *   1. 事件必须是 PointerEvent 且 `pointerType='mouse'`（否则输入源直接 return）；
 *   2. `screenX/screenY` 必须携带（KeyboardMouseSource 用 screen 坐标差算 delta，
 *      不用 clientX/movementX）；
 *   3. `pointerdown` 会调用 `canvas.setPointerCapture` —— 对合成事件（没有真实
 *      指针捕获）会抛 NotFoundError，必须临时打桩、派发后恢复。
 *
 * `pointerup` 一律以 `button:-1` 派发：官方 click-focus 只在 `button===0` 的
 * pointerup 上触发，而 KeyboardMouseSource 的收尾（清按钮/复位指针 id）不检查
 * button —— 因此拖动能干净结束，又绝不会把「转视角」误判成「聚焦」。
 *
 * wheel 直接合成转发（官方 wheel 处理器只读 deltaX/deltaY，无指针副作用）。
 */

/** 拖动超过该像素数才算「转视角」，否则算「点选落点」。 */
export const PICK_DRAG_THRESHOLD_PX = 4;

/** 一次指针事件需要的最小采样（screen 坐标驱动官方相机位移）。 */
export interface PickPointerSample {
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  pointerId: number;
}

/** 从 React/原生 pointer 事件采样（只取我们需要的字段）。 */
export function samplePickPointer(
  e: {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;
    pointerId: number;
  },
): PickPointerSample {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY,
    pointerId: e.pointerId,
  };
}

/** 起点到当前点是否已构成一次「拖动」（超过阈值）。 */
export function isPickDrag(
  start: PickPointerSample | null,
  current: PickPointerSample,
): boolean {
  if (!start) return false;
  return Math.hypot(current.screenX - start.screenX, current.screenY - start.screenY) > PICK_DRAG_THRESHOLD_PX;
}

/** 在 viewer 容器内找官方画布（转发目标）。 */
export function findForwardCanvas(root: ParentNode | null): HTMLCanvasElement | null {
  if (!root) return null;
  const canvas = root.querySelector('canvas');
  return canvas instanceof HTMLCanvasElement ? canvas : null;
}

/** 合成 PointerEvent 的公共初始化参数。 */
function pointerInit(sample: PickPointerSample, button: number): PointerEventInit {
  return {
    clientX: sample.clientX,
    clientY: sample.clientY,
    screenX: sample.screenX,
    screenY: sample.screenY,
    pointerId: sample.pointerId,
    pointerType: 'mouse',
    isPrimary: true,
    button,
    buttons: button === 0 ? 1 : 0,
    bubbles: true,
    cancelable: true,
  };
}

/** 派发合成 pointer 事件：临时打桩 setPointerCapture/releasePointerCapture。 */
function dispatchSynthetic(canvas: HTMLCanvasElement, event: PointerEvent): void {
  const originalCapture = canvas.setPointerCapture;
  const originalRelease = canvas.releasePointerCapture;
  canvas.setPointerCapture = () => undefined;
  canvas.releasePointerCapture = () => undefined;
  try {
    canvas.dispatchEvent(event);
  } finally {
    canvas.setPointerCapture = originalCapture;
    canvas.releasePointerCapture = originalRelease;
  }
}

/**
 * 向官方画布转发一次指针事件（转视角用）。
 *
 * - `pointerdown`：`button:0`，启动官方输入源的跟踪；
 * - `pointermove`：`button:-1`，只带位移（不参与任何按钮语义）；
 * - `pointerup`：`button:-1`，收尾且**不**触发官方 click-focus。
 */
export function forwardPickPointer(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  sample: PickPointerSample,
): void {
  const button = type === 'pointerdown' ? 0 : -1;
  dispatchSynthetic(canvas, new PointerEvent(type, pointerInit(sample, button)));
}

/** 向官方画布转发一次滚轮（缩放）。保留修饰键，让 Shift/滚轮平移等语义不变。 */
export function forwardPickWheel(
  canvas: HTMLCanvasElement,
  wheel: {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    metaKey?: boolean;
  },
): void {
  canvas.dispatchEvent(
    new WheelEvent('wheel', {
      clientX: 0,
      clientY: 0,
      deltaX: wheel.deltaX,
      deltaY: wheel.deltaY,
      deltaMode: wheel.deltaMode,
      ctrlKey: wheel.ctrlKey ?? false,
      shiftKey: wheel.shiftKey ?? false,
      altKey: wheel.altKey ?? false,
      metaKey: wheel.metaKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}
