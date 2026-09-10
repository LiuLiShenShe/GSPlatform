import { CloseOutlined } from '@ant-design/icons';
import { Descriptions } from 'antd';
import type { LODLevel, ViewerStats as ViewerStatsData } from '@gsplatform/viewer';

interface ViewerStatsProps {
  stats: ViewerStatsData | null;
  currentLod?: LODLevel | null;
  loadedBytes?: number;
  totalBytes?: number | null;
  onClose: () => void;
}

function formatBytes(n: number): string {
  if (n < 1_048_576) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1_048_576).toFixed(1)} MB`;
}

function lodLabel(level: LODLevel | null | undefined): string {
  switch (level) {
    case 'low': return '低清';
    case 'medium': return '中等';
    case 'high': return '高质量';
    default: return '-';
  }
}

/**
 * Performance 面板：展示 Viewer 返回的真实 FPS / frame time / splat 数据，
 * 以及当前加载的 LOD 等级与已传输字节。无数据时不伪造固定值。
 */
export function ViewerStats({ stats, currentLod, loadedBytes, totalBytes, onClose }: ViewerStatsProps) {
  return (
    <div className="gs-viewer__stats" data-testid="viewer-stats" role="region" aria-label="性能统计">
      <div className="gs-viewer__stats-header">
        <strong>Performance</strong>
        <button
          type="button"
          className="gs-viewer__stats-close"
          aria-label="关闭性能面板"
          onClick={onClose}
        >
          <CloseOutlined aria-hidden />
        </button>
      </div>
      <Descriptions column={1} size="small" bordered>
        <Descriptions.Item label="当前 LOD">
          {lodLabel(currentLod)}
        </Descriptions.Item>
        <Descriptions.Item label="FPS">
          {stats ? Math.round(stats.fps) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Frame time">
          {stats && stats.frameTimeMs > 0 ? `${stats.frameTimeMs.toFixed(1)} ms` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Splats">
          {stats ? stats.splatCount.toLocaleString() : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="已加载字节">
          {loadedBytes != null && loadedBytes > 0
            ? totalBytes != null
              ? `${formatBytes(loadedBytes)} / ${formatBytes(totalBytes)}`
              : formatBytes(loadedBytes)
            : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Renderer">
          {stats ? (stats.renderer === 'webgpu' ? 'WebGPU' : stats.renderer === 'webgl2' ? 'WebGL2' : 'Null') : '-'}
        </Descriptions.Item>
      </Descriptions>
      <div className="gs-viewer__stats-note">数据来自 Viewer 实时统计，非固定值。</div>
    </div>
  );
}