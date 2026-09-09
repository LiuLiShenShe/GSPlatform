import { App, Button, Tag, Tooltip } from 'antd';
import { EyeOutlined, LikeOutlined, StarOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { SceneSummary } from '../fixtures/scenes';

const STATUS_TAG: Record<
  SceneSummary['status'],
  { label: string; color: string } | null
> = {
  READY: null,
  PROCESSING: { label: '处理中', color: 'processing' },
  FAILED: { label: '失败', color: 'error' },
};

interface SceneCardProps {
  scene: SceneSummary;
}

/**
 * 首页场景卡片：Poster + 标题 + 作者 + 统计。
 * 整卡可打开场景（Enter/Space 亦可）；内部按钮不冒泡触发整卡跳转。
 */
export function SceneCard({ scene }: SceneCardProps) {
  const navigate = useNavigate();
  const { message } = App.useApp();

  const openScene = (): void => {
    navigate(`/scene/${scene.id}`);
  };

  const onFavorite = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation();
    message.info('收藏功能将在 Phase 08 接入，当前仅作为占位交互。');
  };

  return (
    <article
      className="gs-scene-card"
      role="link"
      tabIndex={0}
      aria-label={`打开场景 ${scene.title}`}
      onClick={openScene}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openScene();
        }
      }}
    >
      <div className="gs-scene-card__poster">
        <img src={scene.poster} alt={`${scene.title} 封面`} loading="lazy" />
        <span className="gs-scene-card__category">{scene.category}</span>
        <span className="gs-scene-card__status">
          {STATUS_TAG[scene.status] && (
            <Tag color={STATUS_TAG[scene.status]!.color}>
              {STATUS_TAG[scene.status]!.label}
            </Tag>
          )}
        </span>
      </div>
      <div className="gs-scene-card__body">
        <h3 className="gs-scene-card__title">{scene.title}</h3>
        <p className="gs-scene-card__meta">
          {scene.author} · {scene.splatCount.toLocaleString()} 点 · {scene.sizeMB} MB
        </p>
        <div className="gs-scene-card__stats">
          <span>
            <EyeOutlined aria-hidden /> {scene.views.toLocaleString()}
          </span>
          <span>
            <LikeOutlined aria-hidden /> {scene.likes.toLocaleString()}
          </span>
          <Tooltip title="Phase 08 接入收藏">
            <Button
              size="small"
              type="text"
              icon={<StarOutlined />}
              aria-label={`收藏 ${scene.title}`}
              onClick={onFavorite}
            />
          </Tooltip>
        </div>
      </div>
    </article>
  );
}