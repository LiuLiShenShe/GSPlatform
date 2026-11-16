import { useEffect, useState } from 'react';
import { App, Button, Card, Input, Pagination, Segmented, Select, Space, Tag, Typography } from 'antd';
import { DeploymentUnitOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Link, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, LoadingState } from '../components/stateViews';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { downloadMeshModel, fetchMeshModels, type MeshModelsList } from '../services/meshModelsApi';
import { toApiError } from '../services/http';

export default function MeshModelsPage() {
  useDocumentTitle('Mesh 模型');
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const algorithm = params.get('algorithm') ?? '';
  const sort = params.get('sort') === 'title' ? 'title' : 'created';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [keyword, setKeyword] = useState(query);
  const [result, setResult] = useState<MeshModelsList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [downloading, setDownloading] = useState<string | null>(null);
  useEffect(() => { setKeyword(query); }, [query]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError(null);
    void fetchMeshModels({ q: query || undefined, algorithm: algorithm || undefined, sort, page }, abort.signal)
      .then(data => { if (!abort.signal.aborted) setResult(data); })
      .catch(reason => { if (!abort.signal.aborted) setError(toApiError(reason).message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [query, algorithm, sort, page, reload]);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next);
  };
  return <section aria-label="Mesh 模型">
    <Space style={{ width: '100%', justifyContent: 'space-between', marginBottom: 12 }} wrap>
      <Typography.Title level={4} style={{ margin: 0 }}>Mesh 模型</Typography.Title>
      <Button icon={<ReloadOutlined />} onClick={() => setReload(n => n + 1)}>刷新列表</Button>
    </Space>
    <Typography.Paragraph type="secondary">高斯重建完成后，先完成尺度标定；可继续清理并保存。确认模型后手动生成 Mesh，完成的模型会自动出现在这里。</Typography.Paragraph>
    <Space wrap style={{ marginBottom: 20 }}>
      <Input aria-label="搜索 Mesh 模型" placeholder="搜索模型或来源作品" prefix={<SearchOutlined />} allowClear
        value={keyword} onChange={e => setKeyword(e.target.value)} onPressEnter={() => change('q', keyword.trim())}
        onBlur={() => { if (keyword.trim() !== query) change('q', keyword.trim()); }} style={{ width: 280 }} />
      <Select aria-label="网格算法" value={algorithm} onChange={v => change('algorithm', v)} style={{ width: 180 }}
        options={[{ value: '', label: '全部算法' }, { value: 'nksr', label: '3DGS → NKSR' }, { value: '2dgs-tsdf', label: '2DGS → TSDF' }]} />
      <Segmented aria-label="Mesh 排序" value={sort} onChange={v => change('sort', String(v))}
        options={[{ label: '按完成时间', value: 'created' }, { label: '按标题', value: 'title' }]} />
    </Space>
    {loading ? <LoadingState label="正在加载 Mesh 模型…" /> : error ? <ErrorState title="Mesh 模型加载失败" description={error} onRetry={() => setReload(n => n + 1)} />
      : !result?.items.length ? <EmptyState title="暂无完成的 Mesh 模型" description="在我的作品中打开高斯模型，确认并生成 Mesh；完成后即可在这里查看。"
        action={<Link to="/works"><Button type="primary">前往我的作品</Button></Link>} /> : <>
        <div className="gs-works-grid">{result.items.map(model => <Card key={model.id} className="gs-mesh-card"
          cover={<Link to={model.previewUrl} aria-label={`预览 ${model.title}`} className="gs-mesh-card__cover"><DeploymentUnitOutlined /><span>{model.algorithm === 'nksr' ? 'NKSR' : '2DGS TSDF'}</span></Link>}>
          <Typography.Title level={5} ellipsis={{ tooltip: model.title }} style={{ marginTop: 0 }}>{model.title}</Typography.Title>
          <Space wrap><Tag color="success">已完成 PLY</Tag><Tag color={model.glbStatus==='READY'?'success':undefined}>{model.glbStatus==='READY'?'GLB 可用':model.glbStatus==='RUNNING'||model.glbStatus==='QUEUED'?'GLB 转换中':model.glbStatus==='FAILED'?'GLB 转换失败':'GLB 待生成'}</Tag><Tag>{model.units === 'm' ? '米制' : '未标定尺度'}</Tag>
            {!model.isCurrentSource && <Tag>历史版本</Tag>}</Space>
          <Typography.Paragraph style={{ marginTop: 12, marginBottom: 4 }}>{model.faces.toLocaleString()} 三角面 · {model.vertices.toLocaleString()} 顶点</Typography.Paragraph>
          <Typography.Paragraph type="secondary">{(model.sizeBytes / 1048576).toFixed(1)} MB · {new Date(model.createdAt).toLocaleString()}</Typography.Paragraph>
          <Typography.Paragraph ellipsis>来源：{model.sceneTitle}</Typography.Paragraph>
          <Space wrap>
            <Link to={model.previewUrl}><Button type="primary">查看模型</Button></Link>
            <Button loading={downloading === model.id} onClick={() => { setDownloading(model.id); void downloadMeshModel(model)
              .catch(reason => { void message.error(toApiError(reason).message); }).finally(() => setDownloading(null)); }}>下载 PLY</Button>
            <Link to={`/model/edit/${encodeURIComponent(model.sceneSlug)}?workspace=mesh`}>来源高斯</Link>
          </Space>
        </Card>)}</div>
        <Pagination current={page} pageSize={24} total={result.total} showSizeChanger={false}
          onChange={n => change('page', String(n))} style={{ marginTop: 24 }} />
      </>}
  </section>;
}
