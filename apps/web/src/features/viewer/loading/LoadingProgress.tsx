/**
 * LoadingProgress — the 0~100% progress bar driven ONLY by real load events.
 *
 * There is intentionally no way to fabricate a percentage here: the component
 * just renders whatever the parent computed from byte/decoded/applied/firstFrame
 * events. When the parent has no Content-Length it renders an indeterminate
 * spinner + bytes instead of an invented number.
 */

import { LoadingOutlined } from '@ant-design/icons';
import { Progress } from 'antd';

interface LoadingProgressProps {
  /** 0..100 real progress, or null while indeterminate. */
  percent: number | null;
  /** bytes read for the current LOD. */
  loadedBytes: number;
  /** total bytes when known. */
  totalBytes: number | null;
  /** rendered from loadedBytes/totalBytes. */
}

function formatBytes(n: number): string {
  if (n < 1_048_576) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

export function LoadingProgress({ percent, loadedBytes, totalBytes }: LoadingProgressProps) {
  if (percent === null) {
    return (
      <div className="gs-viewer__loading-progress" data-testid="loading-progress">
        <LoadingOutlined spin aria-hidden />
        <span>正在加载… {formatBytes(loadedBytes)}</span>
      </div>
    );
  }

  return (
    <div className="gs-viewer__loading-progress" data-testid="loading-progress">
      <Progress
        percent={percent}
        showInfo
        size={[300, 8]}
        strokeColor="#3E5BDB"
        className="gs-viewer__loading-bar"
      />
      <div className="gs-viewer__loading-bytes" data-testid="loading-bytes">
        已下载 {formatBytes(loadedBytes)}
        {totalBytes != null && ` / ${formatBytes(totalBytes)}`}
      </div>
    </div>
  );
}
