/**
 * GS-DESKTOP-04 §三/§七 —— PcuiNumericInput 适配层回归测试。
 *
 * 真实浏览器取证（GS-DESKTOP-01 ⑬）发现：PCUI `NumericInput` 的 `value` setter
 * 走 `_updateValue()`，值不同就 `emit('change')`；而 `@playcanvas/pcui/react`
 * 的 `Element.componentDidUpdate` 在每次渲染后都会把 `value` prop 赋回元素。
 * 于是「保存后父组件回填 FOV」会被当成用户输入回灌 —— 一次点击产生两次保存、
 * 两次 Viewer 重建、两个成功弹窗（切换历史版本后必现）。
 *
 * 本测试锁定适配层的契约：
 *   1. prop 驱动的值变化**不得**触发 onChange（回声抑制）；
 *   2. 真实用户输入必须原样转发；
 *   3. 转发的是**最新**的 onChange（不会停留在挂载时的闭包）。
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { PcuiNumericInput } from '../features/authoring/pcui/PcuiNumericInput';

function innerInput(container: HTMLElement): HTMLInputElement {
  const el = container.querySelector('input');
  if (!el) throw new Error('PCUI NumericInput 没有渲染出 input');
  return el as HTMLInputElement;
}

describe('PcuiNumericInput（GS-DESKTOP-04）', () => {
  it('prop 驱动更新（FOV 回填）不触发 onChange', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PcuiNumericInput value={47} onChange={onChange} min={10} max={120} precision={0} step={1} />,
    );
    expect(innerInput(container).value).toBe('47');
    expect(onChange).not.toHaveBeenCalled();

    // 模拟「保存成功 → presentation.initialCameraFov 47 → 85」的一次重渲染。
    rerender(<PcuiNumericInput value={85} onChange={onChange} min={10} max={120} precision={0} step={1} />);
    expect(innerInput(container).value).toBe('85');
    expect(onChange, '父组件回填的值不是用户输入，不能再次保存').not.toHaveBeenCalled();
  });

  it('用户真实输入会转发，且随后 prop 回填不产生回声', () => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PcuiNumericInput value={47} onChange={onChange} min={10} max={120} precision={0} step={1} />,
    );
    const input = innerInput(container);
    fireEvent.change(input, { target: { value: '60' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(60);

    // 保存成功后父组件回填同一个值 —— 不应再触发一次。
    rerender(<PcuiNumericInput value={60} onChange={onChange} min={10} max={120} precision={0} step={1} />);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('总是调用最新的 onChange（不受挂载时闭包影响）', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { container, rerender } = render(
      <PcuiNumericInput value={47} onChange={first} min={10} max={120} precision={0} step={1} />,
    );
    rerender(<PcuiNumericInput value={47} onChange={second} min={10} max={120} precision={0} step={1} />);
    fireEvent.change(innerInput(container), { target: { value: '70' } });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(70);
  });
});
