/**
 * PcuiNumericInput —— 官方 PCUI NumericInput 的「最新闭包 + prop 回显抑制」适配层。
 *
 * ## 为什么需要它
 *
 * `@playcanvas/pcui/react` 6.1.4 的 `Element.componentDidUpdate` 在**每次** React
 * 渲染后都会把 props 逐个赋回元素（`element[prop] = props[prop]`）。对 `value`
 * 它只做了 `_suppressChange = true` 保护，但上游只有 `SliderInput` / `SelectInput`
 * 读这个标记，**`NumericInput` 不读**：它的 `value` setter 走 `_updateValue()`，
 * 只要新值和上一次的值不同就 `emit('change', value)`。
 *
 * 于是「父组件根据服务端数据更新 value」会被当成一次**用户输入**回灌：
 *
 *   点击「保存初始视角」
 *     → 后端回填 presentation.initialCameraFov（例如 47 → 85）
 *     → 面板重渲染，`value` prop 变化
 *     → NumericInput 赋值时 emit('change', 85)
 *     → 宿主的 onChange 当成用户改 FOV
 *     → 再保存一次、再重建一次 Viewer、再弹一个成功框
 *
 * GS-DESKTOP-04 实测：切换历史 SceneVersion 后再保存，一次点击产生 **2 个**
 * PATCH `/presentation`、2 次 Viewer 重建、2 个「已保存」弹窗。
 *
 * 另外，与 `PcuiButton` 同一个坑：`Element.attachElement` 只在首次挂载时绑定
 * `onChange`，之后不再更新 —— 直接写 `onChange={() => setDraft({...draft, x})}`
 * 会永远读到挂载时的 state。
 *
 * ## 做法（不改官方源码，不碰官方内部状态）
 *
 * - 用 ref 保存**最新**的 onChange，并转发到稳定的代理函数；
 * - 记住本次渲染由 props 驱动的值；代理收到与之相同的值时判定为 prop 回显，
 *   不向上转发（真正的用户输入几乎不可能恰好等于当前 props 值，即使相等，
 *   也等价于一次 no-op）。
 */
import { useCallback, useRef } from 'react';
import { NumericInput } from '@playcanvas/pcui/react';

export interface PcuiNumericInputProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  precision?: number;
  step?: number;
  /**
   * 附加 class —— 与 `PcuiButton` 一样，PCUI 的 class 只接受**单个** token
   * （内部走 `classList.add`），需要多个样式时请合成一个类。
   */
  class?: string;
}

export function PcuiNumericInput({
  value,
  onChange,
  min,
  max,
  precision,
  step,
  class: cls,
}: PcuiNumericInputProps) {
  const latest = useRef(onChange);
  latest.current = onChange;
  // 本次渲染由 props 驱动的值。子组件的 componentDidUpdate 在父组件渲染之后
  // 执行，所以回显事件到达时这里已经是新值。
  const driven = useRef(value);
  driven.current = value;
  const stable = useCallback((v: number) => {
    if (v === driven.current) return; // prop 回显，不是用户输入
    latest.current(v);
  }, []);
  return (
    <NumericInput
      value={value}
      min={min}
      max={max}
      precision={precision}
      step={step}
      class={cls}
      onChange={stable}
    />
  );
}
