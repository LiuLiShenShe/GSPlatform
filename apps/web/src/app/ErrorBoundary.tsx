import { Component, type ReactNode } from 'react';
import { Button, Result } from 'antd';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * 全局错误边界：捕获渲染期异常，提供重试与返回首页的恢复操作。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // 仅记录错误信息用于定位，不输出任何敏感数据
    console.error('[ErrorBoundary] 渲染异常:', error.message);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error) {
      return (
        <Result
          status="error"
          title="页面出现异常"
          subTitle="应用已捕获错误。您可以重试，或返回首页。"
          extra={[
            <Button key="retry" type="primary" onClick={this.handleReset}>
              重试
            </Button>,
            <Button
              key="home"
              onClick={() => {
                window.location.href = '/';
              }}
            >
              返回首页
            </Button>,
          ]}
        />
      );
    }
    return this.props.children;
  }
}