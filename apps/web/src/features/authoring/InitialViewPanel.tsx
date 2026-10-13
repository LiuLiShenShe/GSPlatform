/**
 * InitialViewPanel — "Set Current Camera as Initial View" button,
 * displays the saved initial view state.
 */
import { Button, Space, Typography, Tag, message } from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ScenePresentation } from '../../services/presentationApi';
import type { AuthoringCameraPose } from './authoringTypes';

const { Text } = Typography;

interface Props {
  presentation: ScenePresentation | null;
  onSetInitialView: (pose: AuthoringCameraPose) => Promise<void>;
  onGetCurrentPose: () => Promise<AuthoringCameraPose | null>;
}

export function InitialViewPanel({ presentation, onSetInitialView, onGetCurrentPose }: Props) {
  const initial = presentation?.initialCameraPosition
    ? {
        x: presentation.initialCameraPosition.x,
        y: presentation.initialCameraPosition.y,
        z: presentation.initialCameraPosition.z,
      }
    : null;

  const fov = presentation?.initialCameraFov;

  const handleSet = async () => {
    // GS-NEXT-02：保存失败必须**可见**。此前这里不捕获异常，PATCH 失败（如非
    // 场景所有者 403）时既无错误提示、乐观写入的视角又被留在面板上，用户会
    // 以为已保存 —— 而重新打开场景仍是官方鸟瞰。
    try {
      const pose = await onGetCurrentPose();
      if (!pose) {
        message.error('保存失败：Viewer 未就绪，无法读取当前视角');
        return;
      }
      await onSetInitialView(pose);
    } catch {
      message.error('保存初始视角失败，请确认你对该场景有编辑权限后重试');
    }
  };

  return (
    <div className="authoring-panel">
      <Text strong>初始视角</Text>
      <div style={{ marginTop: 8 }}>
        {initial ? (
          <Space direction="vertical" size={4}>
            <Text type="secondary">
              Position: ({initial.x.toFixed(2)}, {initial.y.toFixed(2)}, {initial.z.toFixed(2)})
            </Text>
            <Text type="secondary">FOV: {fov?.toFixed(1)}°</Text>
            <Button icon={<ReloadOutlined />} onClick={handleSet} size="small">
              更新为当前视角
            </Button>
          </Space>
        ) : (
          <Space>
            <Tag color="warning">未设置</Tag>
            <Button type="primary" icon={<EyeOutlined />} onClick={handleSet} size="small">
              设为初始视角
            </Button>
          </Space>
        )}
      </div>
    </div>
  );
}
