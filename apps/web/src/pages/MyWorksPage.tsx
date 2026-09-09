import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Segmented, Tabs, Typography } from 'antd';
import { PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { WorkCard } from '../components/WorkCard';
import { EmptyState, ErrorState, LoadingState } from '../components/stateViews';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { fetchMyWorks } from '../services/worksApi';
import type { WorkSummary } from '../fixtures/myWorks';

type LoadState = 'loading' | 'ready' | 'error';

type TabKey = 'all' | WorkSummary['status'];

const STATUS_COUNTS_DEFAULT = { PUBLISHED: 0, DRAFT: 0, PROCESSING: 0, FAILED: 0 };

/**
 * 我的作品页：状态 Tabs + 搜索 + 排序 + 上传入口。
 * 未接后端的操作明确禁用并说明阶段，不伪造成功状态。
 */
export default function MyWorksPage() {
  useDocumentTitle('我的作品');
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [works, setWorks] = useState<WorkSummary[]>([]);
  const [tab, setTab] = useState<TabKey>('all');
  const [keyword, setKeyword] = useState('');
  const [sort, setSort] = useState('updated');
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    fetchMyWorks({ signal: controller.signal })
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
  }, [reloadToken]);

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
    } else {
      // 默认按更新时间倒序，fixture 数组已按更新时间排列
      list = [...list];
    }
    return list;
  }, [works, tab, keyword, sort]);

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
          placeholder="搜索作品标题"
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          aria-label="搜索作品标题"
          style={{ maxWidth: 280 }}
        />
        <Segmented
          options={[
            { label: '按更新时间', value: 'updated' },
            { label: '按标题', value: 'title' },
          ]}
          value={sort}
          onChange={(value) => setSort(String(value))}
          aria-label="作品排序"
        />
      </div>

      <Tabs
        activeKey={tab}
        items={tabItems}
        onChange={(key) => setTab(key as TabKey)}
        destroyOnHidden
      />

      {state === 'loading' && <LoadingState label="正在加载作品列表…" />}
      {state === 'error' && (
        <ErrorState
          title="作品列表加载失败"
          description="本地 fixture 服务暂时不可用，请重试。"
          onRetry={() => setReloadToken((n) => n + 1)}
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
              <WorkCard key={work.id} work={work} />
            ))}
          </div>
        ))}
    </section>
  );
}