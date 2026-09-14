import { useState } from 'react';
import {
  Alert,
  Button,
  Modal,
  Segmented,
  Space,
  Tooltip,
} from 'antd';
import {
  ExperimentOutlined,
  QuestionCircleOutlined,
  RestOutlined,
  SlidersOutlined,
} from '@ant-design/icons';
import type { ViewerCameraMode, LODLevel } from '@gsplatform/viewer';
import type { ViewerLifecycleState } from './useViewerLifecycle';
import { ViewerStats } from './ViewerStats';
import { PerformancePanel } from './PerformancePanel';
import { QualityPanel } from './QualityPanel';

interface ViewerToolbarProps {
  lifecycle: ViewerLifecycleState;
}

/**
 * Viewer 底部工具条：Reset / Orbit-Fly / Performance / Quality / Help。
 * 所有能力都真实接线到 ViewerAdapter；未实现的能力明确禁用并解释。
 */
export function ViewerToolbar({ lifecycle }: ViewerToolbarProps) {
  const {
    status,
    stats,
    cameraMode,
    setCameraMode,
    resetCamera,
    phase,
    currentLod,
    loadedBytes,
    totalBytes,
    isStreamed,
    streamingMetrics,
    qualityMode,
    setQualityMode,
  } = lifecycle;
  const [perfVisible, setPerfVisible] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);

  const setMode = (mode: string | number) => {
    setCameraMode(mode as ViewerCameraMode);
  };

  return (
    <>
      <footer className="gs-viewer__bottom-toolbar" aria-label="Viewer 工具条">
        <Tooltip title="恢复初始相机视角">
          <Button icon={<RestOutlined aria-hidden />} onClick={() => resetCamera()}>
            Reset
          </Button>
        </Tooltip>
        <Segmented
          options={[
            { label: 'Orbit', value: 'orbit' },
            { label: 'Fly', value: 'fly' },
          ]}
          value={cameraMode}
          onChange={setMode}
        />
        <Tooltip title="查看实时性能统计">
          <Button
            icon={<SlidersOutlined aria-hidden />}
            onClick={() => setPerfVisible((v) => !v)}
          >
            Performance
          </Button>
        </Tooltip>
        <Tooltip title="显示当前可用的渲染质量选项">
          <Button
            icon={<ExperimentOutlined aria-hidden />}
            onClick={() => setQualityOpen(true)}
          >
            Quality
          </Button>
        </Tooltip>
        <Tooltip title="查看操作说明">
          <Button
            icon={<QuestionCircleOutlined aria-hidden />}
            onClick={() => setHelpOpen(true)}
          >
            Help
          </Button>
        </Tooltip>
      </footer>

      {perfVisible && (
        isStreamed ? (
          <PerformancePanel
            metrics={streamingMetrics}
            active={status === 'loading' || status === 'ready'}
          />
        ) : (
          <ViewerStats
            stats={stats}
            currentLod={currentLod}
            loadedBytes={loadedBytes}
            totalBytes={totalBytes}
            onClose={() => setPerfVisible(false)}
          />
        )
      )}

      <Modal
        open={helpOpen}
        title="Viewer 操作说明"
        onCancel={() => setHelpOpen(false)}
        footer={null}
        width={560}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Alert type="info" showIcon message="Orbit（轨道）模式" description="左键旋转，滚轮缩放，Shift+拖动平移。" />
          <Alert type="info" showIcon message="Fly（飞行）模式" description="WASD 移动，Q/E 上下，滚轮前进/后退，Ctrl+拖动旋转视角。" />
          <Alert type="info" showIcon message="移动端触控" description="单指旋转，双指缩放 / 平移；双击聚焦。" />
          <Alert type="warning" showIcon message="真实渲染" description="本页显示的 3D 场景由 SuperSplat Viewer fork 实时渲染，非静态封面或录屏。" />
          <Alert type="info" showIcon message="渐进加载" description="场景先以低清点云形态快速可交互，然后自动提升到更高清晰度。" />
        </Space>
      </Modal>

      <Modal
        open={qualityOpen}
        title="Quality（渲染质量）"
        onCancel={() => setQualityOpen(false)}
        footer={null}
        width={480}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          {isStreamed ? (
            <QualityPanel
              currentMode={qualityMode}
              onModeChange={setQualityMode}
              targetLod={0}
            />
          ) : (
            <>
              <Alert
                type="success"
                showIcon
                message="渲染后端"
                description={stats ? (stats.renderer === 'webgpu' ? 'WebGPU（硬件加速可用）' : 'WebGL2（自动降级）') : '检测中…'}
              />
              <Alert
                type="info"
                showIcon
                message="当前场景高斯点数"
                description={stats ? `${stats.splatCount.toLocaleString()} splats` : '尚未加载'}
              />
              <Alert
                type={phase === 'READY' ? 'success' : 'info'}
                showIcon
                message={`渐进加载阶段：${lodLabel(currentLod)}`}
                description={
                  phase === 'READY'
                    ? '高质量版本已完整呈现'
                    : currentLod
                        ? `已就绪的 LOD：${lodLabel(currentLod)}${totalBytes != null ? `，共 ${formatBytes(totalBytes)}` : ''}`
                        : '正在准备场景'
                }
              />
              {phase !== 'READY' && loadedBytes > 0 && (
                <Alert
                  type="info"
                  showIcon
                  message="已传输字节数"
                  description={formatBytes(loadedBytes)}
                />
              )}
            </>
          )}
        </Space>
      </Modal>
    </>
  );
}

function lodLabel(level: LODLevel | null): string {
  if (level === null) return '未加载';
  switch (level) {
    case 'low': return '低清（点云级）';
    case 'medium': return '中等质量';
    case 'high': return '高质量';
  }
}

function formatBytes(n: number): string {
  if (n < 1_048_576) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1_048_576).toFixed(1)} MB`;
}