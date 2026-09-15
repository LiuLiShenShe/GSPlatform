import { Alert, Steps } from 'antd';

/**
 * ProcessingStatus — real server-side processing stage after upload completes.
 * After the POST /complete, poll HEAD /uploads/{id} for status, or use the
 * initial complete response's jobId. This component shows the current pipeline
 * stage without faking progress.
 */

export interface ProcessingStatusProps {
  status: string;       // QUEUED | VALIDATING | CONVERTING | VERIFYING | PUBLISHING | SUCCEEDED | FAILED
  jobId: string | null;
}

const STAGE_ORDER = [
  { key: 'QUEUED',     title: '等待处理' },
  { key: 'VALIDATING', title: '服务端校验' },
  { key: 'CONVERTING', title: '格式转换' },
  { key: 'VERIFYING',  title: '资产验证' },
  { key: 'PUBLISHING', title: '发布中' },
];

function stageIndex(status: string): number {
  if (status === 'SUCCEEDED') return STAGE_ORDER.length;
  if (status === 'FAILED') return -1;
  return STAGE_ORDER.findIndex((s) => s.key === status);
}

export function ProcessingStatus({ status, jobId: _jobId }: ProcessingStatusProps) {
  void _jobId;
  const idx = stageIndex(status);

  if (status === 'FAILED') {
    return (
      <Alert
        type="error"
        showIcon
        message="处理失败"
        description="服务端处理上传资产时出错，请重新上传或联系管理员。"
      />
    );
  }

  if (status === 'SUCCEEDED') {
    return (
      <Alert
        type="success"
        showIcon
        message="发布成功"
        description="作品已发布，可在「我的作品」中查看。"
      />
    );
  }

  return (
    <Steps
      size="small"
      current={idx >= 0 ? idx : 0}
      items={STAGE_ORDER.map((s, i) => ({
        title: s.title,
        status:
          i < idx
            ? 'finish'
            : i === idx
              ? 'process'
              : 'wait',
      }))}
      style={{ marginTop: 16 }}
    />
  );
}
