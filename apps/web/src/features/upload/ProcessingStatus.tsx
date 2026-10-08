import { Alert, Button, Space, Steps, Tag, Typography } from 'antd';
import { Link } from 'react-router-dom';

/**
 * ProcessingStatus — FIX-UPLOAD-01 §15-§16.
 *
 * After POST /complete the UploadPage polls the *read-only* status surface
 * (GET /uploads/{id}/status) and drives this component with REAL server values
 * for three segregated states:
 *
 *   1. UploadSession phase    — QUEUED → VALIDATING → CONVERTING → VERIFYING → PUBLISHING → SUCCEEDED
 *   2. Publish Job           — independent job stage (publish pipeline)
 *   3. Collision Job         — none / queued / running / succeeded / failed
 *
 * No fake progress anywhere: every label is the actual server-side status.  On
 * publish SUCCEEDED the user gets real navigation (Viewer / Authoring / My
 * Works) once the scene identity is known.
 */

const PUBLISH_STAGE_ORDER = [
  { key: 'QUEUED', title: '等待发布' },
  { key: 'VALIDATING', title: '服务端校验' },
  { key: 'CONVERTING', title: '格式转换' },
  { key: 'VERIFYING', title: '资产验证' },
  { key: 'PUBLISHING', title: '发布中' },
];

const UPLOAD_LABELS: Record<string, string> = {
  QUEUED: '等待处理', VALIDATING: '服务端校验', CONVERTING: '格式转换',
  VERIFYING: '资产验证', PUBLISHING: '发布中', SUCCEEDED: '完成', FAILED: '失败',
};

export interface ProcessingStatusProps {
  /** UploadSession.status — the resumable upload phase. */
  uploadStatus: string;
  /** Publish Job status (kind=PUBLISH) — null until the scene is linked. */
  publishStatus: string | null;
  /** Collision Job status (kind=BUILD_COLLISION) — null until auto-built. */
  collisionStatus: string | null;
  /** Publish Job id (for the Steps key / diagnostics). */
  publishJobId: string | null;
  /** Scene identity used for post-success navigation. */
  sceneId: string | null;
  sceneSlug: string | null;
}

function stageIndex(status: string | null, order: { key: string }[]): number {
  if (!status) return -1;
  if (status === 'SUCCEEDED') return order.length;
  if (status === 'FAILED') return -1;
  return order.findIndex((s) => s.key === status);
}

function collisionTag(status: string | null): { text: string; color: string } {
  switch (status) {
    case null:
      return { text: '未生成（尚未构建）', color: 'default' };
    case 'QUEUED':
      return { text: '排队列中', color: 'processing' };
    case 'RUNNING':
      return { text: '构建中', color: 'processing' };
    case 'SUCCEEDED':
      return { text: '已完成', color: 'success' };
    case 'FAILED':
      return { text: '失败', color: 'error' };
    default:
      return { text: status, color: 'default' };
  }
}

function collisionDescription(status: string | null): string {
  switch (status) {
    case null:
      return '模式 OUTDOOR（构建策略默认，非地面真值）尚未生成碰撞资产；上传发布流程会自动触发构建。';
    case 'QUEUED':
      return '碰撞构建任务已进入 CPU 队列。';
    case 'RUNNING':
      return 'splat-transform 正在生成 voxel / mesh 碰撞资产。';
    case 'SUCCEEDED':
      return '碰撞资产已生成（collision.voxel.json / .bin 优先，collision.glb 兜底）。';
    case 'FAILED':
      return '碰撞构建失败，可在「我的作品 → 场景 → 碰撞」中重试；不影响场景发布状态。';
    default:
      return '';
  }
}

export function ProcessingStatus({
  uploadStatus,
  publishStatus,
  collisionStatus,
  publishJobId: _publishJobId,
  sceneId,
  sceneSlug,
}: ProcessingStatusProps) {
  const uploadDone = uploadStatus === 'SUCCEEDED';
  const publishDone = publishStatus === 'SUCCEEDED';
  const publishFailed = publishStatus === 'FAILED';
  const publishIdx = stageIndex(publishStatus, PUBLISH_STAGE_ORDER);

  return (
    <div style={{ marginTop: 16 }}>
      {/* 1 — upload session phase */}
      <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>
        上传任务（UploadSession）
      </Typography.Text>
      <Tag>{UPLOAD_LABELS[uploadStatus] ?? uploadStatus}</Tag>

      {/* 2 — publish pipeline */}
      <Typography.Text strong style={{ display: 'block', margin: '12px 0 4px' }}>
        发布任务（Publish Job）
      </Typography.Text>
      {publishStatus === null ? (
        <Tag>尚未发布</Tag>
      ) : publishFailed ? (
        <Alert
          type="error"
          showIcon
          message="发布失败"
          description="服务端处理上传资产时出错，请重新上传或联系管理员。"
        />
      ) : (
        <Steps
          size="small"
          current={publishIdx >= 0 ? publishIdx : 0}
          items={PUBLISH_STAGE_ORDER.map((s, i) => ({
            title: s.title,
            status:
              i < publishIdx
                ? 'finish'
                : i === publishIdx
                  ? 'process'
                  : 'wait',
          }))}
        />
      )}

      {/* 3 — collision build */}
      <Typography.Text strong style={{ display: 'block', margin: '12px 0 4px' }}>
        碰撞构建（Collision Job）
      </Typography.Text>
      <Space direction="vertical" size={4}>
        <Tag color={collisionTag(collisionStatus).color}>
          {collisionTag(collisionStatus).text}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {collisionDescription(collisionStatus)}
        </Typography.Text>
      </Space>

      {publishDone && (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 16 }}
          message="发布成功"
          description={
            sceneId
              ? `场景 ${sceneSlug ?? sceneId} 已发布，流式 SOG 已就绪。`
              : '作品已发布，可在「我的作品」中查看。'
          }
        />
      )}

      {uploadDone && sceneId && (
        <Space style={{ marginTop: 16 }}>
          <Link to={`/scene/${sceneId}`}>
            <Button type="primary">查看场景</Button>
          </Link>
          <Link to={`/model/edit/${sceneId}`}>
            <Button>进入场景编辑</Button>
          </Link>
          <Link to="/works">
            <Button>返回「我的作品」</Button>
          </Link>
        </Space>
      )}
    </div>
  );
}