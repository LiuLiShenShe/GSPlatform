import { type ReactNode } from 'react';
import { Button, Empty, Result, Spin } from 'antd';

/** 通用加载状态（带 role=status，aria-live 播报）。 */
export function LoadingState({ label = '加载中…' }: { label?: string }) {
  return (
    <div className="gs-state-box" role="status" aria-live="polite">
      <Spin size="large" />
      <span style={{ marginLeft: 12 }}>{label}</span>
    </div>
  );
}

/** 通用空状态：说明原因 + 可选主操作。 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="gs-state-box">
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div>
            <strong>{title}</strong>
            {description && (
              <p style={{ color: 'var(--gs-text-tertiary)', marginBottom: 0 }}>
                {description}
              </p>
            )}
          </div>
        }
      >
        {action}
      </Empty>
    </div>
  );
}

/** 通用错误状态：可重试。 */
export function ErrorState({
  title = '数据加载失败',
  description,
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="gs-state-box">
      <Result
        status="error"
        title={title}
        subTitle={description ?? '请稍后重试，或返回上一页。'}
        extra={
          onRetry && (
            <Button type="primary" onClick={onRetry}>
              重试
            </Button>
          )
        }
      />
    </div>
  );
}