/**
 * BackgroundMusicPanel — configure scene background audio.
 *
 * Uploads an audio asset, sets volume / loop / enable, and instructs the
 * viewer to attach the audio element and start playback after first user
 * interaction (respecting browser autoplay policies).
 */
import { useCallback, useRef, useState } from 'react';
import { Card, Button, Slider, Switch, Space, Tag, Upload, message } from 'antd';
import { UploadOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons';
import type { ScenePresentation } from '../../services/presentationApi';
import {
  updateBackgroundAudio as apiUpdateBackgroundAudio,
} from '../../services/annotationApi';

interface BackgroundMusicPanelProps {
  presentation: ScenePresentation | null;
  sceneId: string;
  onUpdated: (pres: ScenePresentation | null) => void;
}

const AUDIO_MIME = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/aac', 'audio/flac'];
const AUDIO_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

export function BackgroundMusicPanel({
  presentation,
  sceneId,
  onUpdated,
}: BackgroundMusicPanelProps) {
  const [uploading, setUploading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handleFile = useCallback(async (file: File) => {
    if (!AUDIO_MIME.includes(file.type)) {
      message.error(`不支持的音频格式: ${file.type}`);
      return false;
    }
    if (file.size > AUDIO_MAX_BYTES) {
      message.error('音频文件不能超过 50MB');
      return false;
    }
    // Upload via the generic asset upload endpoint, then bind the returned
    // asset id to the presentation background-audio settings.
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const resp = await fetch('/api/v1/upload', {
        method: 'POST',
        body: form,
        headers: { 'X-CSRF-Token': localStorage.getItem('csrf') ?? '' },
      });
      if (!resp.ok) {
        throw new Error(`upload failed: ${resp.status}`);
      }
      const data = await resp.json();
      const assetId: string | undefined = data?.asset?.id ?? data?.assetId;
      if (!assetId) {
        throw new Error('upload response missing asset id');
      }
      const updated = await apiUpdateBackgroundAudio(sceneId, { assetId });
      const presentationWithAudio = await fetchPresentation(sceneId);
      onUpdated(presentationWithAudio);
      message.success('背景音乐已上传');
    } catch {
      message.error('背景音乐上传失败');
    } finally {
      setUploading(false);
    }
    return false; // prevent antd default upload
  }, [sceneId, onUpdated]);

  const handleVolume = useCallback(async (volume: number) => {
    await apiUpdateBackgroundAudio(sceneId, { volume });
    // propagate locally
    const pres = await fetchPresentation(sceneId);
    onUpdated(pres);
  }, [sceneId, onUpdated]);

  const handleLoop = useCallback(async (loop: boolean) => {
    await apiUpdateBackgroundAudio(sceneId, { loop });
    const pres = await fetchPresentation(sceneId);
    onUpdated(pres);
  }, [sceneId, onUpdated]);

  const handleEnabled = useCallback(async (enabled: boolean) => {
    await apiUpdateBackgroundAudio(sceneId, { enabled });
    const pres = await fetchPresentation(sceneId);
    onUpdated(pres);
  }, [sceneId, onUpdated]);

  const togglePlayback = useCallback(() => {
    if (!presentation?.backgroundAudioAssetId) return;
    if (!audioRef.current) {
      const audio = new Audio(`/api/v1/scenes/${encodeURIComponent(sceneId)}/presentation/background-audio`);
      audio.loop = presentation.backgroundAudioLoop;
      audio.volume = presentation.backgroundAudioVolume;
      audioRef.current = audio;
    }
    const audio = audioRef.current;
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  }, [presentation, sceneId]);

  const hasAudio = Boolean(presentation?.backgroundAudioAssetId);
  const audioEnabled = presentation?.backgroundAudioEnabled ?? false;

  return (
    <Card
      title="背景音乐"
      size="small"
      style={{ marginBottom: 8 }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        {hasAudio ? (
          <Space>
            <Tag color="green">已设置音频</Tag>
            <Button
              size="small"
              icon={audioRef.current && !audioRef.current.paused ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={togglePlayback}
            >
              试听
            </Button>
          </Space>
        ) : (
          <Tag>未设置</Tag>
        )}
        <Upload
          accept="audio/*"
          showUploadList={false}
          beforeUpload={handleFile}
          disabled={uploading}
        >
          <Button icon={<UploadOutlined />} loading={uploading} size="small">
            上传音频
          </Button>
        </Upload>
        <Space style={{ width: '100%' }}>
          <Text label="音量" />
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={presentation?.backgroundAudioVolume ?? 0.5}
            onChange={handleVolume}
            style={{ width: 160 }}
          />
        </Space>
        <Space>
          <Switch
            checked={presentation?.backgroundAudioLoop ?? true}
            onChange={handleLoop}
            checkedChildren="循环"
            unCheckedChildren="单次"
            size="small"
          />
          <Switch
            checked={audioEnabled}
            onChange={handleEnabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            size="small"
          />
        </Space>
      </Space>
    </Card>
  );
}

/** Re-fetch the presentation (needed after any background-audio mutation). */
async function fetchPresentation(sceneId: string): Promise<ScenePresentation | null> {
  try {
    const response = await fetch(`/api/v1/scenes/${encodeURIComponent(sceneId)}/presentation`);
    if (!response.ok) return null;
    return await response.json() as ScenePresentation;
  } catch {
    return null;
  }
}