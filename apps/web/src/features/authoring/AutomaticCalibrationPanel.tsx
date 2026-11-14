import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, InputNumber, Progress, Select, Space, Typography } from 'antd';
import { calibrateScene, fetchEditSession, fetchEditSource, type EditSession, type EditSource } from '../../services/editorApi';
import { toApiError } from '../../services/http';

const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);

export function AutomaticCalibrationPanel({ sceneId, onCompleted }: {
  sceneId: string; onCompleted?: (session: EditSession) => void;
}) {
  const [source, setSource] = useState<EditSource | null>(null);
  const [session, setSession] = useState<EditSession | null>(null);
  const [referenceName, setReferenceName] = useState('标定方块');
  const [distance, setDistance] = useState<number | null>(null);
  const [length, setLength] = useState<number | null>(null);
  const [unit, setUnit] = useState<'mm' | 'cm' | 'm'>('mm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completed = useRef<string | null>(null);
  const key = `gs-auto-calibration:${sceneId}`;
  const refreshCallback = useRef(onCompleted);
  refreshCallback.current = onCompleted;

  useEffect(() => {
    let disposed = false;
    void fetchEditSource(sceneId).then(value => { if (!disposed) setSource(value); })
      .catch(reason => { if (!disposed) setError(toApiError(reason).message); });
    const saved = localStorage.getItem(key);
    if (saved) void fetchEditSession(sceneId, saved).then(value => {
      if (!disposed && value.automaticCalibration) setSession(value);
    }).catch(() => { if (!disposed) localStorage.removeItem(key); });
    return () => { disposed = true; };
  }, [sceneId, key]);

  useEffect(() => {
    if (!session || terminal.has(session.status)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await fetchEditSession(sceneId, session.id);
        if (!disposed) { setError(null); setSession(value); }
      } catch (reason) {
        if (!disposed) setError(toApiError(reason).message);
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll(); }, 1500);
      }
    };
    timer = setTimeout(() => { void poll(); }, 500);
    return () => { disposed = true; clearTimeout(timer); };
  }, [sceneId, session?.id, session?.status]);

  useEffect(() => {
    if (session?.status !== 'COMPLETED' || completed.current === session.id) return;
    completed.current = session.id;
    void fetchEditSource(sceneId).then(setSource)
      .catch(reason => setError(toApiError(reason).message));
    refreshCallback.current?.(session);
  }, [sceneId, session]);

  const running = busy || !!(session && !terminal.has(session.status));
  const blocked = source?.calibrationAvailable === false;
  const factor = distance && length ? length * { mm: .001, cm: .01, m: 1 }[unit] / distance : null;
  const missing = !source ? '正在读取模型…' : blocked ? source.calibrationBlockedReason
    : !referenceName.trim() ? '请填写标定物名称。' : !distance || distance <= 0 ? '请填写模型中测得的长度。'
      : !length || length <= 0 ? '请填写标定物的实际长度。' : null;

  const submit = async () => {
    if (running || missing || !source?.currentVersionId || !distance || !length) return;
    setBusy(true);
    setError(null);
    try {
      const value = await calibrateScene(sceneId, { expectedCurrentVersion: source.currentVersionId,
        referenceName: referenceName.trim(), originalDistance: distance, realLength: length, unit });
      localStorage.setItem(key, value.id);
      setSession(value);
    } catch (reason) {
      setError(toApiError(reason).message);
      void fetchEditSource(sceneId).then(setSource).catch(() => undefined);
    } finally { setBusy(false); }
  };

  return <Card title="第 1 步：尺度标定">
    <Space orientation="vertical" style={{ width: '100%' }}>
      <Typography.Paragraph>先用已知尺寸的标定物恢复整个模型的真实尺度，再保存视角、标注和其他编辑。标定完成或保存其他编辑后，此入口会锁定，防止重复缩放。</Typography.Paragraph>
      <Typography.Paragraph>输入方块同一条边在模型中的测量长度和实际长度，点击下方按钮。系统会自动缩放整个模型、发布并加载新版本，无需手动导出或上传文件。</Typography.Paragraph>
      <Typography.Paragraph>测量入口：关闭此面板，打开「Gaussian 编辑」，在官方编辑器底部选择 Measure，点击同一条边的两个端点，读取距离后回到此处填写。测量时保持模型原尺寸即可。</Typography.Paragraph>
      {source && <Typography.Text>{source.sceneTitle} · {source.counts[0]?.toLocaleString()} Gaussian</Typography.Text>}
      <Input aria-label="标定物名称" value={referenceName} disabled={running || blocked}
        onChange={e => setReferenceName(e.target.value)} />
      <label>模型中同一条边的测量长度（场景单位）<InputNumber aria-label="原始测量距离" min={0.000000001}
        value={distance} disabled={running || blocked} onChange={setDistance} /></label>
      <label>该边已知的实际长度<InputNumber aria-label="标定物真实长度" min={0.000000001}
        value={length} disabled={running || blocked} onChange={setLength} /></label>
      <Select aria-label="标定长度单位" value={unit} disabled={running || blocked} onChange={setUnit}
        options={['mm', 'cm', 'm'].map(value => ({ value, label: value }))} />
      {factor && <Typography.Text>整个模型等比例缩放倍率：{factor.toPrecision(7)}；缩放后单位为米。</Typography.Text>}
      {missing && !running && <Alert type={blocked ? 'warning' : 'info'} title={missing} />}
      {error && <Alert type="error" title={error} />}
      <Button type="primary" loading={running} disabled={running || blocked || !!missing || !source?.currentVersionId}
        onClick={() => { void submit(); }}>应用尺度标定并自动发布</Button>
      {running && <><Typography.Text>正在自动缩放、校验和发布，请等待完成后再进行其他编辑。{session?.stage ? `（${session.stage}）` : ''}</Typography.Text>
        <Progress percent={session?.progress ?? 0} /></>}
      {session?.status === 'COMPLETED' && <Alert type="success" title="尺度标定已完成，新版本已发布，可以继续调整视角和标注。" />}
      {session?.status === 'FAILED' && <Alert type="error" title={`标定失败，原版本保持可用。${session.errorCode ?? ''}`} />}
    </Space>
  </Card>;
}
