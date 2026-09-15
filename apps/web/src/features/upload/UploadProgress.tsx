import { Progress, Space, Typography } from 'antd';

/**
 * UploadProgress — displays real bytes sent vs total, speed, and a pause/resume button.
 */
export interface UploadProgressProps {
  sent: number;
  total: number;
  speed: number;        // bytes per second
  status: string;       // CREATED | UPLOADING | UPLOADED | QUEUED | ...
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function UploadProgress({
  sent,
  total,
  speed,
  status,
  paused,
  onPause,
  onResume,
}: UploadProgressProps) {
  const percent = total > 0 ? Math.round((sent / total) * 100) : 0;
  const statusLabel: Record<string, string> = {
    CREATED: '准备中',
    UPLOADING: '上传中',
    UPLOADED: '等待服务端处理',
    QUEUED: '已入队',
  };
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Typography.Text type="secondary">
        {statusLabel[status] ?? status}
      </Typography.Text>
      <Progress
        percent={percent}
        status={paused ? 'exception' : undefined}
        format={() =>
          `${formatBytes(sent)} / ${formatBytes(total)}  ${formatSpeed(speed)}`
        }
      />
      <Space>
        {paused ? (
          <Typography.Link onClick={onResume} aria-label="继续上传">
            ▶ 继续
          </Typography.Link>
        ) : (
          <Typography.Link onClick={onPause} aria-label="暂停上传">
            ⏸ 暂停
          </Typography.Link>
        )}
      </Space>
    </Space>
  );
}
