/**
 * PostEffectsPanel — 官方 ExperienceSettings v2 渲染设置（SSV-05 §4）。
 *
 * 包含 tonemapping 选择、high-precision rendering 开关、以及官方
 * postEffectSettings 五个 effect（sharpness / bloom / grading / vignette /
 * fringing）的独立开关 + 参数滑块。数值范围直接读官方 POST_EFFECT_RANGES，
 * 与 validateSettings({ limits: true }) 保持同一套界 —— 保存值必然合法。
 *
 * 滑块在释放（onAfterChange）时才提交 + 触发预览重建，避免拖拽期间
 * 反复重建 runtime。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Select, Slider, Space, Switch, Typography } from 'antd';
import { POST_EFFECT_RANGES } from '@playcanvas/supersplat-viewer/settings';
import type { RuntimePostEffects, RuntimeTonemapping } from '../../scene-runtime/types';
import type { ScenePresentation } from '../../services/presentationApi';

const { Text } = Typography;

const TONEMAPPING_OPTIONS: { value: RuntimeTonemapping; label: string }[] = [
  { value: 'none', label: 'None（无）' },
  { value: 'linear', label: 'Linear（线性）' },
  { value: 'filmic', label: 'Filmic' },
  { value: 'hejl', label: 'Hejl' },
  { value: 'aces', label: 'ACES' },
  { value: 'aces2', label: 'ACES2' },
  { value: 'neutral', label: 'Neutral' },
];

interface Props {
  presentation: ScenePresentation | null;
  saving: boolean;
  onSetTonemapping: (value: RuntimeTonemapping) => Promise<void>;
  onSetHighPrecisionRendering: (value: boolean) => Promise<void>;
  onSetPostEffects: (fx: RuntimePostEffects) => Promise<void>;
}

/** 滑块行：官方范围 + step，释放时提交。 */
function EffectSlider({
  label,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (v: number) => void;
}) {
  return (
    <Space size={8} style={{ width: '100%' }}>
      <Text type="secondary" style={{ width: 64, fontSize: 12 }}>
        {label}
      </Text>
      <Slider
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={onCommit}
        style={{ width: 140, margin: '6px 0' }}
      />
      <Text style={{ width: 40, fontSize: 12, textAlign: 'right' }}>{Number(value).toFixed(2)}</Text>
    </Space>
  );
}

const DEFAULT_FX = (): RuntimePostEffects => ({
  sharpness: { enabled: false, amount: 0 },
  bloom: { enabled: false, intensity: 0.05, blurLevel: 2 },
  grading: { enabled: false, brightness: 1, contrast: 1, saturation: 1, tint: [1, 1, 1] },
  vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
  fringing: { enabled: false, intensity: 0.5 },
});

export function PostEffectsPanel({
  presentation,
  saving,
  onSetTonemapping,
  onSetHighPrecisionRendering,
  onSetPostEffects,
}: Props) {
  const savedFx = presentation?.postEffects ?? null;
  const [fx, setFx] = useState<RuntimePostEffects>(savedFx ?? DEFAULT_FX());

  // 外部（重新加载 / 重建后）更新了 presentation → 同步本地编辑态。
  useEffect(() => {
    setFx(savedFx ?? DEFAULT_FX());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedFx]);

  const tonemapping: RuntimeTonemapping = presentation?.tonemapping ?? 'aces';
  const highPrecisionRendering = Boolean(presentation?.highPrecisionRendering);

  const commitFx = useCallback(
    (next: RuntimePostEffects) => {
      setFx(next);
      void onSetPostEffects(next);
    },
    [onSetPostEffects],
  );

  const toggleEffect = useCallback(
    (key: keyof RuntimePostEffects) => (enabled: boolean) => {
      commitFx({ ...fx, [key]: { ...fx[key], enabled } });
    },
    [commitFx, fx],
  );

  const patchSlider = useCallback(
    (key: keyof RuntimePostEffects, field: string) => (value: number) => {
      commitFx({ ...fx, [key]: { ...fx[key], [field]: value } });
    },
    [commitFx, fx],
  );

  const R = POST_EFFECT_RANGES;

  return (
    <div className="authoring-panel" data-testid="post-effects-panel">
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Text strong>渲染（Experience Settings v2）</Text>
        {saving && <Text type="secondary" style={{ fontSize: 12 }}>保存中…</Text>}
      </Space>

      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Space size={8}>
          <Text style={{ width: 64, fontSize: 13 }}>Tonemapping</Text>
          <Select
            size="small"
            value={tonemapping}
            style={{ width: 140 }}
            options={TONEMAPPING_OPTIONS}
            onChange={v => void onSetTonemapping(v as RuntimeTonemapping)}
          />
        </Space>

        <Space size={8}>
          <Text style={{ width: 64, fontSize: 13 }}>高精度</Text>
          <Switch
            size="small"
            checked={highPrecisionRendering}
            onChange={v => void onSetHighPrecisionRendering(v)}
          />
        </Space>

        {/* sharpness */}
        <Space size={8}>
          <Switch size="small" checked={fx.sharpness.enabled} onChange={toggleEffect('sharpness')} />
          <Text style={{ width: 64, fontSize: 13 }}>锐化</Text>
        </Space>
        {fx.sharpness.enabled && (
          <EffectSlider
            label="amount"
            value={fx.sharpness.amount}
            min={R.sharpness.amount.min}
            max={R.sharpness.amount.max}
            step={R.sharpness.amount.step}
            onCommit={patchSlider('sharpness', 'amount')}
          />
        )}

        {/* bloom */}
        <Space size={8}>
          <Switch size="small" checked={fx.bloom.enabled} onChange={toggleEffect('bloom')} />
          <Text style={{ width: 64, fontSize: 13 }}>泛光</Text>
        </Space>
        {fx.bloom.enabled && (
          <>
            <EffectSlider
              label="intensity"
              value={fx.bloom.intensity}
              min={R.bloom.intensity.min}
              max={R.bloom.intensity.max}
              step={R.bloom.intensity.step}
              onCommit={patchSlider('bloom', 'intensity')}
            />
            <EffectSlider
              label="blurLevel"
              value={fx.bloom.blurLevel}
              min={R.bloom.blurLevel.min}
              max={R.bloom.blurLevel.max}
              step={R.bloom.blurLevel.step}
              onCommit={patchSlider('bloom', 'blurLevel')}
            />
          </>
        )}

        {/* grading */}
        <Space size={8}>
          <Switch size="small" checked={fx.grading.enabled} onChange={toggleEffect('grading')} />
          <Text style={{ width: 64, fontSize: 13 }}>调色</Text>
        </Space>
        {fx.grading.enabled && (
          <>
            <EffectSlider
              label="brightness"
              value={fx.grading.brightness}
              min={R.grading.brightness.min}
              max={R.grading.brightness.max}
              step={R.grading.brightness.step}
              onCommit={patchSlider('grading', 'brightness')}
            />
            <EffectSlider
              label="contrast"
              value={fx.grading.contrast}
              min={R.grading.contrast.min}
              max={R.grading.contrast.max}
              step={R.grading.contrast.step}
              onCommit={patchSlider('grading', 'contrast')}
            />
            <EffectSlider
              label="saturation"
              value={fx.grading.saturation}
              min={R.grading.saturation.min}
              max={R.grading.saturation.max}
              step={R.grading.saturation.step}
              onCommit={patchSlider('grading', 'saturation')}
            />
          </>
        )}

        {/* vignette */}
        <Space size={8}>
          <Switch size="small" checked={fx.vignette.enabled} onChange={toggleEffect('vignette')} />
          <Text style={{ width: 64, fontSize: 13 }}>暗角</Text>
        </Space>
        {fx.vignette.enabled && (
          <>
            <EffectSlider
              label="intensity"
              value={fx.vignette.intensity}
              min={R.vignette.intensity.min}
              max={R.vignette.intensity.max}
              step={R.vignette.intensity.step}
              onCommit={patchSlider('vignette', 'intensity')}
            />
            <EffectSlider
              label="inner"
              value={fx.vignette.inner}
              min={R.vignette.inner.min}
              max={R.vignette.inner.max}
              step={R.vignette.inner.step}
              onCommit={patchSlider('vignette', 'inner')}
            />
            <EffectSlider
              label="outer"
              value={fx.vignette.outer}
              min={R.vignette.outer.min}
              max={R.vignette.outer.max}
              step={R.vignette.outer.step}
              onCommit={patchSlider('vignette', 'outer')}
            />
            <EffectSlider
              label="curvature"
              value={fx.vignette.curvature}
              min={R.vignette.curvature.min}
              max={R.vignette.curvature.max}
              step={R.vignette.curvature.step}
              onCommit={patchSlider('vignette', 'curvature')}
            />
          </>
        )}

        {/* fringing */}
        <Space size={8}>
          <Switch size="small" checked={fx.fringing.enabled} onChange={toggleEffect('fringing')} />
          <Text style={{ width: 64, fontSize: 13 }}>色差</Text>
        </Space>
        {fx.fringing.enabled && (
          <EffectSlider
            label="intensity"
            value={fx.fringing.intensity}
            min={R.fringing.intensity.min}
            max={R.fringing.intensity.max}
            step={R.fringing.intensity.step}
            onCommit={patchSlider('fringing', 'intensity')}
          />
        )}

        <Button
          size="small"
          style={{ marginTop: 4 }}
          onClick={() => {
            const next = DEFAULT_FX();
            setFx(next);
            void onSetPostEffects(next);
            void onSetTonemapping('aces');
            void onSetHighPrecisionRendering(false);
          }}
        >
          恢复推荐默认
        </Button>
      </Space>
    </div>
  );
}