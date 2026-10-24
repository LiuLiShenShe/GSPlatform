/**
 * PcuiField —— 创作工作区的「标签 + 官方 PCUI 控件」行。
 *
 * 只负责布局；控件一律来自 `@playcanvas/pcui/react`（官方 PlayCanvas UI）。
 * 不使用 Ant Design 表单控件，保证创作工作区与官方 Studio 视觉/交互一致。
 */
import type { ReactNode } from 'react';

interface Props {
  label: string;
  children: ReactNode;
  hint?: string;
}

export function PcuiField({ label, children, hint }: Props) {
  return (
    <div className="gs-pcui-field">
      <span className="gs-pcui-field__label">{label}</span>
      <div className="gs-pcui-field__control">{children}</div>
      {hint && <span className="gs-pcui-field__hint">{hint}</span>}
    </div>
  );
}
