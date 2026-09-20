/**
 * ViewpointPanel — list, create, delete, rename, reorder viewpoints.
 */
import { useCallback, useState } from 'react';
import { Button, Input, List, Popconfirm, Space, Typography, Tag } from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  CameraOutlined,
  EyeInvisibleOutlined,
} from '@ant-design/icons';
import type { SceneViewpoint } from '../../services/presentationApi';
import type { ViewerCameraPose } from '@gsplatform/viewer';

const { Text } = Typography;

interface Props {
  viewpoints: SceneViewpoint[];
  activeViewpointId: string | null;
  onAdd: (name: string, pose: ViewerCameraPose) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onToggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  onSetActive: (id: string | null) => void;
  onGetCurrentPose: () => Promise<ViewerCameraPose | null>;
  onNavigateToViewpoint: (vp: SceneViewpoint) => void;
}

export function ViewpointPanel({
  viewpoints,
  activeViewpointId,
  onAdd,
  onDelete,
  onRename,
  onToggleEnabled,
  onSetActive,
  onGetCurrentPose,
  onNavigateToViewpoint,
}: Props) {
  const [newName, setNewName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleAdd = useCallback(async () => {
    const pose = await onGetCurrentPose();
    if (!pose) return;
    const name = newName.trim() || `视角 ${viewpoints.length + 1}`;
    await onAdd(name, pose);
    setNewName('');
  }, [newName, viewpoints.length, onAdd, onGetCurrentPose]);

  const handleRename = useCallback(
    async (id: string) => {
      if (editName.trim()) {
        await onRename(id, editName.trim());
      }
      setEditingId(null);
      setEditName('');
    },
    [editName, onRename],
  );

  return (
    <div className="authoring-panel">
      <Space style={{ marginBottom: 8 }}>
        <Text strong>观察点</Text>
        <Tag>{viewpoints.length}</Tag>
      </Space>

      {/* Create */}
      <Space style={{ marginBottom: 12 }}>
        <Input
          size="small"
          placeholder="视角名称"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          style={{ width: 160 }}
        />
        <Button
          type="primary"
          size="small"
          icon={<CameraOutlined />}
          onClick={handleAdd}
        >
          保存当前视角
        </Button>
      </Space>

      {/* List */}
      <List
        size="small"
        bordered
        dataSource={viewpoints}
        renderItem={vp => (
          <List.Item
            style={{ background: vp.id === activeViewpointId ? '#f0f5ff' : undefined }}
            actions={[
              <Button
                key="nav"
                type="link"
                size="small"
                onClick={() => {
                  onSetActive(vp.id);
                  onNavigateToViewpoint(vp);
                }}
              >
                定位
              </Button>,
              <Button
                key="toggle"
                type="link"
                size="small"
                onClick={() => void onToggleEnabled(vp.id, !vp.enabled)}
              >
                {vp.enabled ? '显示' : <EyeInvisibleOutlined />}
              </Button>,
              <Button
                key="edit"
                type="link"
                size="small"
                icon={<EditOutlined />}
                onClick={() => {
                  setEditingId(vp.id);
                  setEditName(vp.name);
                }}
              />,
              <Popconfirm
                key="del"
                title="确认删除该视角？"
                onConfirm={() => void onDelete(vp.id)}
              >
                <Button type="link" danger size="small" icon={<DeleteOutlined />} />
              </Popconfirm>,
            ]}
          >
            {editingId === vp.id ? (
              <Input
                size="small"
                value={editName}
                onChange={e => setEditName(e.target.value)}
                onBlur={() => void handleRename(vp.id)}
                onPressEnter={() => void handleRename(vp.id)}
                autoFocus
                style={{ width: 160 }}
              />
            ) : (
              <Text style={{ textDecoration: vp.enabled ? undefined : 'line-through' }}>
                {vp.name}
              </Text>
            )}
          </List.Item>
        )}
      />
    </div>
  );
}
