/**
 * AnnotationProperties —— 当前选中标注的 PCUI 属性区（GS-DESKTOP-02 §3.2）。
 *
 * 数据仍来自 GSPlatform 既有 Annotation API：
 *   - 数据库 ID 不变（SceneAnnotation.id）；
 *   - 官方 settings.annotations[].extras.gsplatform.annotationId 映射由
 *     experienceAdapter.buildAnnotations 生成（本组件不碰）；
 *   - 标注自己的 camera pose（cameraPosition/cameraTarget/cameraFov）保留；
 *   - HTML/文本清理与媒体资源 ACL 由后端 + experienceAdapter 既有逻辑负责。
 *
 * 编辑采用草稿 + 「保存修改」显式提交：避免每次按键都触发预览 runtime 重建
 * （重建会让相机跳回已保存视角）。
 */
import { useEffect, useState } from 'react';
import {
  BooleanInput,
  ColorPicker,
  Divider,
  Label,
  SelectInput,
  TextAreaInput,
  TextInput,
} from '@playcanvas/pcui/react';
import { PcuiField } from './PcuiField';
import { PcuiButton } from './PcuiButton';
import { PcuiNumericInput } from './PcuiNumericInput';
import type { AnnotationContentType, AnnotationStyle, SceneAnnotation } from '../../../services/annotationApi';

interface Props {
  annotation: SceneAnnotation;
  saving: boolean;
  onSave: (id: string, patch: Partial<SceneAnnotation>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMove: (id: string, direction: -1 | 1) => Promise<void>;
  onNavigate: (id: string) => void;
  onCaptureCamera: (id: string) => Promise<void>;
}

const STYLE_OPTIONS = [
  { t: '线段文字', v: 'LEADER_TEXT' },
  { t: '数字热点', v: 'NUMBER_POPUP' },
  { t: '隐藏标记', v: 'HIDDEN' },
];

const CONTENT_OPTIONS = [
  { t: '文本', v: 'TEXT' },
  { t: '图片', v: 'IMAGE' },
  { t: '视频', v: 'VIDEO' },
  { t: '音频', v: 'AUDIO' },
  { t: '全景', v: 'PANORAMA' },
];

/** #rrggbb → PCUI ColorPicker 的 [r,g,b,a]（0-255 / alpha 0-1）。 */
function hexToColor(hex: string): number[] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255, 1];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
}

function colorToHex(color: number[]): string {
  const [r, g, b] = color;
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function AnnotationProperties({
  annotation,
  saving,
  onSave,
  onDelete,
  onMove,
  onNavigate,
  onCaptureCamera,
}: Props) {
  const [title, setTitle] = useState(annotation.title);
  const [text, setText] = useState(annotation.textContent);
  const [style, setStyle] = useState<AnnotationStyle>(annotation.style);
  const [contentType, setContentType] = useState<AnnotationContentType>(annotation.contentType);
  const [mediaAssetId, setMediaAssetId] = useState(annotation.mediaAssetId ?? '');
  const [textColor, setTextColor] = useState(annotation.textColor);
  const [textSize, setTextSize] = useState<number>(annotation.textSize);
  const [fov, setFov] = useState<number>(annotation.fov);
  const [enabled, setEnabled] = useState(annotation.enabled);

  // 切换选中标注时同步草稿。
  useEffect(() => {
    setTitle(annotation.title);
    setText(annotation.textContent);
    setStyle(annotation.style);
    setContentType(annotation.contentType);
    setMediaAssetId(annotation.mediaAssetId ?? '');
    setTextColor(annotation.textColor);
    setTextSize(annotation.textSize);
    setFov(annotation.fov);
    setEnabled(annotation.enabled);
  }, [annotation]);

  const dirty =
    title !== annotation.title ||
    text !== annotation.textContent ||
    style !== annotation.style ||
    contentType !== annotation.contentType ||
    (annotation.mediaAssetId ?? '') !== mediaAssetId ||
    textColor !== annotation.textColor ||
    textSize !== annotation.textSize ||
    fov !== annotation.fov ||
    enabled !== annotation.enabled;

  return (
    <div className="gs-props" data-testid="annotation-properties">
      <Label class="gs-props__title" text="标注属性" />
      <PcuiField label="标题">
        <TextInput value={title} onChange={(v: string) => setTitle(v)} />
      </PcuiField>
      <PcuiField label="正文">
        <TextAreaInput
          value={text}
          height={96}
          resizable="vertical"
          onChange={(v: string) => setText(v)}
        />
      </PcuiField>
      <PcuiField label="样式">
        <SelectInput
          value={style}
          options={STYLE_OPTIONS}
          onChange={(v: string) => setStyle(v as AnnotationStyle)}
        />
      </PcuiField>
      <PcuiField label="内容类型">
        <SelectInput
          value={contentType}
          options={CONTENT_OPTIONS}
          onChange={(v: string) => setContentType(v as AnnotationContentType)}
        />
      </PcuiField>
      <PcuiField
        label="媒体资产 ID"
        hint="沿用既有媒体 ACL；留空表示纯文本标注"
      >
        <TextInput
          value={mediaAssetId}
          onChange={(v: string) => setMediaAssetId(v)}
        />
      </PcuiField>
      <PcuiField label="文字颜色">
        <ColorPicker
          value={hexToColor(textColor)}
          onChange={(value: number[]) => setTextColor(colorToHex(value))}
        />
      </PcuiField>
      <PcuiField label="文字大小">
        <PcuiNumericInput
          value={textSize}
          min={8}
          max={96}
          precision={0}
          step={1}
          onChange={(v: number) => setTextSize(v)}
        />
      </PcuiField>
      <PcuiField label="标注相机 FOV">
        <PcuiNumericInput
          value={fov}
          min={10}
          max={120}
          precision={0}
          step={1}
          onChange={(v: number) => setFov(v)}
        />
      </PcuiField>
      <PcuiField label="启用">
        <BooleanInput type="toggle" value={enabled} onChange={(v: boolean) => setEnabled(v)} />
      </PcuiField>

      <Divider />

      <div className="gs-props__row">
        <PcuiButton
          text={saving ? '保存中…' : '保存修改'}
          enabled={dirty && !saving}
          onClick={() => {
            void onSave(annotation.id, {
              title,
              textContent: text,
              style,
              contentType,
              mediaAssetId: mediaAssetId.trim() || undefined,
              textColor,
              textSize,
              fov,
              enabled,
            });
          }}
        />
        <PcuiButton
          text="用当前视角作为标注相机"
          onClick={() => {
            void onCaptureCamera(annotation.id);
          }}
        />
      </div>
      <div className="gs-props__row">
        <PcuiButton text="↑ 上移" onClick={() => void onMove(annotation.id, -1)} />
        <PcuiButton text="↓ 下移" onClick={() => void onMove(annotation.id, 1)} />
        <PcuiButton text="定位" onClick={() => onNavigate(annotation.id)} />
        <PcuiButton text="删除" class="gs-props__danger" onClick={() => void onDelete(annotation.id)} />
      </div>
    </div>
  );
}
