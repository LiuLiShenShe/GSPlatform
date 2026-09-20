/**
 * BackgroundPanel — solid color or equirectangular panorama background.
 */
import React, { useRef, useCallback, useState } from 'react';
import { Button, Space, Typography, message, Radio, ColorPicker } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import type { Color } from 'antd/es/color-picker';
import type { ScenePresentation, Vec3 } from '../../services/presentationApi';

const { Text } = Typography;

interface Props {
  presentation: ScenePresentation | null;
  onSetBackgroundType: (type: 'color' | 'equirectangular') => Promise<void>;
  onSetBackgroundColor: (color: Vec3) => Promise<void>;
  onUploadBackground: (file: File, lat?: number, lon?: number) => Promise<void>;
}

export function BackgroundPanel({
  presentation,
  onSetBackgroundType,
  onSetBackgroundColor,
  onUploadBackground,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lat] = useState<number | undefined>(undefined);
  const [lon] = useState<number | undefined>(undefined);

  const type = presentation?.backgroundType ?? 'color';
  const color = presentation?.backgroundColor;

  const handleColorChange = useCallback(
    (c: Color) => {
      const rgb = c.toRgb();
      void onSetBackgroundColor({ x: rgb.r / 255, y: rgb.g / 255, z: rgb.b / 255 });
    },
    [onSetBackgroundColor],
  );

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        message.error('仅支持 JPG/PNG/WebP 全景图');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        message.error('背景文件不能超过 10MB');
        return;
      }
      try {
        await onUploadBackground(file, lat, lon);
        await onSetBackgroundType('equirectangular');
        message.success('全景背景已上传');
      } catch {
        message.error('上传背景失败');
      }
      e.target.value = '';
    },
    [lat, lon, onUploadBackground, onSetBackgroundType],
  );

  const defaultColor =
    color !== undefined && color !== null
      ? `rgb(${Math.round(color.x * 255)}, ${Math.round(color.y * 255)}, ${Math.round(color.z * 255)})`
      : '#000000';

  return (
    <div className="authoring-panel">
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space>
          <Text strong>背景</Text>
          <Radio.Group
            size="small"
            value={type}
            onChange={e => void onSetBackgroundType(e.target.value)}
          >
            <Radio.Button value="color">纯色</Radio.Button>
            <Radio.Button value="equirectangular">全景</Radio.Button>
          </Radio.Group>
        </Space>

        {type === 'color' && (
          <Space>
            <Text>颜色</Text>
            <ColorPicker value={defaultColor} onChange={handleColorChange} />
          </Space>
        )}

        {type === 'equirectangular' && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
            <Button
              size="small"
              icon={<UploadOutlined />}
              onClick={() => fileInputRef.current?.click()}
            >
              上传全景图
            </Button>
          </>
        )}
      </Space>
    </div>
  );
}