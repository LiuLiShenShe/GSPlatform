import { CloseOutlined } from '@ant-design/icons';
import { Descriptions } from 'antd';
import type { ViewerStats as ViewerStatsData } from '@gsplatform/viewer';

interface ViewerStatsProps {
  stats: ViewerStatsData | null;
  onClose: () => void;
}

/**
 * Performance 面板：展示 Viewer 返回的真实 FPS / frame time / splat 数据。
 * 无数据时不伪造固定值。
 */
export function ViewerStats({ stats, onClose }: ViewerStatsProps) {
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
        <Descriptions.Item label="FPS">
          {stats ? Math.round(stats.fps) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Frame time">
          {stats && stats.frameTimeMs > 0 ? `${stats.frameTimeMs.toFixed(1)} ms` : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Splats">
          {stats ? stats.splatCount.toLocaleString() : '-'}
        </Descriptions.Item>
        <Descriptions.Item label="Renderer">
          {stats ? (stats.renderer === 'webgpu' ? 'WebGPU' : stats.renderer === 'webgl2' ? 'WebGL2' : 'Null') : '-'}
        </Descriptions.Item>
      </Descriptions>
      <div className="gs-viewer__stats-note">数据来自 Viewer 实时统计，非固定值。</div>
    </div>
  );
}