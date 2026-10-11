import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Progress, Select, Space, Typography } from 'antd';
import {
  cancelEditSession, createEditSession, createEditUpload, fetchEditSession, fetchEditSource,
  officialEditorUrl, type EditSession, type EditSource,
} from '../../services/editorApi';
import { toApiError } from '../../services/http';
import { ResumableUploader } from '../upload/ResumableUploader';

const terminal = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED']);
const processing = new Set(['QUEUED', 'VALIDATING', 'CONVERTING', 'VERIFYING', 'PUBLISHING']);

export function GaussianEditorPanel({ sceneId }: { sceneId: string }) {
  const [source, setSource] = useState<EditSource | null>(null);
  const [session, setSession] = useState<EditSession | null>(null);
  const [lod, setLod] = useState(0);
  const [acknowledged, setAcknowledged] = useState(false);
  const [exportAcknowledged, setExportAcknowledged] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const uploader = useRef<ResumableUploader | null>(null);
  const alive = useRef(true);
  const storageKey = `gs-editor-session:${sceneId}`;

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    setSession(null);
    setSource(null);
    setError(null);
    void fetchEditSource(sceneId).then(result => {
      if (!disposed) setSource(result);
    }).catch(reason => { if (!disposed) setError(toApiError(reason).message); });
    const saved = localStorage.getItem(storageKey);
    if (saved) void fetchEditSession(sceneId, saved).then(result => {
      if (!disposed) setSession(result);
    }).catch(() => { if (!disposed) localStorage.removeItem(storageKey); });
    return () => {
      disposed = true;
      alive.current = false;
      uploader.current?.stop();
    };
  }, [sceneId, storageKey]);

  useEffect(() => {
    if (session?.status !== 'COMPLETED') return;
    let disposed = false;
    void fetchEditSource(sceneId).then(result => { if (!disposed) setSource(result); })
      .catch(reason => { if (!disposed) setError(toApiError(reason).message); });
    return () => { disposed = true; };
  }, [sceneId, session?.status]);

  useEffect(() => {
    if (!session || terminal.has(session.status)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await fetchEditSession(sceneId, session.id);
        if (!disposed) {
          setSession(result);
          if (!terminal.has(result.status)) timer = setTimeout(() => { void poll(); }, 2000);
        }
      } catch (reason) {
        if (!disposed) {
          setError(toApiError(reason).message);
          timer = setTimeout(() => { void poll(); }, 5000);
        }
      }
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { disposed = true; if (timer) clearTimeout(timer); };
  }, [sceneId, session?.id, session?.status]);

  const launch = async () => {
    setError(null);
    setBusy(true);
    try {
      const created = session && !terminal.has(session.status) ? session
        : await createEditSession(sceneId, source!, lod, acknowledged);
      if (!alive.current) return;
      setSession(created);
      localStorage.setItem(storageKey, created.id);
      const opened = window.open(officialEditorUrl(created), '_blank');
      if (opened) opened.opener = null;
      else setNotice('浏览器拦截了新窗口。授权会话已创建，请再次点击打开 SuperSplat Editor。');
    } catch (reason) { if (alive.current) setError(toApiError(reason).message); }
    finally { if (alive.current) setBusy(false); }
  };

  const submit = async () => {
    if (!session || !file) return;
    setError(null);
    setUploading(true);
    setNotice('正在计算 SHA-256，然后上传。上传完成后还需验证、转换与原子发布。');
    try {
      const upload = await createEditUpload(sceneId, session, file);
      if (!alive.current) return;
      const transfer = new ResumableUploader(file, upload, event => {
        if (!alive.current) return;
        if (event.type === 'progress') setUploadProgress(Math.round(event.sent / event.total * 100));
        if (event.type === 'error') setError(event.message);
        if (event.type === 'completed') setNotice('文件上传完成；等待新 SceneVersion 发布，不代表发布已完成。');
      });
      uploader.current = transfer;
      await transfer.run();
      if (alive.current) setSession(await fetchEditSession(sceneId, session.id));
    } catch (reason) { if (alive.current) setError(toApiError(reason).message); }
    finally { if (alive.current) { setUploading(false); setPaused(false); } }
  };

  const cancel = async () => {
    if (!session) return;
    setBusy(true);
    try {
      uploader.current?.stop();
      setSession(await cancelEditSession(sceneId, session.id));
      setNotice('编辑会话已取消，当前场景版本保持不变。已上传数据仍在私有暂存区按期限清理。');
    } catch (reason) { setError(toApiError(reason).message); }
    finally { setBusy(false); }
  };

  const count = session && !terminal.has(session.status)
    ? session.sourceCounts[session.selectedLod ?? 0] : source?.counts[lod] ?? 0;
  const needsAcknowledgement = source?.format === 'streamed-sog' || count > 1_000_000;
  const active = session && !terminal.has(session.status);
  const inProcessing = session && processing.has(session.status);
  return <Card title="高级 Gaussian 编辑" style={{ marginBottom: 12 }}>
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Alert type="info" title="仅官方 Editor 执行 Gaussian 编辑。File → Export → PLY（不要启用 Compress PLY），保存后返回上传。仅编辑不会修改原场景。" />
      <Alert type="warning" title="不要使用 Editor 的 Publish / superspl.at；独立部署策略阻断第三方网络上传。私有数据只应导出到本机并上传回 GSPlatform。" />
      {error && <Alert type="error" title={error} />}
      {notice && <Alert type="info" title={notice} />}
      {source && <>
        <Typography.Text>{source.sceneTitle} · 当前版本 {source.assetVersion ?? '未发布'}</Typography.Text>
        {source.spatialState === 'STALE' && <Alert type="warning" title="几何编辑后，历史相机、世界变换、视角点、标注和标定保持历史记录但空间绑定已失效；运行态不沿用。Collision 不自动重建。" />}
        {source.format === 'streamed-sog' && !active && <>
          <Select aria-label="编辑来源 LOD" value={lod} disabled={!!active}
            onChange={setLod} options={source.counts.map((amount, index) => ({ value: index,
              label: `LOD ${index} · ${amount.toLocaleString()} Gaussian`, disabled: amount > source.maxGaussians }))} />
          <Typography.Text type="warning">只有 Streamed SOG 来源；必须在官方 Editor 中选择相同 LOD，不能把降采样导出冒充原始全精度。</Typography.Text>
        </>}
        <Typography.Text>编辑数量：{count.toLocaleString()} · 浏览器上限 {source.maxGaussians.toLocaleString()}</Typography.Text>
        {needsAcknowledgement && <Checkbox checked={acknowledged} disabled={!!active}
          onChange={event => setAcknowledged(event.target.checked)}>确认所选 LOD 与浏览器内存风险，不会补回缺失细节</Checkbox>}
      </>}
      <Button onClick={() => { void launch(); }} loading={busy} disabled={!source?.editorEnabled
        || !source.currentVersionId || !!inProcessing || (!active && (count > source.maxGaussians
          || (needsAcknowledgement && !acknowledged)))}>
        打开 SuperSplat Editor
      </Button>
      {source && !source.editorEnabled && <Typography.Text>此部署尚未启用官方编辑器。</Typography.Text>}
      {session && <>
        <Typography.Text>授权状态：{session.status} · 会话 {session.id}</Typography.Text>
        <Typography.Text>源版本：{session.sourceAssetVersion} · 来源：{session.sourceKind}
          {session.selectedLod !== null ? ` · LOD ${session.selectedLod} · ${session.sourceCounts[session.selectedLod]} Gaussian` : ''}</Typography.Text>
        <Typography.Text>Editor：{session.editorUpstreamCommit.slice(0, 12)} · 构建 {session.editorBuildIdentity.slice(0, 12)}</Typography.Text>
        <Typography.Text>到期：{new Date(session.expiresAt).toLocaleString()}</Typography.Text>
        {session.errorCode && <Alert type="error" title={session.errorCode === 'EDIT_BASE_VERSION_CHANGED'
          ? '基准版本已变化：拒绝覆盖新版本，导出结果保留在私有隔离区。请保存本机导出并重新创建会话、处理冲突。' : session.errorCode} />}
        {((!terminal.has(session.status) && !inProcessing) || (session.status === 'FAILED'
          && session.errorCode !== 'EDIT_BASE_VERSION_CHANGED')) && <>
          <input type="file" aria-label="官方编辑导出文件" accept=".ply,.sog" disabled={uploading}
            onChange={event => setFile(event.target.files?.[0] ?? null)} />
          {session.selectedLod !== null && <Checkbox checked={exportAcknowledged}
            onChange={event => setExportAcknowledged(event.target.checked)}>确认实际导出来自会话指定的 LOD {session.selectedLod}，不是全分辨率合并</Checkbox>}
          <Button loading={uploading} disabled={!file || (session.selectedLod !== null && !exportAcknowledged)}
            onClick={() => { void submit(); }}>提交编辑结果（支持断点重试）</Button>
        </>}
        {uploading && <>
          <Progress percent={uploadProgress} />
          <Button onClick={() => {
            if (paused) uploader.current?.resume(); else uploader.current?.pause();
            setPaused(!paused);
          }}>{paused ? '继续上传' : '暂停上传'}</Button>
        </>}
        {!!inProcessing && <><Typography.Text>发布阶段：{session.stage ?? session.status}</Typography.Text><Progress percent={session.progress} /></>}
        {!terminal.has(session.status) && <Button danger onClick={() => { void cancel(); }} disabled={busy}>取消编辑会话</Button>}
        {session.status === 'COMPLETED' && <Alert type="success" title={`新 SceneVersion 已发布：${session.resultVersionId}。实际发布 Gaussian：${session.resultCounts?.[0]?.toLocaleString() ?? '读取当前版本数量'}。历史版本保持不变，Collision 需手动评估。`} />}
      </>}
      <Button href={`/scene/${encodeURIComponent(sceneId)}`}>{session?.status === 'COMPLETED' ? '在正式 Viewer 查看新版本' : '返回场景'}</Button>
    </Space>
  </Card>;
}
