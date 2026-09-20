/**
 * CoverPanel — upload JPG/PNG cover or capture the current viewer frame.
 */
import React, { useRef, useCallback } from 'react';
import { Button, Space, Typography, message } from 'antd';
import { CameraOutlined, UploadOutlined } from '@ant-design/icons';
import type { ScenePresentation } from '../../services/presentationApi';

const { Text } = Typography;

interface Props {
  presentation: ScenePresentation | null;
  onUploadCover: (file: File) => Promise<void>;
  onCaptureCover?: () => Promise<void>;
}

export function CoverPanel({ presentation, onUploadCover, onCaptureCover }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        message.error('仅支持 JPG/PNG/WebP 格式');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        message.error('封面文件不能超过 10MB');
        return;
      }
      try {
        await onUploadCover(file);
        message.success('封面已更新');
      } catch {
        message.error('上传封面失败');
      }
      e.target.value = '';
    },
    [onUploadCover],
  );

  const handleCapture = useCallback(async () => {
    if (!onCaptureCover) return;
    try {
      await onCaptureCover();
      message.success('已从当前画面截取封面');
    } catch {
      message.error('截取封面失败');
    }
  }, [onCaptureCover]);

  return (
    <div className="authoring-panel">
      <Text strong>封面</Text>
      <div style={{ marginTop: 8 }}>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={handleFileChange}
        />
        <Space>
          <Button
            icon={<UploadOutlined />}
            onClick={() => fileInputRef.current?.click()}
            size="small"
          >
            上传图片
          </Button>
          <Button
            icon={<CameraOutlined />}
            onClick={handleCapture}
            disabled={!onCaptureCover}
            size="small"
          >
            从画面截取
          </Button>
        </Space>
        {presentation?.coverUrl && (
          <div style={{ marginTop: 8 }}>
            <img
              src={presentation.coverUrl}
              alt="cover preview"
              style={{ width: 120, height: 90, objectFit: 'cover', borderRadius: 4, border: '1px solid #d9d9d9' }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
