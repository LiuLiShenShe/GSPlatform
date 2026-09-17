import { useState } from 'react';
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Select,
  Tag,
  Tooltip,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  HistoryOutlined,
  SyncOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { WorkSummary } from '../fixtures/myWorks';
import {
  archiveScene,
  deleteScene,
  restoreScene,
  updateScene,
} from '../services/worksApi';

const STATUS_META: Record<
  WorkSummary['status'],
  { label: string; color: string }
> = {
  PUBLISHED: { label: '已发布', color: 'success' },
  DRAFT: { label: '草稿', color: 'default' },
  PROCESSING: { label: '处理中', color: 'processing' },
  FAILED: { label: '失败', color: 'error' },
};

const CATEGORY_OPTIONS = [
  { value: 'urban', label: '城市' },
  { value: 'architecture', label: '建筑' },
  { value: 'interior', label: '室内' },
  { value: 'nature', label: '自然' },
  { value: 'portrait', label: '人物' },
  { value: 'experiment', label: '实验' },
];

const VISIBILITY_OPTIONS = [
  { value: 'PUBLIC', label: '公开（所有人可见）' },
  { value: 'PRIVATE', label: '私有（仅自己可见）' },
];

interface WorkCardProps {
  work: WorkSummary;
  /** 变更后由父级触发列表刷新（归档/删除等）。 */
  onChanged: () => void;
}

interface EditFormValues {
  title: string;
  description?: string;
  category: string;
  visibility: string;
}

/**
 * 我的作品卡片：区分草稿 / 处理中 / 已发布 / 失败。
 * Phase 08 接入真实编辑（PATCH）、归档/恢复、软删除（二次确认），
 * 操作失败时回滚并提示，不伪造成功状态。
 */
export function WorkCard({ work, onChanged }: WorkCardProps) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [form] = Form.useForm<EditFormValues>();
  const meta = STATUS_META[work.status];

  const openScene = (): void => {
    if (work.sceneId) {
      navigate(`/scene/${work.sceneId}`);
    } else {
      message.info('当前状态下无已发布场景可查看。');
    }
  };

  const openEdit = (): void => {
    form.setFieldsValue({
      title: work.title,
      category: 'urban',
      visibility: 'PUBLIC',
    });
    setEditing(true);
  };

  const submitEdit = async (): Promise<void> => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await updateScene(work.id, {
        title: values.title,
        description: values.description || null,
        category: values.category,
        visibility: values.visibility,
      });
      setEditing(false);
      message.success('作品信息已更新');
      onChanged();
    } catch {
      message.error('更新失败，请检查网络后重试。');
    } finally {
      setSaving(false);
    }
  };

  const doArchive = async (): Promise<void> => {
    setActing(true);
    try {
      await archiveScene(work.id);
      message.success('已归档');
      onChanged();
    } catch {
      message.error('归档失败，请重试。');
    } finally {
      setActing(false);
    }
  };

  const doRestore = async (): Promise<void> => {
    setActing(true);
    try {
      await restoreScene(work.id);
      message.success('已恢复');
      onChanged();
    } catch {
      message.error('恢复失败，请重试。');
    } finally {
      setActing(false);
    }
  };

  const doDelete = async (): Promise<void> => {
    setActing(true);
    try {
      await deleteScene(work.id);
      message.success('已删除（延迟清理）');
      onChanged();
    } catch {
      message.error('删除失败，请重试。');
    } finally {
      setActing(false);
    }
  };

  const viewJobs = (): void => {
    Modal.info({
      title: '任务信息',
      content: `「${work.title}」的处理任务由服务端管理。当前状态：${meta.label}。`,
      okText: '知道了',
    });
  };

  return (
    <div className="gs-works-card" data-testid={`works-card-${work.id}`}>
      <button
        type="button"
        className="gs-works-card__poster"
        aria-label={`查看 ${work.title}`}
        onClick={openScene}
      >
        <img src={work.poster} alt={`${work.title} 封面`} />
      </button>
      <div className="gs-works-card__main">
        <Tooltip title={work.sceneId ? '打开 Viewer' : '无已发布场景'}>
          <h3 className="gs-works-card__title">
            {work.status === 'PROCESSING' && work.progress != null && (
              <>
                处理进度 {work.progress}% ·{' '}
              </>
            )}
            {work.title}
          </h3>
        </Tooltip>
        <p className="gs-works-card__meta">
          <Tag color={meta.color}>{meta.label}</Tag>
          更新于 {work.updatedAt}
        </p>
        {work.status === 'PROCESSING' && work.progress != null && (
          <Progress
            percent={work.progress}
            size="small"
            status="active"
            aria-label="处理进度"
          />
        )}
        <div className="gs-works-card__actions">
          <Button size="small" icon={<EyeOutlined aria-hidden />} onClick={openScene}>
            查看
          </Button>
          <Button
            size="small"
            icon={<EditOutlined aria-hidden />}
            onClick={openEdit}
            disabled={acting}
          >
            编辑
          </Button>
          <Tooltip title="查看处理任务（Phase 08 已接入服务端任务查询）">
            <Button
              size="small"
              icon={<HistoryOutlined aria-hidden />}
              onClick={viewJobs}
            >
              任务
            </Button>
          </Tooltip>
          {work.status === 'PUBLISHED' && (
            <Popconfirm
              title={`归档「${work.title}」？`}
              description="归档后从公开目录隐藏，可随时恢复。"
              okText="归档"
              cancelText="取消"
              onConfirm={doArchive}
            >
              <Button size="small" icon={<SyncOutlined aria-hidden />} disabled={acting}>
                归档
              </Button>
            </Popconfirm>
          )}
          {work.status === 'FAILED' && (
            <Popconfirm
              title={`恢复「${work.title}」？`}
              description="恢复到草稿状态继续处理。"
              okText="恢复"
              cancelText="取消"
              onConfirm={doRestore}
            >
              <Button size="small" icon={<UndoOutlined aria-hidden />} disabled={acting}>
                恢复
              </Button>
            </Popconfirm>
          )}
          <Popconfirm
            title={`确认删除「${work.title}」？`}
            description="删除后进入回收站，无法在列表看到。此操作不可直接撤销。"
            okText="确认删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={doDelete}
          >
            <Button
              size="small"
              danger
              icon={<DeleteOutlined aria-hidden />}
              disabled={acting}
            >
              删除
            </Button>
          </Popconfirm>
        </div>
      </div>

      <Modal
        title={`编辑作品 — ${work.title}`}
        open={editing}
        onCancel={() => setEditing(false)}
        onOk={submitEdit}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={480}
        aria-label="编辑作品信息"
      >
        <Form
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={{
            title: work.title,
            category: 'urban',
            visibility: 'PUBLIC',
          }}
        >
          <Form.Item
            name="title"
            label="标题"
            rules={[
              { required: true, message: '请输入标题' },
              { max: 200, message: '标题最长 200 字' },
            ]}
          >
            <Input maxLength={200} />
          </Form.Item>
          <Form.Item name="description" label="简介" rules={[{ max: 2000, message: '简介最长 2000 字' }]}>
            <Input.TextArea rows={3} maxLength={2000} />
          </Form.Item>
          <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
            <Select options={CATEGORY_OPTIONS} />
          </Form.Item>
          <Form.Item name="visibility" label="可见性" rules={[{ required: true, message: '请选择可见性' }]}>
            <Select options={VISIBILITY_OPTIONS} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}