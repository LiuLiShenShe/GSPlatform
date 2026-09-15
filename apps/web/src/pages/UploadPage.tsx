import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
  Upload,
} from 'antd';
import {
  CloudUploadOutlined,
  PictureOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { App } from 'antd';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { useObjectUrlPool } from '../hooks/useObjectUrls';
import type { UploadFile, UploadProps } from 'antd';
import { ResumableUploader, createUploadSession } from '../features/upload/ResumableUploader';
import type { UploadEvent } from '../features/upload/ResumableUploader';
import { UploadProgress } from '../features/upload/UploadProgress';
import { ProcessingStatus } from '../features/upload/ProcessingStatus';

const { Dragger } = Upload;

const DRAFT_KEY = 'gsplatform.upload.draft';
const SCENE_ACCEPT = '.sog,.ply,.splat,.splat.gz,.zip';
const CATEGORY_OPTIONS = [
  { value: 'urban',       label: '城市' },
  { value: 'architecture', label: '建筑' },
  { value: 'interior',    label: '室内' },
  { value: 'nature',      label: '自然' },
  { value: 'portrait',    label: '人物' },
  { value: 'experiment',  label: '实验' },
];
const FORMAT_MAP: Record<string, string> = {
  '.sog': 'sog', '.ply': 'ply', '.splat': 'splat', '.zip': 'zip',
};

interface UploadFormValues {
  title: string;
  description?: string;
  sceneFile?: UploadFile[];
  poster?: UploadFile[];
  category: string;
  visibility: 'PUBLIC' | 'PRIVATE';
}

interface DraftPayload {
  savedAt: string;
  title: string;
  description: string;
  category: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  sceneFileName: string;
  posterName: string;
}

type Phase =
  | 'form'
  | 'uploading'
  | 'processing'
  | 'done'
  | 'error';

const normFile = (
  event: { fileList: UploadFile[] } | UploadFile[],
): UploadFile[] => (Array.isArray(event) ? event : event?.fileList ?? []);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/**
 * UploadPage — Phase 06 real upload experience.
 * Form → session create → chunked upload with resume → server processing → Done.
 */
export default function UploadPage() {
  useDocumentTitle('上传作品');
  const [form] = Form.useForm<UploadFormValues>();
  const { message, notification: _notification } = App.useApp();
  void _notification;
  const { ensure, retain, keyOf } = useObjectUrlPool();

  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [posterPreviewUrl, setPosterPreviewUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [uploadSent, setUploadSent] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadSpeed, setUploadSpeed] = useState(0);
  const [uploadPaused, setUploadPaused] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('CREATED');
  const [processingStatus, setProcessingStatus] = useState('QUEUED');
  const [jobId, setJobId] = useState<string | null>(null);
  const [currentUploadId, setCurrentUploadId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const uploaderRef = useRef<ResumableUploader | null>(null);

  // Form snapshots
  const sceneFile = Form.useWatch('sceneFile', form) ?? [];
  const poster = Form.useWatch('poster', form) ?? [];

  // Release replaced object URLs
  const currentKeys = useMemo(
    () =>
      [...sceneFile, ...poster]
        .map((file) => (file.originFileObj ? keyOf(file.originFileObj) : null))
        .filter((key): key is string => key != null),
    [sceneFile, poster, keyOf],
  );
  useEffect(() => { retain(currentKeys); }, [currentKeys, retain]);

  const withThumbUrl = (files: UploadFile[]): UploadFile[] =>
    files.map((file) => {
      if (file.originFileObj && !file.thumbUrl) {
        return { ...file, thumbUrl: ensure(file.originFileObj) };
      }
      return file;
    });

  const handleChange =
    (field: 'sceneFile' | 'poster'): UploadProps['onChange'] =>
    ({ fileList }) => {
      const normalized = fileList.map((file) => ({ ...file, status: 'done' as const }));
      form.setFieldValue(field, withThumbUrl(normalized));
    };

  const beforeUpload: UploadProps['beforeUpload'] = (file) => {
    if (file.size > 5 * 1024 * 1024 * 1024) {
      message.error(`${file.name} 超过 5GB 大小限制`);
      return Upload.LIST_IGNORE;
    }
    return false;
  };

  const saveDraft = (): void => {
    const values = form.getFieldsValue();
    const payload: DraftPayload = {
      savedAt: new Date().toISOString(),
      title: values.title ?? '',
      description: values.description ?? '',
      category: values.category ?? '',
      visibility: values.visibility ?? 'PUBLIC',
      sceneFileName: values.sceneFile?.[0]?.name ?? '',
      posterName: values.poster?.[0]?.name ?? '',
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    setDraft(payload);
    message.success('已保存到本地草稿。');
  };

  const restoreDraft = (): void => {
    if (!draft) return;
    form.setFieldsValue({
      title: draft.title,
      description: draft.description,
      category: draft.category,
      visibility: draft.visibility,
    });
    message.info('已从本地草稿恢复表单内容。');
  };

  const clearDraft = (): void => {
    localStorage.removeItem(DRAFT_KEY);
    setDraft(null);
    message.info('已清除本地草稿。');
  };

  const openPosterPreview = (): void => {
    const preview = poster.find((file) => file.thumbUrl)?.thumbUrl ?? null;
    if (!preview) { message.info('尚未选择 Poster 文件。'); return; }
    setPosterPreviewUrl(preview);
  };

  // ── Real upload flow ──────────────────────────────────────────────────────
  const startUpload = async (): Promise<void> => {
    try {
      await form.validateFields(['title', 'sceneFile', 'category', 'visibility']);
    } catch {
      return; // validation error shown by Ant Design form
    }

    const fileObj = sceneFile[0]?.originFileObj as File | undefined;
    if (!fileObj) { message.error('请选择场景文件'); return; }

    const values = form.getFieldsValue();
    const format = FORMAT_MAP[extOf(fileObj.name)] ?? extOf(fileObj.name).slice(1);

    setPhase('uploading');
    setUploadSent(0);
    setUploadTotal(fileObj.size);
    setUploadSpeed(0);
    setUploadPaused(false);
    setErrorMsg(null);

    try {
      const session = await createUploadSession({
        filename: fileObj.name,
        mime_type: fileObj.type || 'application/octet-stream',
        size: fileObj.size,
        format,
        title: values.title,
        description: values.description,
        visibility: values.visibility,
        category: values.category,
      });

      setUploadStatus(session.status);

      const uploader = new ResumableUploader(fileObj, session, handleUploadEvent);
      uploaderRef.current = uploader;
      await uploader.run();
    } catch (error) {
      if ((error as Error)?.name === 'UploadCancelledError') {
        setPhase('form');
        return;
      }
      const msg =
        (error as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        (error as Error)?.message ??
        '上传失败';
      setErrorMsg(msg);
      setPhase('error');
    }
  };

  const handleUploadEvent = (e: UploadEvent): void => {
    switch (e.type) {
      case 'progress':
        setUploadSent(e.sent);
        setUploadTotal(e.total);
        setUploadSpeed(e.speed);
        break;
      case 'paused':
        setUploadPaused(true);
        break;
      case 'resumed':
        setUploadPaused(false);
        setUploadSent(e.offset);
        setUploadTotal(e.total);
        break;
      case 'completed':
        setCurrentUploadId(e.result.uploadId);
        setJobId(e.result.jobId);
        setProcessingStatus('QUEUED');
        setPhase('processing');
        break;
      case 'error':
        setErrorMsg(e.message);
        setPhase('error');
        break;
    }
  };

  const startProcessingPoll = (uploadId: string): void => {
    let stopped = false;
    const poll = async (): Promise<void> => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
          const resp = await import('../services/http').then((m) =>
            m.httpClient.head(`/uploads/${uploadId}`),
          );
          const st = (resp.headers as Record<string, string>)['upload-status'] ?? '';
          setProcessingStatus(st);
          if (st === 'SUCCEEDED' || st === 'FAILED') { stopped = true; }
        } catch {
          // ignore poll errors
        }
      }
    };
    void poll();
  };

  // Auto-start polling when phase transitions to processing.
  useEffect(() => {
    if (phase === 'processing' && currentUploadId) {
      startProcessingPoll(currentUploadId);
    }
  }, [phase, currentUploadId]);

  const pause = (): void => { uploaderRef.current?.pause(); setUploadPaused(true); };
  const resume = (): void => { uploaderRef.current?.resume(); setUploadPaused(false); };
  const cancelUpload = async (): Promise<void> => { await uploaderRef.current?.cancel(); setPhase('form'); };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <section aria-label="上传作品" style={{ maxWidth: 720 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        上传作品
      </Typography.Title>

      {draft && phase === 'form' && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`存在本地草稿（保存于 ${new Date(draft.savedAt).toLocaleString()}）`}
          description="草稿仅保存在本浏览器，尚未上传到服务器。"
          action={<Button size="small" onClick={restoreDraft}>恢复草稿</Button>}
        />
      )}

      {phase === 'form' && (
        <Form form={form} layout="vertical" requiredMark="optional">
          <Form.Item name="title" label="作品标题" rules={[
            { required: true, message: '请输入作品标题' },
            { max: 80, message: '标题不超过 80 字' },
          ]}>
            <Input placeholder="作品标题" aria-label="作品标题" maxLength={80} />
          </Form.Item>
          <Form.Item name="description" label="简介" rules={[{ max: 500, message: '简介不超过 500 字' }]}>
            <Input.TextArea rows={3} placeholder="作品简介（可选）" aria-label="简介" maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="sceneFile" label="场景文件" valuePropName="fileList" getValueFromEvent={normFile}
            rules={[{ required: true, message: '请选择场景文件' }]}>
            <Dragger multiple={false} maxCount={1} accept={SCENE_ACCEPT}
              beforeUpload={beforeUpload} onChange={handleChange('sceneFile')} aria-label="选择场景文件">
              <p className="ant-upload-drag-icon"><CloudUploadOutlined aria-hidden /></p>
              <p className="ant-upload-text">选择 SOG / PLY / SPLAT / ZIP 场景文件</p>
              <p className="ant-upload-hint">支持 .sog / .ply / .splat / .zip，单个不超过 5GB</p>
            </Dragger>
          </Form.Item>
          <Form.Item name="poster" label="Poster" valuePropName="fileList" getValueFromEvent={normFile}>
            <Upload listType="picture" maxCount={1} accept="image/*"
              beforeUpload={beforeUpload} onChange={handleChange('poster')}>
              <Button icon={<PictureOutlined aria-hidden />}>选择文件</Button>
              <Button type="link" onClick={openPosterPreview}>预览</Button>
            </Upload>
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
            <Select placeholder="选择分类" aria-label="分类" options={CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item name="visibility" label="可见性" initialValue="PUBLIC" rules={[{ required: true, message: '请选择可见性' }]}>
            <Radio.Group aria-label="可见性">
              <Radio value="PUBLIC">公开</Radio>
              <Radio value="PRIVATE">私有</Radio>
            </Radio.Group>
          </Form.Item>
          <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
            <Button onClick={saveDraft}>保存草稿</Button>
            <Button type="primary" icon={<UploadOutlined aria-hidden />} onClick={startUpload}>
              校验并发布
            </Button>
            {draft && <Button danger onClick={clearDraft}>清除草稿</Button>}
          </div>
        </Form>
      )}

      {phase === 'uploading' && (
        <div>
          <Typography.Paragraph>正在上传…</Typography.Paragraph>
          <UploadProgress
            sent={uploadSent}
            total={uploadTotal}
            speed={uploadSpeed}
            status={uploadStatus}
            paused={uploadPaused}
            onPause={pause}
            onResume={resume}
          />
          <Button danger onClick={cancelUpload} style={{ marginTop: 16 }}>取消上传</Button>
        </div>
      )}

      {phase === 'processing' && (
        <div>
          <Typography.Paragraph>文件上传完成，服务端正在处理…</Typography.Paragraph>
          <ProcessingStatus status={processingStatus} jobId={jobId} />
          {processingStatus === 'SUCCEEDED' && (
            <Button type="primary" href="/works" style={{ marginTop: 16 }}>
              前往「我的作品」
            </Button>
          )}
        </div>
      )}

      {phase === 'error' && (
        <Alert
          type="error"
          showIcon
          message="上传失败"
          description={errorMsg ?? '发生未知错误'}
          action={
            <Space>
              <Button onClick={() => setPhase('form')}>返回表单</Button>
              <Button type="primary" onClick={() => { setPhase('form'); void startUpload(); }}>
                重新上传
              </Button>
            </Space>
          }
        />
      )}

      <Modal
        open={posterPreviewUrl != null}
        title="Poster 预览"
        onCancel={() => setPosterPreviewUrl(null)}
        footer={null}
      >
        {posterPreviewUrl && (
          <img src={posterPreviewUrl} alt="Poster 预览" style={{ width: '100%', borderRadius: 8 }} />
        )}
      </Modal>
    </section>
  );
}
