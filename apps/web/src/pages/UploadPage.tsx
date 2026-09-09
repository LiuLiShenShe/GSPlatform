import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import { CloudUploadOutlined, PictureOutlined, UploadOutlined } from '@ant-design/icons';
import { App } from 'antd';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { useObjectUrlPool } from '../hooks/useObjectUrls';
import type { UploadFile, UploadProps } from 'antd';

const { Dragger } = Upload;

const DRAFT_KEY = 'gsplatform.upload.draft';
const SCENE_ACCEPT = '.sog,.ply,.splat,.splat.gz';
const CATEGORY_OPTIONS = ['城市', '建筑', '室内', '自然', '人物', '实验'];

interface UploadFormValues {
  title: string;
  description?: string;
  sceneFile?: UploadFile[];
  poster?: UploadFile[];
  category: string;
  visibility: '公开' | '私有';
}

interface DraftPayload {
  savedAt: string;
  title: string;
  description: string;
  category: string;
  visibility: '公开' | '私有';
  sceneFileName: string;
  posterName: string;
}

const normFile = (
  event: { fileList: UploadFile[] } | UploadFile[],
): UploadFile[] => (Array.isArray(event) ? event : event?.fileList ?? []);

/**
 * 上传作品页：标题/简介/场景文件/Poster/分类/可见性。
 * 表单错误与字段关联；支持本地草稿（localStorage，不宣称已上传）；
 * 发布按钮在 Phase 06 前明确禁用；所选文件的 Object URL 在替换或卸载时释放。
 */
export default function UploadPage() {
  useDocumentTitle('上传作品');
  const [form] = Form.useForm<UploadFormValues>();
  const { message } = App.useApp();
  const { ensure, retain, keyOf } = useObjectUrlPool();

  const [draft, setDraft] = useState<DraftPayload | null>(null);
  const [posterPreviewUrl, setPosterPreviewUrl] = useState<string | null>(null);

  // 读取本地草稿
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) {
        setDraft(JSON.parse(raw) as DraftPayload);
      }
    } catch {
      setDraft(null);
    }
  }, []);

  const sceneFile = Form.useWatch('sceneFile', form) ?? [];
  const poster = Form.useWatch('poster', form) ?? [];

  // 释放被替换文件的 Object URL
  const currentKeys = useMemo(
    () =>
      [...sceneFile, ...poster]
        .map((file) => (file.originFileObj ? keyOf(file.originFileObj) : null))
        .filter((key): key is string => key != null),
    [sceneFile, poster, keyOf],
  );
  useEffect(() => {
    retain(currentKeys);
  }, [currentKeys, retain]);

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
    if (file.size > 1024 * 1024 * 1024) {
      message.error(`${file.name} 超过 1GB 大小限制`);
      return Upload.LIST_IGNORE;
    }
    return false; // 不真正上传，仅收集文件用于表单校验
  };

  const saveDraft = (): void => {
    const values = form.getFieldsValue();
    const payload: DraftPayload = {
      savedAt: new Date().toISOString(),
      title: values.title ?? '',
      description: values.description ?? '',
      category: values.category ?? '',
      visibility: values.visibility ?? '公开',
      sceneFileName: values.sceneFile?.[0]?.name ?? '',
      posterName: values.poster?.[0]?.name ?? '',
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
    setDraft(payload);
    message.success('已保存到本地草稿（尚未上传到服务器）。');
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
    if (!preview) {
      message.info('尚未选择 Poster 文件。');
      return;
    }
    setPosterPreviewUrl(preview);
  };

  return (
    <section aria-label="上传作品" style={{ maxWidth: 720 }}>
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        上传作品
      </Typography.Title>

      {draft && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`存在本地草稿（保存于 ${new Date(draft.savedAt).toLocaleString()}）`}
          description="草稿仅保存在本浏览器，尚未上传到服务器。"
          action={
            <Button size="small" onClick={restoreDraft}>
              恢复草稿
            </Button>
          }
        />
      )}

      <Form form={form} layout="vertical" requiredMark="optional">
        <Form.Item
          name="title"
          label="作品标题"
          rules={[
            { required: true, message: '请输入作品标题' },
            { max: 80, message: '标题不超过 80 字' },
          ]}
        >
          <Input placeholder="作品标题" aria-label="作品标题" maxLength={80} />
        </Form.Item>

        <Form.Item
          name="description"
          label="简介"
          rules={[{ max: 500, message: '简介不超过 500 字' }]}
        >
          <Input.TextArea
            rows={3}
            placeholder="作品简介（可选）"
            aria-label="简介"
            maxLength={500}
            showCount
          />
        </Form.Item>

        <Form.Item
          name="sceneFile"
          label="场景文件"
          valuePropName="fileList"
          getValueFromEvent={normFile}
          rules={[{ required: true, message: '请选择场景文件' }]}
        >
          <Dragger
            multiple={false}
            maxCount={1}
            accept={SCENE_ACCEPT}
            beforeUpload={beforeUpload}
            onChange={handleChange('sceneFile')}
            aria-label="选择场景文件"
          >
            <p className="ant-upload-drag-icon">
              <CloudUploadOutlined aria-hidden />
            </p>
            <p className="ant-upload-text">选择 SOG / 支持清单内的格式</p>
            <p className="ant-upload-hint">当前支持 .sog / .ply / .splat，单个不超过 1GB</p>
          </Dragger>
        </Form.Item>

        <Form.Item name="poster" label="Poster" valuePropName="fileList" getValueFromEvent={normFile}>
          <Upload
            listType="picture"
            maxCount={1}
            accept="image/*"
            beforeUpload={beforeUpload}
            onChange={handleChange('poster')}
          >
            <Button icon={<PictureOutlined aria-hidden />}>选择文件</Button>
            <Button type="link" onClick={openPosterPreview}>
              预览
            </Button>
          </Upload>
        </Form.Item>

        <Form.Item
          name="category"
          label="分类"
          rules={[{ required: true, message: '请选择分类' }]}
        >
          <Select
            placeholder="选择分类"
            aria-label="分类"
            options={CATEGORY_OPTIONS.map((value) => ({ value, label: value }))}
          />
        </Form.Item>

        <Form.Item
          name="visibility"
          label="可见性"
          initialValue="公开"
          rules={[{ required: true, message: '请选择可见性' }]}
        >
          <Radio.Group aria-label="可见性">
            <Radio value="公开">公开</Radio>
            <Radio value="私有">私有</Radio>
          </Radio.Group>
        </Form.Item>

        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <Button onClick={saveDraft}>保存草稿</Button>
          <Tooltip title="发布将在 Phase 06 接入（校验、上传存储与原子发布）">
            <span>
              <Button type="primary" disabled icon={<UploadOutlined aria-hidden />}>
                校验并发布
              </Button>
            </span>
          </Tooltip>
          {draft && (
            <Button danger onClick={clearDraft}>
              清除草稿
            </Button>
          )}
        </div>
      </Form>

      <Modal
        open={posterPreviewUrl != null}
        title="Poster 预览"
        onCancel={() => setPosterPreviewUrl(null)}
        footer={null}
      >
        {posterPreviewUrl && (
          <img
            src={posterPreviewUrl}
            alt="Poster 预览"
            style={{ width: '100%', borderRadius: 8 }}
          />
        )}
      </Modal>
    </section>
  );
}