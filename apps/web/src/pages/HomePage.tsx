import { useEffect, useMemo, useState } from 'react';
import { Button, Segmented, Typography } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { SceneCard } from '../components/SceneCard';
import { EmptyState, ErrorState, LoadingState } from '../components/stateViews';
import { useDocumentTitle, useResponsiveColumns } from '../hooks/useBreakpoints';
import { fetchSceneList } from '../services/sceneApi';
import { useUiStore } from '../stores/uiStore';
import type { SceneSummary } from '../fixtures/scenes';

type LoadState = 'loading' | 'ready' | 'error';
type SortMode = 'popular' | 'latest' | 'featured';

/**
 * 首页：顶部分类与搜索由 TopBar 控制，本页负责 5 列 SceneCard 网格、排序与状态渲染。
 */
export default function HomePage() {
  useDocumentTitle('首页');
  const columns = useResponsiveColumns();
  const homeCategory = useUiStore((s) => s.homeCategory);
  const [searchParams, setSearchParams] = useSearchParams();
  const keyword = (searchParams.get('q') ?? '').trim();

  const [state, setState] = useState<LoadState>('loading');
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [sort, setSort] = useState<SortMode>('popular');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetchSceneList({ signal: controller.signal })
      .then((data) => {
        setScenes(data);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error('加载场景失败:', error);
          setState('error');
        }
      });
    // 页面离开（路由切换）时取消进行中的请求。
    return () => controller.abort();
  }, [reloadToken]);

  const visible = useMemo(() => {
    let list = scenes;
    if (homeCategory !== '发现') {
      list = list.filter((scene) => scene.category === homeCategory);
    }
    if (keyword) {
      const lower = keyword.toLowerCase();
      list = list.filter(
        (scene) =>
          scene.title.toLowerCase().includes(lower) ||
          scene.author.toLowerCase().includes(lower),
      );
    }
    if (sort === 'latest') {
      list = [...list].reverse();
    } else if (sort === 'featured') {
      list = [...list].sort((a, b) => b.likes - a.likes);
    }
    return list;
  }, [scenes, homeCategory, keyword, sort]);

  const clearSearch = (): void => {
    setSearchParams({});
  };

  return (
    <section aria-label="场景列表">
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
          热门作品
        </Typography.Title>
        <Segmented
          options={[
            { label: '热门', value: 'popular' },
            { label: '最新', value: 'latest' },
            { label: '精选', value: 'featured' },
          ]}
          value={sort}
          onChange={(value) => setSort(value as SortMode)}
          aria-label="作品排序"
        />
      </div>

      {state === 'loading' && <LoadingState label="正在加载场景…" />}
      {state === 'error' && (
        <ErrorState
          title="场景加载失败"
          description="本地 fixture 服务暂时不可用，请重试。"
          onRetry={() => setReloadToken((n) => n + 1)}
        />
      )}
      {state === 'ready' &&
        (visible.length === 0 ? (
          <EmptyState
            title={keyword ? `没有匹配「${keyword}」的场景` : '没有符合条件的场景'}
            description="换个关键词，或清空搜索条件后重试。"
            action={
              <Button type="primary" onClick={clearSearch}>
                清空搜索条件
              </Button>
            }
          />
        ) : (
          <div
            className="gs-scene-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            }}
            data-testid="scene-grid"
            data-columns={columns}
          >
            {visible.map((scene) => (
              <SceneCard key={scene.id} scene={scene} />
            ))}
          </div>
        ))}
    </section>
  );
}