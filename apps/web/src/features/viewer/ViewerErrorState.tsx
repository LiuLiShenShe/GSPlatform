import { HomeOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Result } from 'antd';
import type { ViewerErrorCode } from '@gsplatform/viewer';
import { codeToUserMessage } from '@gsplatform/viewer';

interface ViewerErrorStateProps {
  errorCode: ViewerErrorCode | null;
  message: string | null;
  onRetry: () => void;
  onBack: () => void;
}

/**
 * 可恢复错误状态：按错误分类显示用户可理解的消息，
 * 允许重试或返回首页。开发诊断保留在 errorCode / message 中。
 */
export function ViewerErrorState({ errorCode, message, onRetry, onBack }: ViewerErrorStateProps) {
  const code = errorCode as ViewerErrorCode | null;
  const title = code ? codeToUserMessage(code) : codeToUserMessage('UNKNOWN');

  return (
    <div className="gs-viewer__overlay" data-testid="viewer-error" role="alert">
      <Result
        status="error"
        title={title}
        subTitle={
          <span className="gs-viewer__error-detail">
            {message ?? codeToUserMessage('UNKNOWN')}
            {code ? `（错误码 ${code}）` : ''}
          </span>
        }
        extra={[
          <Button
            key="retry"
            type="primary"
            icon={<ReloadOutlined aria-hidden />}
            onClick={onRetry}
          >
            重试
          </Button>,
          <Button
            key="back"
            icon={<HomeOutlined aria-hidden />}
            onClick={onBack}
          >
            返回首页
          </Button>,
        ]}
      />
    </div>
  );
}