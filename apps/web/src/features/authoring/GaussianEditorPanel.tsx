import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Input, InputNumber, Progress, Select, Space, Typography } from 'antd';
import {
  cancelEditSession, createEditSession, createEditUpload, fetchEditSession, fetchEditSource,
  officialEditorUrl, type EditSession, type EditSource,
  completeCalibration,
} from '../../services/editorApi';
import { toApiError } from '../../services/http';
import { ResumableUploader } from '../upload/ResumableUploader';

const terminal = new Set(['COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED']);
const processing = new Set(['QUEUED', 'VALIDATING', 'CONVERTING', 'VERIFYING', 'PUBLISHING']);

interface MeasurementDraft {
  sourceVersionId: string | null;
  editSessionId: string | null;
  referenceName: string;
  originalDistance: number | null;
  realLength: number | null;
  unit: 'mm' | 'cm' | 'm';
  remeasuredDistance: number | null;
  provenance: string;
}

function readMeasurement(key: string): MeasurementDraft | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if ((record.sourceVersionId !== null && typeof record.sourceVersionId !== 'string')
      || (record.editSessionId !== null && typeof record.editSessionId !== 'string')) return null;
    if (typeof record.referenceName !== 'string' || typeof record.provenance !== 'string'
      || !['mm', 'cm', 'm'].includes(String(record.unit))) return null;
    for (const field of ['originalDistance', 'realLength', 'remeasuredDistance']) {
      const number = record[field];
      if (number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number <= 0)) return null;
    }
    return value as MeasurementDraft;
  } catch { return null; }
}

export function GaussianEditorPanel({ sceneId, calibration = false }: { sceneId: string; calibration?: boolean }) {
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
  const measurementKey = `gs-calibration-draft:${sceneId}`;
  const [measurement, setMeasurement] = useState(() => readMeasurement(measurementKey));
  useEffect(() => { setMeasurement(readMeasurement(measurementKey)); }, [measurementKey]);
  const draft = measurement ?? { sourceVersionId: null, editSessionId: null,
    referenceName: '', originalDistance: null, realLength: null,
    unit: 'cm' as const, remeasuredDistance: null, provenance: '' };
  const updateMeasurement = (patch: Partial<typeof draft>) => {
    const sourceVersionId = session?.sourceVersionId ?? source?.currentVersionId ?? null;
    const editSessionId = session?.id ?? null;
    const sameBinding = draft.sourceVersionId === sourceVersionId
      && (!draft.editSessionId || draft.editSessionId === editSessionId);
    const value = { ...draft,
      ...(!sameBinding ? { originalDistance: null, remeasuredDistance: null, provenance: '' } : {}),
      ...patch, sourceVersionId, editSessionId };
    setMeasurement(value);
    localStorage.setItem(measurementKey, JSON.stringify(value));
  };
  const realMeters = (draft.realLength ?? 0) * { mm: .001, cm: .01, m: 1 }[draft.unit];
  const uploader = useRef<ResumableUploader | null>(null);
  const alive = useRef(true);
  const storageKey = `gs-editor-session:${sceneId}`;

  useEffect(() => {
    let disposed = false;
    alive.current = true;
    setSession(null);
    setSource(null);
    setError(null);
    setFile(null);
    setNotice(null);
    setLod(0);
    setAcknowledged(false);
    setExportAcknowledged(false);
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
      const sameSource = draft.sourceVersionId === created.sourceVersionId
        && (!draft.editSessionId || draft.editSessionId === created.id);
      const boundDraft = { ...draft, sourceVersionId: created.sourceVersionId, editSessionId: created.id,
        ...(!sameSource ? { originalDistance: null, remeasuredDistance: null, provenance: '' } : {}) };
      setMeasurement(boundDraft);
      localStorage.setItem(measurementKey, JSON.stringify(boundDraft));
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
  return <Card title={calibration ? '尺度标定' : '高级 Gaussian 编辑'} style={{ marginBottom: 12 }}>
    <Space orientation="vertical" style={{ width: '100%' }}>
      {calibration && <>
        <Typography.Paragraph>打开模型 → 在底部选择 Measure → 在标定物上点击两个端点 → 记录原距离 → 将该字段改为真实距离（米）→ 导出 PLY → 回到这里提交 → 发布后重新测量并保存记录。</Typography.Paragraph>
        <Typography.Text>Measure 会围绕两点中点对整个模型等比例缩放。请把标定物包含在重建目标内，并检查原始测量点确实位于物体表面。</Typography.Text>
        <Input aria-label="标定物名称" placeholder="标定物名称" value={draft.referenceName}
          onChange={event => updateMeasurement({ referenceName: event.target.value })} />
        <label>官方测得的原始距离（场景单位）<InputNumber aria-label="原始测量距离" min={0.000001}
          value={draft.originalDistance} onChange={value => updateMeasurement({ originalDistance: value })} /></label>
        <label>真实长度<InputNumber aria-label="标定物真实长度" min={0.000001}
          value={draft.realLength} onChange={value => updateMeasurement({ realLength: value })} /></label>
        <Select aria-label="标定长度单位" value={draft.unit} onChange={unit => updateMeasurement({ unit })}
          options={['mm', 'cm', 'm'].map(unit => ({ value: unit, label: unit }))} />
        {realMeters > 0 && <Typography.Text>在官方 Measure 距离框中输入 {realMeters} 米
          {draft.originalDistance ? `；统一缩放倍率 ${(realMeters / draft.originalDistance).toPrecision(7)}` : ''}。</Typography.Text>}
      </>}
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
        {calibration && session.status === 'COMPLETED' && <>
          <Typography.Paragraph>重新打开新版本，在相同两个表面端点再次测量，填写实际读数。记录由用户转录，保存为待验证尺度，不会自动启用物理行走。</Typography.Paragraph>
          <Button disabled={!source?.currentVersionId} onClick={() => {
            setBusy(true);
            void createEditSession(sceneId, source!, lod, acknowledged).then(created => {
              const opened = window.open(officialEditorUrl(created), '_blank');
              if (opened) opened.opener = null;
              else setError('浏览器拦截了复测窗口，请允许打开新窗口后重试。');
            }).catch(reason => setError(toApiError(reason).message)).finally(() => setBusy(false));
          }}>打开新版本进行独立复测</Button>
          <label>缩放后重新测量的距离（米）<InputNumber aria-label="缩放后复测距离" min={0.000001}
            value={draft.remeasuredDistance} onChange={value => updateMeasurement({ remeasuredDistance: value })} /></label>
          <Input.TextArea aria-label="测量证据说明" placeholder="测量点位置、官方 Editor 读数与复测说明"
            value={draft.provenance} onChange={event => updateMeasurement({ provenance: event.target.value })} />
          <Button loading={busy} disabled={!draft.referenceName || !draft.originalDistance || !draft.realLength
            || !draft.remeasuredDistance || !draft.provenance || !session.resultVersionId
            || draft.sourceVersionId !== session.sourceVersionId || draft.editSessionId !== session.id} onClick={() => {
            setBusy(true);
            void completeCalibration(sceneId, session.id, { referenceName: draft.referenceName,
              unit: draft.unit, provenance: draft.provenance, sourceVersionId: session.sourceVersionId,
              resultVersionId: session.resultVersionId!, originalDistance: draft.originalDistance!,
              realLength: draft.realLength!, remeasuredDistance: draft.remeasuredDistance! })
              .then(result => setNotice(`标定记录已绑定新版本（待验证）。绝对误差 ${result.evidence.absoluteErrorMeters.toPrecision(4)} 米；相对误差 ${(result.evidence.relativeError * 100).toFixed(2)}%。`))
              .catch(reason => setError(toApiError(reason).message)).finally(() => setBusy(false));
          }}>保存标定与复测记录</Button>
          <Button href={`/model/edit/${encodeURIComponent(sceneId)}?workspace=calibration`}>重新加载标定后的场景</Button>
        </>}
      </>}
      <Button href={`/scene/${encodeURIComponent(sceneId)}`}>{session?.status === 'COMPLETED' ? '在正式 Viewer 查看新版本' : '返回场景'}</Button>
    </Space>
  </Card>;
}
