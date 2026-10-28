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
  AppstoreOutlined,
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
  // GS-NEXT-10：归档与回收站都是**可恢复**状态，必须有恢复入口。
  ARCHIVED: { label: '已归档', color: 'warning' },
  DELETED: { label: '回收站', color: 'default' },
};

/** 可以恢复的状态：已归档（回到归档前状态）与回收站（清除软删除标记）。 */
const RESTORABLE: ReadonlySet<WorkSummary['status']> = new Set(['ARCHIVED', 'DELETED']);

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

  /**
   * 打开 3D 场景编辑器（/model/edit/:sceneId）—— 与「编辑」作品信息弹窗区分：
   * 这里直接进入标注 / 视角 / 相机等场景内容的编辑，不需要重新上传。
   * 没有已发布场景的作品（草稿 / 处理中 / 失败）如实提示，不给死按钮链接。
   */
  const openSceneEditor = (): void => {
    if (work.sceneId) {
      navigate(`/model/edit/${work.sceneId}`);
    } else {
      message.info('当前状态下无已发布场景可编辑。');
    }
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
      const result = await restoreScene(work.id);
      // GS-NEXT-11：恢复是**两步**语义（删除/归档是两个状态位），提示必须如实。
      if (result.stillArchived) {
        message.success('已从回收站恢复；作品仍处于「已归档」状态，请再点一次「恢复」解除归档。');
      } else if (result.legacy) {
        message.success('已恢复为「待发布」状态（该作品为历史归档数据，无法确认归档前是否已公开）；确认无误后请重新发布。');
      } else if (result.fromRecycleBin) {
        message.success('已从回收站恢复，作品与资产都还在');
      } else {
        message.success('已恢复到归档前的状态，作品会重新出现在列表里');
      }
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
      // GS-NEXT-10：只做软删除（进回收站），不承诺任何清除动作。
      message.success('已移入回收站，可随时恢复');
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
          {/* GS-NEXT-10：回收站作品只能「恢复」。查看/编辑会打到 404 的已删除
             场景（detail/PATCH 均按 deleted_at 过滤），不给用户死按钮。 */}
          {work.status !== 'DELETED' && (
            <>
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
              <Tooltip title="进入 3D 场景编辑器（标注 / 视角 / 相机，无需重新上传）">
                <Button
                  size="small"
                  icon={<AppstoreOutlined aria-hidden />}
                  onClick={openSceneEditor}
                  disabled={acting}
                  data-testid={`works-scene-edit-${work.id}`}
                >
                  场景编辑
                </Button>
              </Tooltip>
              <Tooltip title="查看处理任务（Phase 08 已接入服务端任务查询）">
                <Button
                  size="small"
                  icon={<HistoryOutlined aria-hidden />}
                  onClick={viewJobs}
                >
                  任务
                </Button>
              </Tooltip>
            </>
          )}
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
          {RESTORABLE.has(work.status) && (
            <Popconfirm
              title={`恢复「${work.title}」？`}
              description={
                work.status === 'DELETED'
                  ? '从回收站恢复到删除前的状态，作品与资产都还在。若作品同时处于归档状态，恢复后仍需再点一次「恢复」解除归档。'
                  : '恢复到归档前的状态，作品会重新出现在列表里。'
              }
              okText="恢复"
              cancelText="取消"
              onConfirm={doRestore}
            >
              <Button
                size="small"
                icon={<UndoOutlined aria-hidden />}
                disabled={acting}
                data-testid={`works-restore-${work.id}`}
              >
                恢复
              </Button>
            </Popconfirm>
          )}
          {work.status !== 'DELETED' && (
            <Popconfirm
              title={`确认删除「${work.title}」？`}
              description="删除后进入回收站，可在「回收站」标签页恢复。"
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
          )}
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