import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Checkbox,
  Input,
  Progress,
  Select,
  Space,
  Spin,
  Steps,
  Typography,
  Upload,
} from 'antd';
import type { BadgeProps, UploadFile, UploadProps } from 'antd';
import { InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import { useBlocker, useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import {
  ResumableUploader,
  UploadCancelledError,
  createUploadSession,
} from '../features/upload/ResumableUploader';
import type { UploadEvent, UploadSessionInfo } from '../features/upload/ResumableUploader';
import {
  cancelJob,
  fetchCapabilities,
  fetchJob,
  fetchProfiles,
  submitReconstruction,
} from '../features/compute/computeApi';
import type { ComputeJob, ComputeProfile } from '../features/compute/computeApi';
import { toApiError } from '../services/http';

const { Dragger } = Upload;

const ACCEPTED_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv', 'jpg', 'jpeg', 'png', 'webp'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'avi', 'mkv'];
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const MAX_FILE_COUNT = 20;
const POLL_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** 重建流水线阶段中文标签（与后端 stage 常量一一对应）。 */
const STAGE_LABELS: Record<string, string> = {
  PROBING: '探测素材',
  EXTRACTING: '抽取帧',
  PRECHECK: '预检',
  FEATURES: '特征提取',
  MATCHING: '特征匹配',
  MAPPING: '稀疏重建',
  TRAINING: '高斯训练',
  CONVERTING: '格式转换',
  VERIFYING: '资产验证',
  PUBLISHING: '发布中',
  SUCCEEDED: '已完成',
};

const STATUS_META: Record<string, { badge: NonNullable<BadgeProps['status']>; text: string }> = {
  QUEUED: { badge: 'processing', text: '排队中' },
  RUNNING: { badge: 'processing', text: '计算中' },
  SUCCEEDED: { badge: 'success', text: '已完成' },
  FAILED: { badge: 'error', text: '失败' },
  CANCELLED: { badge: 'default', text: '已取消' },
};

const PROFILE_LABELS: Record<string, string> = {
  draft: '草稿（快速）',
  standard: '标准（均衡）',
  high: '高精度（实验性）',
};

/** 后端不可达时的兜底档位（与 workers/reconstruction/profiles 一致）。 */
const FALLBACK_PROFILES: ComputeProfile[] = [
  { name: 'draft', version: 1, maxInputBytes: 1_048_576_000, maxImages: 80, maxVideoSeconds: 300, iterations: 1200, stages: [] },
  { name: 'standard', version: 1, maxInputBytes: 4_294_967_296, maxImages: 300, maxVideoSeconds: 1200, iterations: 8000, stages: [] },
  { name: 'high', version: 1, maxInputBytes: 8_589_934_592, maxImages: 800, maxVideoSeconds: 2400, iterations: 30_000, stages: [] },
];

interface FileUploadState {
  uid: string;
  file: File;
  name: string;
  size: number;
  uploadId: string | null;
  status: 'uploading' | 'completed' | 'error';
  sent: number;
  total: number;
  speed: number;
  error: string | null;
  session: UploadSessionInfo | null;
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

/**
 * 免费计算页：三步流程（上传素材 → 参数确认 → 排队与计算）。
 *
 * 上传素材：选中的文件立即通过 ResumableUploader 创建 RECONSTRUCT 用途的
 * 上传会话并分块上传，展示真实字节进度；参数确认：从 /compute/profiles
 * 拉取质量档位，提交 /compute/reconstruct；排队与计算：轮询 /jobs/{id}
 * 展示真实阶段与进度，可取消，成功后跳转场景查看。
 */
export default function ComputePage() {
  useDocumentTitle('免费计算');
  const { message, modal } = App.useApp();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [uploadStates, setUploadStates] = useState<Record<string, FileUploadState>>({});
  const [rejectedCount, setRejectedCount] = useState(0);
  const [quality, setQuality] = useState('draft');
  const [profiles, setProfiles] = useState<ComputeProfile[]>(FALLBACK_PROFILES);
  const [capabilityProblems, setCapabilityProblems] = useState<string[]>([]);
  const [sceneTitle, setSceneTitle] = useState(() => `重建场景 ${new Date().toLocaleString()}`);
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState('PRIVATE');
  const [rightsChecked, setRightsChecked] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<ComputeJob | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const uploaderRefs = useRef<Map<string, ResumableUploader>>(new Map());
  const startedRef = useRef<Set<string>>(new Set());
  const titleTouched = useRef(false);

  // ── 挂载时拉取档位与能力探测（后端不可达则用兜底，不阻塞流程） ──────────
  useEffect(() => {
    const controller = new AbortController();
    fetchProfiles(controller.signal)
      .then((data) => {
        if (data.length > 0) setProfiles(data);
      })
      .catch(() => {
        // 保留兜底档位
      });
    fetchCapabilities(controller.signal)
      .then((cap) => setCapabilityProblems(cap.problems ?? []))
      .catch(() => {
        // 能力探测失败不阻塞
      });
    return () => controller.abort();
  }, []);

  // ── 未保存状态守卫（刷新 / 站内跳转前提醒） ───────────────────────────────
  const hasUnsaved = step === 0 ? fileList.length > 0 : step === 1;

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (hasUnsaved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsaved]);

  const blocker = useBlocker(hasUnsaved);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      modal.confirm({
        title: '离开页面？',
        content: '当前选择的素材与参数尚未提交，离开后将丢失。',
        onOk: () => blocker.proceed(),
        onCancel: () => blocker.reset(),
      });
    }
  }, [blocker, modal]);

  // ── 步骤 0：上传素材（真实分块上传） ──────────────────────────────────────
  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    const ext = extOf(file.name);
    const reasons: string[] = [];
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      reasons.push(`不支持扩展名 .${ext}`);
    }
    if (file.size > MAX_FILE_SIZE) {
      reasons.push('超过 1GB 大小限制');
    }
    if (reasons.length > 0) {
      setRejectedCount((prev) => prev + 1);
      message.error(`${file.name}：${reasons.join('；')}`);
      return Upload.LIST_IGNORE;
    }
    return true;
  };

  // antd 自身的虚拟上传直接成功，真实上传由 ResumableUploader 驱动，
  // 进度以下方逐文件列表为准。
  const customRequest: UploadProps['customRequest'] = ({ onSuccess }) => {
    onSuccess?.({});
  };

  const handleChange: UploadProps['onChange'] = ({ fileList: next }) => {
    const limited = next.slice(0, MAX_FILE_COUNT);
    setFileList(limited);
    // 移除已从列表删除文件的进行中上传器
    const present = new Set(limited.map((f) => f.uid));
    for (const uid of startedRef.current) {
      if (!present.has(uid)) {
        const up = uploaderRefs.current.get(uid);
        if (up) {
          void up.cancel();
          uploaderRefs.current.delete(uid);
        }
        startedRef.current.delete(uid);
      }
    }
  };

  const handleUploadEvent = useCallback((uid: string, e: UploadEvent): void => {
    setUploadStates((prev) => {
      const cur = prev[uid];
      if (!cur) return prev;
      switch (e.type) {
        case 'progress':
          return { ...prev, [uid]: { ...cur, sent: e.sent, total: e.total, speed: e.speed } };
        case 'resumed':
          return { ...prev, [uid]: { ...cur, sent: e.offset, total: e.total } };
        case 'completed':
          return { ...prev, [uid]: { ...cur, status: 'completed', uploadId: e.result.uploadId, sent: cur.total } };
        case 'error':
          return { ...prev, [uid]: { ...cur, status: 'error', error: e.message } };
        case 'paused':
          return prev;
      }
    });
  }, []);

  const startUpload = useCallback(
    async (file: UploadFile, existingSession?: UploadSessionInfo): Promise<void> => {
      const origin = file.originFileObj as File | undefined;
      if (!origin) return;
      const uid = file.uid;
      const ext = extOf(origin.name);

      setUploadStates((prev) => ({
        ...prev,
        [uid]: {
          uid,
          file: origin,
          name: origin.name,
          size: origin.size,
          uploadId: existingSession?.uploadId ?? null,
          status: 'uploading',
          sent: existingSession?.offset ?? 0,
          total: origin.size,
          speed: 0,
          error: null,
          session: existingSession ?? null,
        },
      }));

      try {
        const session =
          existingSession ??
          (await createUploadSession({
            filename: origin.name,
            mime_type: origin.type || 'application/octet-stream',
            size: origin.size,
            format: ext,
            title: origin.name,
            description: null,
            visibility: 'PRIVATE',
            category: 'experiment',
            purpose: 'RECONSTRUCT',
          }));

        const uploader = new ResumableUploader(origin, session, (e) => handleUploadEvent(uid, e));
        uploaderRefs.current.set(uid, uploader);
        setUploadStates((prev) =>
          prev[uid]
            ? { ...prev, [uid]: { ...prev[uid], uploadId: session.uploadId, session } }
            : prev,
        );
        await uploader.run();
      } catch (error) {
        if (error instanceof UploadCancelledError) return;
        const apiError = toApiError(error);
        setUploadStates((prev) =>
          prev[uid] ? { ...prev, [uid]: { ...prev[uid], status: 'error', error: apiError.message } } : prev,
        );
      }
    },
    [handleUploadEvent],
  );

  // 文件进入列表后立即开始真实上传（每个 uid 只启动一次）。
  useEffect(() => {
    for (const f of fileList) {
      if (f.originFileObj && !startedRef.current.has(f.uid)) {
        startedRef.current.add(f.uid);
        void startUpload(f);
      }
    }
  }, [fileList, startUpload]);

  const retryUpload = (uid: string): void => {
    const file = fileList.find((f) => f.uid === uid);
    const cur = uploadStates[uid];
    if (!file || !cur) return;
    // 复用原会话：ResumableUploader 会重新查询服务端 offset 断点续传。
    void startUpload(file, cur.session ?? undefined);
  };

  const removeUpload = (uid: string): void => {
    const up = uploaderRefs.current.get(uid);
    if (up) {
      void up.cancel();
      uploaderRefs.current.delete(uid);
    }
    startedRef.current.delete(uid);
    setUploadStates((prev) => {
      const next = { ...prev };
      delete next[uid];
      return next;
    });
    setFileList((prev) => prev.filter((f) => f.uid !== uid));
  };

  const uploadRows = fileList
    .map((f) => uploadStates[f.uid])
    .filter((u): u is FileUploadState => u != null);
  const allUploaded = fileList.length > 0 && fileList.every((f) => uploadStates[f.uid]?.status === 'completed');

  const hasVideo = fileList.some((f) => VIDEO_EXTENSIONS.includes(extOf(f.name)));
  const hasPhoto = fileList.some((f) => !VIDEO_EXTENSIONS.includes(extOf(f.name)) && ACCEPTED_EXTENSIONS.includes(extOf(f.name)));
  const isMixed = hasVideo && hasPhoto;

  // 首个文件选中且用户未手动改标题时，用文件名预填场景标题。
  useEffect(() => {
    if (titleTouched.current) return;
    const first = fileList[0];
    if (first) {
      const stem = first.name.replace(/\.[^.]+$/, '');
      if (stem) setSceneTitle(stem);
    }
  }, [fileList]);

  // ── 步骤 2：排队与计算（轮询真实任务状态） ───────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    let timer: number | undefined;
    const tick = async (): Promise<void> => {
      try {
        const j = await fetchJob(jobId);
        if (stopped) return;
        setJob(j);
        if (TERMINAL_STATUSES.includes(j.status) && timer) {
          window.clearInterval(timer);
        }
      } catch {
        // 轮询瞬时失败保留上次状态，下一轮继续
      }
    };
    timer = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearInterval(timer);
    };
  }, [jobId]);

  const handleSubmit = async (): Promise<void> => {
    if (!rightsChecked) {
      message.error('请先确认您拥有素材权利并同意处理规则。');
      return;
    }
    const uploadIds = fileList
      .map((f) => uploadStates[f.uid]?.uploadId)
      .filter((id): id is string => !!id);
    if (uploadIds.length === 0) {
      message.error('请先完成素材上传。');
      return;
    }
    if (!sceneTitle.trim()) {
      message.error('请填写场景标题。');
      return;
    }
    setSubmitting(true);
    try {
      const resp = await submitReconstruction({
        uploadIds,
        profile: quality,
        sceneTitle: sceneTitle.trim(),
        description: description.trim() ? description.trim() : null,
        visibility,
      });
      setJobId(resp.jobId);
      setJob({
        id: resp.jobId,
        sceneId: resp.sceneId ?? '',
        kind: 'RECONSTRUCT',
        status: resp.status,
        stage: resp.stage,
        progress: resp.progress,
        errorCode: resp.errorCode,
        errorMessage: resp.errorMessage,
        createdAt: resp.createdAt,
        updatedAt: resp.updatedAt,
      });
      setStep(2);
    } catch (error) {
      message.error(toApiError(error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmCancel = (): void => {
    if (!jobId) return;
    modal.confirm({
      title: '取消计算任务？',
      content: '取消后任务将停止，已上传的素材会保留。',
      okText: '取消任务',
      okButtonProps: { danger: true },
      cancelText: '继续计算',
      onOk: async (): Promise<void> => {
        try {
          const j = await cancelJob(jobId);
          setJob(j);
        } catch {
          message.error('取消失败，请稍后重试。');
        }
      },
    });
  };

  const goToScene = (): void => {
    if (job?.sceneId) {
      navigate(`/scene/${encodeURIComponent(job.sceneId)}`);
    }
  };

  const selectedProfile = profiles.find((p) => p.name === quality);
  const profileOptions = profiles.map((p) => ({
    value: p.name,
    label: PROFILE_LABELS[p.name] ?? p.name,
  }));

  const statusMeta = job ? STATUS_META[job.status] : undefined;
  const stageLabel = job?.stage ? (STAGE_LABELS[job.stage] ?? job.stage) : '';
  const isTraining = job?.stage === 'TRAINING';
  const terminal = job ? TERMINAL_STATUSES.includes(job.status) : false;

  const submitHint = !rightsChecked
    ? '请先确认您拥有素材权利并同意处理规则。'
    : '提交后将在服务端排队重建，可在下一步实时查看进度。';

  return (
    <section aria-label="免费计算" style={{ maxWidth: 880 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        免费计算
      </Typography.Title>

      <Steps
        current={step}
        items={[{ title: '上传素材' }, { title: '参数确认' }, { title: '排队与计算' }]}
        style={{ marginBottom: 24 }}
      />

      {step === 0 && (
        <div>
          <Dragger
            multiple
            accept={ACCEPTED_EXTENSIONS.map((ext) => `.${ext}`).join(',')}
            fileList={fileList}
            beforeUpload={beforeUpload}
            customRequest={customRequest}
            onChange={handleChange}
            maxCount={MAX_FILE_COUNT}
            aria-label="上传视频或照片序列"
          >
            <p className="ant-upload-drag-icon">
              <InboxOutlined aria-hidden />
            </p>
            <p className="ant-upload-text">拖入视频或照片序列</p>
            <p className="ant-upload-hint">
              支持 {ACCEPTED_EXTENSIONS.map((e) => e.toUpperCase()).join(' / ')}，单个不超过 1GB，
              最多 {MAX_FILE_COUNT} 个文件。选中后立即开始上传。
            </p>
          </Dragger>

          {isMixed && (
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message="检测到视频与照片混合"
              description="后端以第一个视频作为探测对象、其余照片作为序列参与重建；建议仅上传视频或仅上传照片以获得更稳定的结果。"
            />
          )}

          {uploadRows.length > 0 && (
            <div style={{ marginTop: 16 }}>
              {uploadRows.map((u) => (
                <div key={u.uid} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 4,
                    }}
                  >
                    <Typography.Text>{u.name}</Typography.Text>
                    <Space size={4}>
                      {u.status === 'error' && (
                        <Button size="small" icon={<ReloadOutlined aria-hidden />} onClick={() => retryUpload(u.uid)}>
                          重试
                        </Button>
                      )}
                      <Button size="small" type="text" danger onClick={() => removeUpload(u.uid)}>
                        移除
                      </Button>
                    </Space>
                  </div>
                  <Progress
                    percent={
                      u.status === 'completed'
                        ? 100
                        : u.total > 0
                          ? Math.round((u.sent / u.total) * 100)
                          : 0
                    }
                    status={
                      u.status === 'error' ? 'exception' : u.status === 'completed' ? 'success' : 'active'
                    }
                    format={() =>
                      `${formatBytes(u.sent)} / ${formatBytes(u.total)}  ${formatSpeed(u.speed)}`
                    }
                  />
                  {u.status === 'error' && u.error && (
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>
                      {u.error}
                    </Typography.Text>
                  )}
                </div>
              ))}
            </div>
          )}

          {fileList.length > 0 && (
            <Alert
              style={{ marginTop: 12 }}
              type={allUploaded ? 'success' : 'info'}
              showIcon
              message={
                allUploaded
                  ? `已选择 ${fileList.length} 个文件，全部上传完成`
                  : `已选择 ${fileList.length} 个文件，正在上传…`
              }
            />
          )}
          {rejectedCount > 0 && (
            <Alert
              style={{ marginTop: 12 }}
              type="warning"
              showIcon
              message={`${rejectedCount} 个文件未通过前端初步校验`}
              description="不支持的扩展名或超过大小限制的文件已被忽略。"
            />
          )}

          <div style={{ marginTop: 24 }}>
            <Button type="primary" disabled={!allUploaded} onClick={() => setStep(1)}>
              下一步：参数确认
            </Button>
            {!allUploaded && (
              <span style={{ display: 'block', marginTop: 8, color: 'var(--gs-text-tertiary)', fontSize: 12 }}>
                全部素材上传完成后可进入参数确认。
              </span>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <Space orientation="vertical" size={16} style={{ width: '100%', maxWidth: 360 }}>
            <label>
              <Typography.Text>质量</Typography.Text>
              <Select
                value={quality}
                onChange={setQuality}
                options={profileOptions}
                style={{ width: '100%' }}
                aria-label="质量"
              />
              {selectedProfile && (
                <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                  {selectedProfile.iterations} 次训练迭代 · 最多 {selectedProfile.maxImages} 张照片 /{' '}
                  {selectedProfile.maxVideoSeconds}s 视频 · 素材上限 {formatBytes(selectedProfile.maxInputBytes)}
                </Typography.Text>
              )}
            </label>

            <label>
              <Typography.Text>场景标题</Typography.Text>
              <Input
                value={sceneTitle}
                maxLength={200}
                onChange={(event) => {
                  titleTouched.current = true;
                  setSceneTitle(event.target.value);
                }}
                placeholder="为重建场景命名"
                aria-label="场景标题"
              />
            </label>

            <label>
              <Typography.Text>简介</Typography.Text>
              <Input.TextArea
                rows={3}
                value={description}
                maxLength={500}
                showCount
                onChange={(event) => setDescription(event.target.value)}
                placeholder="场景简介（可选）"
                aria-label="场景简介"
              />
            </label>

            <label>
              <Typography.Text>可见性</Typography.Text>
              <Select
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: 'PRIVATE', label: '私有' },
                  { value: 'UNLISTED', label: '不公开（仅链接可见）' },
                  { value: 'PUBLIC', label: '公开' },
                ]}
                style={{ width: '100%' }}
                aria-label="可见性"
              />
            </label>

            <Checkbox
              checked={rightsChecked}
              onChange={(event) => setRightsChecked(event.target.checked)}
            >
              我拥有素材权利并同意处理规则
            </Checkbox>

            {capabilityProblems.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="计算能力受限"
                description={
                  <ul style={{ margin: 0, paddingLeft: 20 }}>
                    {capabilityProblems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                }
              />
            )}

            <div>
              <Button style={{ marginRight: 12 }} onClick={() => setStep(0)}>
                上一步
              </Button>
              <Button
                type="primary"
                loading={submitting}
                disabled={!rightsChecked || !allUploaded}
                title={submitHint}
                aria-describedby="compute-submit-hint"
                onClick={() => void handleSubmit()}
              >
                提交计算
              </Button>
              <span
                id="compute-submit-hint"
                style={{ display: 'block', marginTop: 8, color: 'var(--gs-text-tertiary)', fontSize: 12 }}
              >
                {submitHint}
              </span>
            </div>
          </Space>
        </div>
      )}

      {step === 2 && (
        <div>
          {job && (
            <Space orientation="vertical" size={16} style={{ width: '100%', maxWidth: 480 }}>
              <Space>
                <Badge
                  status={statusMeta?.badge ?? 'processing'}
                  text={statusMeta?.text ?? job.status}
                />
                {stageLabel && <Typography.Text strong>{stageLabel}</Typography.Text>}
              </Space>

              {isTraining ? (
                <Space>
                  <Spin size="small" />
                  <Typography.Text type="secondary">训练中，无精确百分比</Typography.Text>
                </Space>
              ) : (
                <Progress
                  percent={job.progress}
                  status={job.status === 'FAILED' ? 'exception' : job.status === 'SUCCEEDED' ? 'success' : 'active'}
                />
              )}

              {!terminal && (
                <div>
                  <Button style={{ marginRight: 12 }} onClick={() => setStep(1)}>
                    上一步
                  </Button>
                  <Button danger onClick={confirmCancel}>
                    取消任务
                  </Button>
                </div>
              )}

              {job.status === 'SUCCEEDED' && (
                <Alert
                  type="success"
                  showIcon
                  message="重建成功"
                  description={
                    job.sceneId
                      ? `场景已发布（${job.sceneId}），可以查看重建结果。`
                      : '场景已发布，可在「我的作品」中查看。'
                  }
                  action={
                    job.sceneId ? (
                      <Button type="primary" onClick={goToScene}>
                        查看重建场景
                      </Button>
                    ) : undefined
                  }
                />
              )}

              {job.status === 'FAILED' && (
                <Alert
                  type="error"
                  showIcon
                  message="重建失败"
                  description={
                    job.errorMessage
                      ? `${job.errorCode ? `[${job.errorCode}] ` : ''}${job.errorMessage}`
                      : '服务端重建失败，请重试或联系管理员。'
                  }
                />
              )}

              {job.status === 'CANCELLED' && (
                <Alert type="info" showIcon message="任务已取消" description="本次重建已取消，已上传的素材仍保留。" />
              )}
            </Space>
          )}
        </div>
      )}
    </section>
  );
}
