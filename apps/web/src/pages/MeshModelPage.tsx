import { useEffect, useState } from 'react';
import { App, Alert, Button, Descriptions, Space, Tag, Typography } from 'antd';
import { Link, useParams } from 'react-router-dom';
import { ErrorState, LoadingState } from '../components/stateViews';
import { MeshGlbPanel } from '../components/MeshGlbPanel';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { downloadMeshModel, fetchMeshModel, type MeshModel } from '../services/meshModelsApi';
import { toApiError } from '../services/http';

export default function MeshModelPage() {
  const { modelId = '' } = useParams();
  useDocumentTitle('Mesh 模型预览');
  const { message } = App.useApp();
  const [model, setModel] = useState<MeshModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    const abort = new AbortController(); setModel(null); setError(null);
    void fetchMeshModel(modelId, abort.signal).then(value => { if (!abort.signal.aborted) setModel(value); })
      .catch(reason => { if (!abort.signal.aborted) setError(toApiError(reason).message); });
    return () => abort.abort();
  }, [modelId, retry]);
  if (error) return <ErrorState title="Mesh 模型加载失败" description={error} onRetry={() => setRetry(n => n + 1)} />;
  if (!model) return <LoadingState label="正在加载 Mesh 模型…" />;
  return <section aria-label="Mesh 模型详情">
    <Space wrap style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
      <Typography.Title level={4} style={{ margin: 0 }}>{model.title}</Typography.Title>
      <Space><Link to="/meshes"><Button>返回 Mesh 模型</Button></Link>
        <Button type="primary" loading={downloading} onClick={() => { setDownloading(true); void downloadMeshModel(model)
          .catch(reason => { void message.error(toApiError(reason).message); }).finally(() => setDownloading(false)); }}>下载完整 PLY</Button></Space>
    </Space>
    {model.units === 'scene' && <Alert type="info" title="此模型尚未标定真实尺寸，坐标单位为重建单位。" style={{ marginBottom: 12 }} />}
    {!model.isCurrentSource && <Alert type="info" title="这是历史版本生成的独立 Mesh，来源高斯已有新版本。" style={{ marginBottom: 12 }} />}
    <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginBottom: 16 }} items={[
      { key: 'algorithm', label: '算法', children: <Tag>{model.algorithm === 'nksr' ? '3DGS → NKSR' : '2DGS → 原生 TSDF'}</Tag> },
      { key: 'source', label: '来源高斯', children: <Link to={`/model/edit/${encodeURIComponent(model.sceneSlug)}?workspace=mesh`}>{model.sceneTitle}</Link> },
      { key: 'units', label: '单位', children: model.units === 'm' ? '米（m）' : '重建单位（未标定）' },
      { key: 'faces', label: '三角面', children: model.faces.toLocaleString() },
      { key: 'vertices', label: '顶点', children: model.vertices.toLocaleString() },
      { key: 'size', label: '文件大小', children: `${(model.sizeBytes / 1048576).toFixed(1)} MB` },
      { key: 'version', label: '来源版本', children: <Typography.Text copyable>{model.sourceVersionId}</Typography.Text> },
    ]} />
    <MeshGlbPanel key={model.id} model={model} />
  </section>;
}
