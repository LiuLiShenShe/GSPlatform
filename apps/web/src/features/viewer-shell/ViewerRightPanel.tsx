import { App, Button, Descriptions, Space, Tooltip } from 'antd';
import {
  CommentOutlined,
  EyeOutlined,
  InfoCircleOutlined,
  ShareAltOutlined,
  StarOutlined,
} from '@ant-design/icons';
import type { SceneSummary } from '../../fixtures/scenes';

interface ViewerRightPanelProps {
  scene: SceneSummary | undefined;
}

/**
 * Viewer 右侧工具面板：顺序固定为 作者 / 收藏 / 分享 / 问 AI / 详情。
 * 未接入的能力明确禁用并说明阶段，不伪造结果。
 */
export function ViewerRightPanel({ scene }: ViewerRightPanelProps) {
  const { message, modal } = App.useApp();

  const openAuthor = (): void => {
    modal.info({
      title: '作者信息',
      content: scene
        ? `${scene.author} · 已贡献 ${scene.views.toLocaleString()} 次浏览量的场景。`
        : '当前为本地 fixture 场景，无作者数据。Phase 08 将接入真实作者信息。',
    });
  };

  const openDetails = (): void => {
    if (!scene) {
      message.info('当前为本地 fixture 场景，详情将在后端接入后展示。');
      return;
    }
    modal.info({
      title: scene.title,
      content: (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="作者">{scene.author}</Descriptions.Item>
          <Descriptions.Item label="分类">{scene.category}</Descriptions.Item>
          <Descriptions.Item label="高斯点数">
            {scene.splatCount?.toLocaleString() ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="大小">{scene.sizeMB ?? '—'} MB</Descriptions.Item>
          <Descriptions.Item label="浏览">
            {scene.views?.toLocaleString() ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="点赞">
            {scene.likes?.toLocaleString() ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      ),
    });
  };

  const disabled = (feature: string): { onClick: () => void } => ({
    onClick: () => message.info(`${feature}将在 Phase 08 接入，当前为占位交互。`),
  });

  return (
    <aside className="gs-viewer__right-panel" aria-label="场景操作面板">
      <Space orientation="vertical" size={4}>
        <Tooltip title={scene ? `查看 ${scene.author}` : '本地 fixture 作者'}>
          <Button block type="text" icon={<EyeOutlined aria-hidden />} onClick={openAuthor}>
            作者
          </Button>
        </Tooltip>
        <Tooltip title="收藏将在 Phase 08 接入">
          <Button block type="text" icon={<StarOutlined aria-hidden />} {...disabled('收藏')}>
            收藏
          </Button>
        </Tooltip>
        <Tooltip title="分享将在 Phase 08 接入">
          <Button block type="text" icon={<ShareAltOutlined aria-hidden />} {...disabled('分享')}>
            分享
          </Button>
        </Tooltip>
        <Tooltip title="问 AI 将在 Phase 08 接入">
          <Button block type="text" icon={<CommentOutlined aria-hidden />} {...disabled('问 AI')}>
            问 AI
          </Button>
        </Tooltip>
        <Tooltip title="查看场景详情">
          <Button block type="text" icon={<InfoCircleOutlined aria-hidden />} onClick={openDetails}>
            详情
          </Button>
        </Tooltip>
      </Space>
    </aside>
  );
}