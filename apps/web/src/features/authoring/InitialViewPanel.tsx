/**
 * InitialViewPanel — "Set Current Camera as Initial View" button,
 * displays the saved initial view state.
 */
import { Button, Space, Typography, Tag } from 'antd';
import { EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ScenePresentation } from '../../services/presentationApi';
import type { ViewerCameraPose } from '@gsplatform/viewer';

const { Text } = Typography;

interface Props {
  presentation: ScenePresentation | null;
  onSetInitialView: (pose: ViewerCameraPose) => Promise<void>;
  onGetCurrentPose: () => Promise<ViewerCameraPose | null>;
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
    const pose = await onGetCurrentPose();
    if (pose) {
      await onSetInitialView(pose);
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
