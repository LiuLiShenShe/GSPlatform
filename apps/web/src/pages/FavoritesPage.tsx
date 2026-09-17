import { useCallback, useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import { StarOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../components/stateViews';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { fetchFavorites, type FavoriteSceneSummary } from '../services/favoritesApi';
import { useAuthStore } from '../stores/authStore';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * 我的收藏页（/favorites）。
 * 需要真实会话；匿名访问由 401 拦截器引导登录。
 */
export default function FavoritesPage() {
  useDocumentTitle('我的收藏');
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const [state, setState] = useState<LoadState>('loading');
  const [items, setItems] = useState<FavoriteSceneSummary[]>([]);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(() => {
    const controller = new AbortController();
    setState('loading');
    fetchFavorites(controller.signal)
      .then((data) => {
        setItems(data);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error('加载收藏失败:', error);
          setState('error');
        }
      });
    return controller;
  }, []);

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
  }, [load, reloadToken]);

  return (
    <section aria-label="我的收藏">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Typography.Title level={4} style={{ margin: 0 }}>
          我的收藏
        </Typography.Title>
        <Button onClick={() => navigate('/')}>浏览更多场景</Button>
      </div>

      {state === 'loading' && <LoadingState label="正在加载收藏…" />}
      {state === 'error' && (
        <ErrorState
          title="收藏列表加载失败"
          description="服务暂时不可用，请重试。"
          onRetry={() => setReloadToken((n) => n + 1)}
        />
      )}
      {state === 'ready' &&
        (items.length === 0 ? (
          <EmptyState
            title={user ? '还没有收藏任何场景' : '请先登录'}
            description={
              user
                ? '在场景页点击「收藏」即可加入这里。'
                : '登录后可以收藏场景，收藏会显示在这里。'
            }
            action={
              <Button type="primary" icon={<StarOutlined aria-hidden />} onClick={() => navigate('/')}>
                去逛逛
              </Button>
            }
          />
        ) : (
          <div className="gs-works-grid">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="gs-fav-card"
                onClick={() => navigate(`/scene/${encodeURIComponent(item.id)}`)}
                aria-label={`查看 ${item.title}`}
              >
                <img src={item.posterUrl ?? undefined} alt={`${item.title} 封面`} />
                <div className="gs-fav-card__title">{item.title}</div>
                {item.authorName && (
                  <div className="gs-fav-card__author">{item.authorName}</div>
                )}
              </button>
            ))}
          </div>
        ))}
    </section>
  );
}
