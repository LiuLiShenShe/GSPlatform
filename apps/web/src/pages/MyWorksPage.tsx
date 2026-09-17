import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Input, Segmented, Tabs, Typography } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { WorkCard } from '../components/WorkCard';
import { EmptyState, ErrorState, LoadingState } from '../components/stateViews';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { fetchMyWorks } from '../services/worksApi';
import type { WorkSummary } from '../fixtures/myWorks';

type LoadState = 'loading' | 'ready' | 'error';

type TabKey = 'all' | WorkSummary['status'];

const STATUS_COUNTS_DEFAULT = { PUBLISHED: 0, DRAFT: 0, PROCESSING: 0, FAILED: 0 };

function toTabKey(value: string): TabKey {
  if (value === 'PUBLISHED' || value === 'DRAFT' || value === 'PROCESSING' || value === 'FAILED') {
    return value;
  }
  return 'all';
}

/**
 * 我的作品页：状态 Tabs + 搜索 + 排序 + 上传入口。
 * Phase 08：搜索/排序由服务端执行（?q &sort 同步到 URL），
 * 卡片上的编辑/归档/删除/任务查看均对接真实后端。
 */
export default function MyWorksPage() {
  useDocumentTitle('我的作品');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const sortParam = searchParams.get('sort') ?? 'updated';
  const tabParam = toTabKey(searchParams.get('status') ?? 'all');

  const [state, setState] = useState<LoadState>('loading');
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [tab, setTab] = useState<TabKey>(tabParam);
  const [keyword, setKeyword] = useState(q);
  const [sort, setSort] = useState(sortParam);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetchMyWorks({
      signal: controller.signal,
      search: q || undefined,
      sort: sortParam === 'title' ? 'title' : 'updated',
    })
      .then((data) => {
        setWorks(data);
        setState('ready');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error('加载我的作品失败:', error);
          setState('error');
        }
      });
    return () => controller.abort();
  }, [reloadToken, q, sortParam]);

  const counts = useMemo(() => {
    const map = { ...STATUS_COUNTS_DEFAULT };
    for (const work of works) {
      map[work.status] += 1;
    }
    return map;
  }, [works]);

  const filtered = useMemo(() => {
    let list = works;
    if (tab !== 'all') {
      list = list.filter((w) => w.status === tab);
    }
    if (keyword.trim()) {
      const lower = keyword.trim().toLowerCase();
      list = list.filter((w) => w.title.toLowerCase().includes(lower));
    }
    if (sort === 'title') {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [works, tab, keyword, sort]);

  // 本地关键词与 URL q 分离：本地输入即时过滤，Enter 提交才同步到 URL。
  const submitKeyword = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    if (keyword.trim()) {
      params.set('q', keyword.trim());
    } else {
      params.delete('q');
    }
    setSearchParams(params, { replace: true });
  }, [keyword, searchParams, setSearchParams]);

  const onTabChange = useCallback(
    (key: string) => {
      setTab(toTabKey(key));
      const params = new URLSearchParams(searchParams);
      if (key === 'all') params.delete('status');
      else params.set('status', key);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const onSortChange = useCallback(
    (value: string) => {
      setSort(value);
      const params = new URLSearchParams(searchParams);
      if (value === 'updated') params.delete('sort');
      else params.set('sort', value);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const tabItems = [
    { key: 'all', label: `全部 ${works.length}` },
    { key: 'DRAFT', label: `草稿 ${counts.DRAFT}` },
    { key: 'PROCESSING', label: `处理中 ${counts.PROCESSING}` },
    { key: 'PUBLISHED', label: `已发布 ${counts.PUBLISHED}` },
    { key: 'FAILED', label: `失败 ${counts.FAILED}` },
  ];

  return (
    <section aria-label="我的作品">
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
          我的作品
        </Typography.Title>
        <Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={() => navigate('/upload')}>
          上传作品
        </Button>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        <Input
          prefix={<SearchOutlined aria-hidden />}
          placeholder="搜索作品标题（服务端匹配）"
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          onPressEnter={submitKeyword}
          onBlur={submitKeyword}
          aria-label="搜索作品标题（服务端匹配）"
          style={{ maxWidth: 280 }}
        />
        <Segmented
          options={[
            { label: '按更新时间', value: 'updated' },
            { label: '按标题', value: 'title' },
          ]}
          value={sort}
          onChange={(value) => onSortChange(String(value))}
          aria-label="作品排序"
        />
      </div>

      <Tabs
        activeKey={tab}
        items={tabItems}
        onChange={onTabChange}
        destroyOnHidden
      />

      {state === 'loading' && <LoadingState label="正在加载作品列表…" />}
      {state === 'error' && (
        <ErrorState
          title="作品列表加载失败"
          description="服务暂时不可用，请重试。"
          onRetry={reload}
        />
      )}
      {state === 'ready' &&
        (filtered.length === 0 ? (
          <EmptyState
            title="当前筛选条件下没有作品"
            description="切换状态分类，或上传新作品。"
            action={
              <Button type="primary" onClick={() => navigate('/upload')}>
                上传作品
              </Button>
            }
          />
        ) : (
          <div className="gs-works-grid">
            {filtered.map((work) => (
              <WorkCard key={work.id} work={work} onChanged={reload} />
            ))}
          </div>
        ))}
    </section>
  );
}