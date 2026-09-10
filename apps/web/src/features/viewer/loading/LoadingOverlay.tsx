/**
 * LoadingOverlay — compound component shown during progressive scene loading.
 *
 * It layers:
 *   1. PosterBackdrop (blurred poster or gradient) as the background
 *   2. LoadingProgress (progress bar + byte info + phase label)
 *   3. Cancel button + secondary "back to details" (route exit)
 *
 * Follows the Phase 03 wireframe:
 *   "正在准备场景 … [###------] 38% … 已下载 12.4 MB / 32.6 MB … [取消]"
 */

import { CloseCircleOutlined } from '@ant-design/icons';
import { Button, Progress } from 'antd';
import type { LoadPhase, LODLevel } from '@gsplatform/viewer';
import { phaseLabel } from '@gsplatform/viewer';
import { PosterBackdrop } from './PosterBackdrop';

interface LoadingOverlayProps {
  /** 0..100 null when indeterminate (no Content-Length). */
  percent: number | null;
  /** current load phase. */
  phase: LoadPhase;
  /** bytes read so far for the current fetch segment. */
  loadedBytes: number;
  /** total bytes when known, otherwise null. */
  totalBytes: number | null;
  /** true when there is no Content-Length. */
  indeterminate: boolean;
  /** the poster image URL, or null for gradient fallback. */
  posterUrl: string | null;
  /** fallback placeholder colour when posterUrl is missing. */
  placeholderColor?: string;
  /** cancel the in-flight load. */
  onCancel: () => void;
  /** go back to scene details / home. */
  onBack: () => void;
  /** current best LOD that has become interactive (null until low first frame). */
  currentLod: LODLevel | null;
}

/**
 * Format byte count for display.  Bytes < 1 MB shown as KB; otherwise MB.
 */
function formatBytes(n: number): string {
  if (n < 1_048_576) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

/**
 * The overlay is hidden once the scene is interactive and all LODs are settled.
 * This is handled by the parent (ViewerCanvas) only mounting the overlay while
 * phase is not READY/ERROR.
 */
export function LoadingOverlay({
  percent,
  phase,
  loadedBytes,
  totalBytes,
  indeterminate,
  posterUrl,
  placeholderColor,
  onCancel,
  onBack,
  currentLod,
}: LoadingOverlayProps) {
  const showProgressBar = percent !== null;
  const progressBarPercent = percent ?? 0;
  const label = phaseLabel(phase);

  return (
    <div className="gs-viewer__progressive-overlay" data-testid="progressive-overlay">
      <PosterBackdrop
        posterUrl={posterUrl}
        placeholderColor={placeholderColor}
        visible
      />

      <div className="gs-viewer__progressive-center">
        <div className="gs-viewer__progressive-title" data-testid="progressive-phase">
          {label}
        </div>

        {currentLod && (
          <div className="gs-viewer__progressive-lod" data-testid="progressive-lod">
            {lodLabel(currentLod)} 已就绪
            {percent != null && percent < 100 && ' · 正在提升质量'}
          </div>
        )}

        {showProgressBar && (
          <Progress
            percent={progressBarPercent}
            showInfo
            size={[320, 10]}
            strokeColor="#3E5BDB"
            className="gs-viewer__progressive-bar"
            data-testid="progressive-bar"
          />
        )}

        {indeterminate && (
          <div className="gs-viewer__progressive-indeterminate" data-testid="progressive-indeterminate">
            正在加载… {formatBytes(loadedBytes)}
          </div>
        )}

        {!indeterminate && showProgressBar && (
          <div className="gs-viewer__progressive-bytes" data-testid="progressive-bytes">
            已下载 {formatBytes(loadedBytes)}
            {totalBytes != null && ` / ${formatBytes(totalBytes)}`}
          </div>
        )}

        <div className="gs-viewer__progressive-actions">
          <Button
            type="text"
            icon={<CloseCircleOutlined aria-hidden />}
            onClick={onCancel}
            data-testid="progressive-cancel"
            aria-label="取消加载"
          >
            取消加载
          </Button>
          <Button type="text" onClick={onBack}>
            返回
          </Button>
        </div>
      </div>
    </div>
  );
}

function lodLabel(level: LODLevel): string {
  switch (level) {
    case 'low': return '低清';
    case 'medium': return '中等质量';
    case 'high': return '高质量';
  }
}
