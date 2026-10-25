/**
 * PcuiButton —— 官方 PCUI Button 的「最新闭包」适配层。
 *
 * ## 为什么需要它
 *
 * `@playcanvas/pcui/react` 6.1.4 的 `Element.attachElement` 只在**首次挂载**时
 * 执行一次 `element.on('click', this.onClick)`；后续 `componentDidUpdate` 只同步
 * 可写属性（text / enabled / class …），**不会**重新绑定 onClick。因此直接写
 *
 *     <Button onClick={() => props.onSave(...)} />
 *
 * 的事件处理器会永远停在挂载时的闭包上 —— 例如挂载时 `viewerReady === false`，
 * 之后即使界面已显示「Viewer 就绪」，点击保存仍会读到 false 并报「Viewer 未就绪」；
 * 切换选中的标注后，保存/删除也会指向旧标注 id。
 *
 * 本组件把点击转发给一个稳定的代理函数，代理在每次 render 时更新为**最新**的
 * onClick，从而与 React 的常规语义一致。这是宿主适配层，不修改官方 PCUI 源码。
 */
import { useCallback, useRef } from 'react';
import { Button } from '@playcanvas/pcui/react';

export interface PcuiButtonProps {
  text: string;
  onClick: () => void;
  enabled?: boolean;
  /**
   * 附加 class —— **只能是一个 token**。PCUI 的 Element 内部对 class 走
   * `classList.add(token)`，传 `"a b"` 会在挂载时抛 InvalidCharacterError
   * 并把整个页面炸成错误边界（GS-DESKTOP-04 实测）。需要多个样式时合成一个类。
   */
  class?: string;
}

export function PcuiButton({ text, onClick, enabled, class: cls }: PcuiButtonProps) {
  const latest = useRef(onClick);
  latest.current = onClick;
  const stable = useCallback(() => {
    latest.current();
  }, []);
  // 注意：`enabled` 必须显式传布尔值。`@playcanvas/pcui/react` 6.1.4 会把
  // `enabled={undefined}` 落到元素上变成 `enabled = undefined`，PCUI 视其为
  // 禁用并加上 `pcui-disabled`（实测：所有用默认值的按钮都点不动）。
  return <Button text={text} enabled={enabled ?? true} class={cls} onClick={stable} />;
}
