import { useEffect, useState } from 'react';
import { Alert, Button, Card, Progress, Space, Typography } from 'antd';
import { cancelMesh, createMesh, downloadMesh, fetchMesh, type MeshState } from '../../services/meshApi';
import { toApiError } from '../../services/http';

const active = new Set(['QUEUED', 'RUNNING', 'CANCEL_REQUESTED']);
const stages: Record<string, string> = {
  PREPARING: '准备重建资料', RENDERING: '渲染多视角表面深度', TSDF: '融合 2DGS 深度并提取网格',
  NKSR: 'NKSR 表面重建', EXTRACTING: '提取三角网格', WRITING: '应用真实尺度并保存', SUCCEEDED: '已完成',
};

export function SurfaceMeshPanel({ sceneId }: { sceneId: string }) {
  const [state, setState] = useState<MeshState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await fetchMesh(sceneId);
        if (!disposed) { setState(value); setError(null); }
      } catch (reason) {
        if (!disposed) setError(toApiError(reason).message);
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll(); }, 2000);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [sceneId]);

  const job = state?.job;
  const running = !!job && active.has(job.status);
  const generate = async () => {
    if (!state?.currentVersionId || busy) return;
    setBusy(true); setError(null);
    try { setState(await createMesh(sceneId, state.currentVersionId)); }
    catch (reason) { setError(toApiError(reason).message); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!job) return;
    setBusy(true);
    try { setState(await cancelMesh(sceneId, job.id)); }
    catch (reason) { setError(toApiError(reason).message); }
    finally { setBusy(false); }
  };
  const download = async () => {
    if (!job) return;
    setDownloading(true);
    try { await downloadMesh(sceneId, job.id); }
    catch (reason) { setError(toApiError(reason).message); }
    finally { setDownloading(false); }
  };

  return <Card title="表面网格化">
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Typography.Paragraph>先完成尺度标定，再生成彩色三角网格。网格自动沿用标定倍率，下载后的长度单位为米。</Typography.Paragraph>
      <Typography.Paragraph>2DGS 使用原生深度融合（TSDF）；通用 3DGS 使用 NKSR。系统根据重建算法自动选择。</Typography.Paragraph>
      {state?.algorithm && <Typography.Text strong>当前方法：{state.algorithm === '2dgs-tsdf' ? '2DGS 原生 TSDF' : '3DGS → NKSR'}</Typography.Text>}
      {state?.reason && <Alert type="info" title={state.reason} />}
      {error && <Alert type="error" title={error} />}
      <Button type="primary" disabled={!state?.available || running || job?.status === 'SUCCEEDED'}
        loading={busy} onClick={() => { void generate(); }}>生成表面网格</Button>
      {job && <>
        <Typography.Text>{job.status === 'QUEUED' ? '等待 GPU 队列' : job.status === 'CANCEL_REQUESTED' ? '正在取消'
          : job.status === 'FAILED' ? '网格生成失败' : job.status === 'CANCELLED' ? '已取消'
            : stages[job.stage ?? ''] ?? job.stage ?? job.status}</Typography.Text>
        <Progress percent={job.progress} status={job.status === 'FAILED' ? 'exception' : job.status === 'SUCCEEDED' ? 'success' : 'active'} />
        {running && <><Typography.Text>每 2 秒刷新任务状态，复杂阶段会停留在当前进度，完成后继续推进；刷新页面可恢复查看。</Typography.Text>
          <Button disabled={busy || job.status === 'CANCEL_REQUESTED'} onClick={() => { void cancel(); }}>取消网格生成</Button></>}
        {job.errorMessage && <Alert type={job.status === 'CANCELLED' ? 'info' : 'error'} title={job.errorMessage} />}
        {job.status === 'SUCCEEDED' && job.result && state?.available && <>
          <Typography.Text>{job.result.vertices.toLocaleString()} 个顶点 · {job.result.faces.toLocaleString()} 个三角面 · 单位：米</Typography.Text>
          <Button loading={downloading} onClick={() => { void download(); }}>下载彩色 PLY 网格</Button>
        </>}
      </>}
      <Typography.Paragraph>之后可继续调整视角和标注。若发布了修改高斯几何的新版本，旧网格将停止提供下载，避免尺寸或形状不匹配。</Typography.Paragraph>
    </Space>
  </Card>;
}
