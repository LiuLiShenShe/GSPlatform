import { App, Button, Tag, Tooltip } from 'antd';
import { EyeOutlined, LikeOutlined, StarFilled, StarOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { SceneSummary } from '../fixtures/scenes';
import { addFavorite, removeFavorite } from '../services/favoritesApi';
import { useAuthStore } from '../stores/authStore';

const STATUS_TAG: Record<
  SceneSummary['status'],
  { label: string; color: string } | null
> = {
  READY: null,
  PUBLISHED: null,
  PROCESSING: { label: '处理中', color: 'processing' },
  FAILED: { label: '失败', color: 'error' },
};

interface SceneCardProps {
  scene: SceneSummary;
  isFavorited?: boolean;
  onFavoritedChange?: (sceneId: string, favorited: boolean) => void;
}

/**
 * 首页场景卡片：Poster + 标题 + 作者 + 统计。
 * Phase 08：收藏按钮对接真实后端（乐观更新 + 回滚）。
 */
export function SceneCard({
  scene,
  isFavorited = false,
  onFavoritedChange,
}: SceneCardProps) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const user = useAuthStore((s) => s.user);

  const openScene = (): void => {
    navigate(`/scene/${scene.id}`);
  };

  const onFavorite = async (event: { stopPropagation: () => void }): Promise<void> => {
    event.stopPropagation();
    if (!user) {
      message.warning('收藏需要登录，请先登录。');
      navigate(`/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
    const target = !isFavorited;
    onFavoritedChange?.(scene.id, target); // 乐观更新
    try {
      if (target) {
        await addFavorite(scene.id);
      } else {
        await removeFavorite(scene.id);
      }
    } catch {
      onFavoritedChange?.(scene.id, !target); // 回滚
      message.error('收藏操作失败，请稍后重试。');
    }
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
          <Tooltip title={isFavorited ? '取消收藏' : '收藏'}>
            <Button
              size="small"
              type="text"
              icon={isFavorited ? <StarFilled aria-hidden /> : <StarOutlined aria-hidden />}
              aria-label={isFavorited ? `取消收藏 ${scene.title}` : `收藏 ${scene.title}`}
              onClick={onFavorite}
            />
          </Tooltip>
        </div>
      </div>
    </article>
  );
}