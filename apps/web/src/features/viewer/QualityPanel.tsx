/**
 * Quality mode selector panel for streamed SOG scenes.
 *
 * Exposes eco / balanced / quality modes. Each mode adjusts the LOD
 * selection multiplier, prefetch budget and concurrency limits inside
 * the streaming scheduler.
 */

import { useState, useCallback } from 'react';
import type { QualityMode } from '@gsplatform/viewer';

interface QualityPanelProps {
  currentMode: QualityMode;
  onModeChange: (mode: QualityMode) => void;
  /** Current target LOD (0-based) — for display only. */
  targetLod: number;
  /** LOD level labels (e.g. ["Low", "Medium", "High"]). */
  lodLabels?: string[];
}

const MODE_META: Record<QualityMode, { label: string; description: string }> = {
  eco:     { label: '省流',     description: '降低预取和并发，节省网络流量' },
  balanced:{ label: '自动',     description: '基于 FPS 和相机速度自动调整' },
  quality: { label: '高质量',   description: '提升目标 LOD，优先画质' },
};

const DEFAULT_LABELS = ['Low', 'Medium', 'High'];

export function QualityPanel({
  currentMode,
  onModeChange,
  targetLod,
  lodLabels = DEFAULT_LABELS,
}: QualityPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const handleSelect = useCallback((mode: QualityMode) => {
    onModeChange(mode);
    setExpanded(false);
  }, [onModeChange]);

  return (
    <div className="quality-panel" style={{ position: 'relative' }}>
      <button
        className="quality-panel__toggle"
        onClick={() => setExpanded(v => !v)}
        title="画质模式"
      >
        Quality: {MODE_META[currentMode].label}
        <span className="quality-panel__lod" style={{ marginLeft: 6, opacity: 0.6 }}>
          · {lodLabels[targetLod] ?? `LOD ${targetLod}`}
        </span>
      </button>

      {expanded && (
        <div className="quality-panel__menu" role="radiogroup" aria-label="画质模式">
          {(['eco', 'balanced', 'quality'] as QualityMode[]).map(mode => (
            <button
              key={mode}
              className={`quality-panel__option${mode === currentMode ? ' quality-panel__option--active' : ''}`}
              role="radio"
              aria-checked={mode === currentMode}
              onClick={() => handleSelect(mode)}
            >
              <span className="quality-panel__label">{MODE_META[mode].label}</span>
              <span className="quality-panel__desc">{MODE_META[mode].description}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
