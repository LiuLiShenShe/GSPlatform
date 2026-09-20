/**
 * WorldTransformPanel — rotation/scale/position sliders for the World Root.
 * Changes are applied in real-time to the viewer entity and saved to the backend.
 */
import { useCallback } from 'react';
import { Slider, Space, Typography, Button, InputNumber } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { Vec3 } from '../../services/presentationApi';
import type { ScenePresentation } from '../../services/presentationApi';

const { Text } = Typography;

interface Props {
  presentation: ScenePresentation | null;
  onSetWorldRotation: (v: Vec3) => Promise<void>;
  onSetWorldScale: (v: Vec3) => Promise<void>;
}

function RotationSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Space style={{ width: '100%' }}>
      <Text style={{ width: 20 }}>{label}</Text>
      <Slider
        min={-180}
        max={180}
        step={1}
        value={value}
        onChange={onChange}
        style={{ flex: 1 }}
      />
      <InputNumber
        min={-180}
        max={180}
        value={value}
        onChange={v => onChange(v ?? 0)}
        size="small"
        style={{ width: 70 }}
      />
    </Space>
  );
}

export function WorldTransformPanel({ presentation, onSetWorldRotation, onSetWorldScale }: Props) {
  const rot = presentation?.worldRotation ?? { x: 0, y: 0, z: 0 };
  const scale = presentation?.worldScale ?? { x: 1, y: 1, z: 1 };

  const handleRotChange = useCallback(
    (axis: 'x' | 'y' | 'z', value: number) => {
      void onSetWorldRotation({ ...rot, [axis]: value });
    },
    [rot, onSetWorldRotation],
  );

  const handleScaleChange = useCallback(
    (axis: 'x' | 'y' | 'z', value: number) => {
      void onSetWorldScale({ ...scale, [axis]: value });
    },
    [scale, onSetWorldScale],
  );

  const handleReset = useCallback(() => {
    void onSetWorldRotation({ x: 0, y: 0, z: 0 });
    void onSetWorldScale({ x: 1, y: 1, z: 1 });
  }, [onSetWorldRotation, onSetWorldScale]);

  return (
    <div className="authoring-panel">
      <Space>
        <Text strong>世界方向</Text>
        <Button icon={<ReloadOutlined />} size="small" onClick={handleReset}>
          重置
        </Button>
      </Space>

      <div style={{ marginTop: 8 }}>
        <Text type="secondary">旋转 (°)</Text>
        <RotationSlider label="X" value={rot.x} onChange={v => handleRotChange('x', v)} />
        <RotationSlider label="Y" value={rot.y} onChange={v => handleRotChange('y', v)} />
        <RotationSlider label="Z" value={rot.z} onChange={v => handleRotChange('z', v)} />
      </div>

      <div style={{ marginTop: 12 }}>
        <Text type="secondary">缩放</Text>
        <RotationSlider label="X" value={scale.x} onChange={v => handleScaleChange('x', v)} />
        <RotationSlider label="Y" value={scale.y} onChange={v => handleScaleChange('y', v)} />
        <RotationSlider label="Z" value={scale.z} onChange={v => handleScaleChange('z', v)} />
      </div>
    </div>
  );
}
