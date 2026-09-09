import { type ReactNode } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import ErrorBoundary from './ErrorBoundary';
import { antdTheme } from '../styles/tokens';

interface ProvidersProps {
  children: ReactNode;
}

/**
 * 全局提供器：错误边界 + Ant Design 主题 + App 上下文。
 * 路由（RouterProvider）由上层注入，便于测试复用。
 */
export function Providers({ children }: ProvidersProps) {
  return (
    <ErrorBoundary>
      <ConfigProvider theme={antdTheme} locale={zhCN}>
        <AntdApp>{children}</AntdApp>
      </ConfigProvider>
    </ErrorBoundary>
  );
}