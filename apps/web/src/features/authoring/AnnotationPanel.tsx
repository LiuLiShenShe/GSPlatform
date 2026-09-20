/**
 * AnnotationPanel — manage 3D spatial annotations for a scene.
 *
 * Lists all annotations with reorder/toggle/delete controls. Provides a
 * "pick from viewer" action that tells the viewer to enter annotation-pick
 * mode (double-click → world position → create annotation).
 */
import { useCallback, useState } from 'react';
import { Card, List, Button, Tag, Popconfirm, InputNumber, Select, Input, Space, Typography } from 'antd';
import {
  PlusOutlined,
  DeleteOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  DragOutlined,
} from '@ant-design/icons';
import type { SceneAnnotation, AnnotationStyle } from '../../services/annotationApi';

const { Text } = Typography;

interface AnnotationPanelProps {
  annotations: SceneAnnotation[];
  picking: boolean;
  onCreate: (anchorX: number, anchorY: number, anchorZ: number) => void;
  onUpdate: (id: string, patch: Partial<SceneAnnotation>) => void;
  onDelete: (id: string) => void;
  onPickFromViewer: () => void;
  onCancelPick: () => void;
}

const STYLE_LABELS: Record<AnnotationStyle, string> = {
  LEADER_TEXT: '线段文字',
  NUMBER_POPUP: '数字热点',
  HIDDEN: '隐藏标记',
};

export function AnnotationPanel({
  annotations,
  picking,
  onCreate,
  onUpdate,
  onDelete,
  onPickFromViewer,
  onCancelPick,
}: AnnotationPanelProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editText, setEditText] = useState('');

  const startEdit = useCallback((ann: SceneAnnotation) => {
    setEditingId(ann.id);
    setEditTitle(ann.title);
    setEditText(ann.textContent);
  }, []);

  const saveEdit = useCallback(() => {
    if (!editingId) return;
    onUpdate(editingId, { title: editTitle, textContent: editText });
    setEditingId(null);
  }, [editingId, editTitle, editText, onUpdate]);

  return (
    <Card
      title="空间注解"
      size="small"
      style={{ marginBottom: 8 }}
      extra={
        picking ? (
          <Space>
            <Tag color="processing">双击场景拾取位置…</Tag>
            <Button size="small" onClick={onCancelPick}>取消</Button>
          </Space>
        ) : (
          <Button size="small" icon={<PlusOutlined />} onClick={onPickFromViewer}>
            添加注解
          </Button>
        )
      }
    >
      <List
        dataSource={annotations}
        locale={{ emptyText: '暂无注解' }}
        size="small"
        renderItem={(ann) => (
          <List.Item
            key={ann.id}
            style={{ padding: '4px 0' }}
            actions={[
              <Button
                key="toggle"
                type="text"
                size="small"
                icon={ann.enabled ? <EyeOutlined /> : <EyeInvisibleOutlined />}
                onClick={() => onUpdate(ann.id, { enabled: !ann.enabled })}
              />,
              <Popconfirm
                key="delete"
                title="确定删除此注解？"
                onConfirm={() => onDelete(ann.id)}
              >
                <Button type="text" size="small" danger icon={<DeleteOutlined />} />
              </Popconfirm>,
            ]}
          >
            <List.Item.Meta
              title={
                editingId === ann.id ? (
                  <Space>
                    <Input
                      size="small"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      style={{ width: 120 }}
                    />
                    <Button size="small" onClick={saveEdit}>保存</Button>
                  </Space>
                ) : (
                  <Text
                    ellipsis
                    style={{ cursor: 'pointer' }}
                    onClick={() => startEdit(ann)}
                  >
                    {ann.title || '(未命名)'}
                  </Text>
                )
              }
              description={
                <Space size={4}>
                  <Tag>{STYLE_LABELS[ann.style] ?? ann.style}</Tag>
                  <Tag>{ann.contentType}</Tag>
                  {editingId === ann.id && (
                    <Input
                      size="small"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      placeholder="文本内容"
                      style={{ width: 140 }}
                    />
                  )}
                </Space>
              }
            />
          </List.Item>
        )}
      />
    </Card>
  );
}
