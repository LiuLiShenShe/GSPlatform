import { App, Button, Popconfirm, Progress, Tag, Tooltip } from 'antd';
import { DeleteOutlined, EditOutlined, EyeOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { WorkSummary } from '../fixtures/myWorks';

const STATUS_META: Record<
  WorkSummary['status'],
  { label: string; color: string }
> = {
  PUBLISHED: { label: '已发布', color: 'success' },
  DRAFT: { label: '草稿', color: 'default' },
  PROCESSING: { label: '处理中', color: 'processing' },
  FAILED: { label: '失败', color: 'error' },
};

interface WorkCardProps {
  work: WorkSummary;
}

/**
 * 我的作品卡片：区分草稿 / 处理中（真实 43% 进度）/ 已发布 / 失败。
 * 查看跳转到 Viewer；编辑与删除在本阶段明确为占位，不伪造成功。
 */
export function WorkCard({ work }: WorkCardProps) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const meta = STATUS_META[work.status];

  const openScene = (): void => {
    if (work.sceneId) {
      navigate(`/scene/${work.sceneId}`);
    } else {
      message.info('当前状态下无已发布场景可查看（fixture 数据）。');
    }
  };

  return (
    <div className="gs-works-card" data-testid={`works-card-${work.id}`}>
      <button
        type="button"
        className="gs-works-card__poster"
        aria-label={`查看 ${work.title}`}
        onClick={openScene}
      >
        <img src={work.poster} alt={`${work.title} 封面`} />
      </button>
      <div className="gs-works-card__main">
        <Tooltip title={work.sceneId ? '打开 Viewer' : '无已发布场景'}>
          <h3 className="gs-works-card__title">
            {work.status === 'PROCESSING' && work.progress != null && (
              <>
                真实任务进度 {work.progress}% ·{' '}
              </>
            )}
            {work.title}
          </h3>
        </Tooltip>
        <p className="gs-works-card__meta">
          <Tag color={meta.color}>{meta.label}</Tag>
          更新于 {work.updatedAt}
        </p>
        {work.status === 'PROCESSING' && work.progress != null && (
          <Progress
            percent={work.progress}
            size="small"
            status="active"
            aria-label="处理进度"
          />
        )}
        <div className="gs-works-card__actions">
          <Button size="small" icon={<EyeOutlined aria-hidden />} onClick={openScene}>
            查看
          </Button>
          <Tooltip title="编辑功能将在 Phase 08 接入">
            <span>
              <Button size="small" icon={<EditOutlined aria-hidden />} disabled>
                编辑
              </Button>
            </span>
          </Tooltip>
          <Popconfirm
            title={`确认删除「${work.title}」？`}
            description="本阶段仅弹窗确认，不会真实删除。Phase 08 将接入服务端删除。"
            okText="确认删除"
            cancelText="取消"
            onConfirm={() =>
              message.info(
                `已记录删除「${work.title}」的确认意图（Phase 08 接入真实删除）`,
              )
            }
          >
            <Button size="small" danger icon={<DeleteOutlined aria-hidden />}>
              删除
            </Button>
          </Popconfirm>
        </div>
      </div>
    </div>
  );
}