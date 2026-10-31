import { App, Button, Tag, Tooltip } from 'antd';
import { EyeOutlined, LikeOutlined, StarFilled, StarOutlined, VideoCameraOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { SceneSummary } from '../fixtures/scenes';
import { formatOriginalFormat, formatUploadTime } from '../utils/provenance';
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

  const uploadTime = formatUploadTime(scene.uploadedAt);
  const originalFormat = formatOriginalFormat(scene.originalFormat);

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
        {/* GS-UI-01：真实上传元数据浮层 —— 无记录时整体隐藏，不伪造值。
            上传时间右上角、原始格式右下角；与左上分类/左下状态互不重叠。 */}
        {(uploadTime || originalFormat) && (
          <>
            {uploadTime && (
              <span
                className="gs-scene-card__upload-time"
                data-testid={`scene-upload-time-${scene.id}`}
              >
                {uploadTime}
              </span>
            )}
            {originalFormat && (
              <span
                className="gs-scene-card__format"
                data-testid={`scene-format-${scene.id}`}
              >
                {originalFormat}
              </span>
            )}
          </>
        )}
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
          <span className="gs-scene-card__actions">
            <Tooltip title={isFavorited ? '取消收藏' : '收藏'}>
              <Button
                size="small"
                type="text"
                icon={isFavorited ? <StarFilled aria-hidden /> : <StarOutlined aria-hidden />}
                aria-label={isFavorited ? `取消收藏 ${scene.title}` : `收藏 ${scene.title}`}
                onClick={onFavorite}
              />
            </Tooltip>
            {/* GS-UI-01 后续：每个场景的「VR 版」入口 —— 与网页版卡片并列，
                点击进 /xr/:sceneId（VR 模式页，页内「进入 VR」按钮触发沉浸会话）。
                卡片主体仍进网页版 /scene/:id；此按钮 stopPropagation 不触发卡片跳转。
                注意：VR 模式需要头显浏览器 + HTTPS/安全上下文（WebXR 硬条件）。 */}
            <Tooltip title="以 VR 模式打开（需支持 WebXR 的头显浏览器，localhost 或 HTTPS）">
              <Button
                size="small"
                type="text"
                icon={<VideoCameraOutlined aria-hidden />}
                aria-label={`以 VR 模式打开 ${scene.title}`}
                data-testid={`scene-vr-${scene.id}`}
                onClick={(event) => {
                  event.stopPropagation();
                  navigate(`/xr/${scene.id}`);
                }}
              >
                VR版
              </Button>
            </Tooltip>
          </span>
        </div>
      </div>
    </article>
  );
}