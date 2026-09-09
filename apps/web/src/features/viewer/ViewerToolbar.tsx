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
import type { ViewerCameraMode } from '@gsplatform/viewer';
import type { ViewerLifecycleState } from './useViewerLifecycle';
import { ViewerStats } from './ViewerStats';

interface ViewerToolbarProps {
  lifecycle: ViewerLifecycleState;
}

/**
 * Viewer 底部工具条：Reset / Orbit-Fly / Performance / Quality / Help。
 * 所有能力都真实接线到 ViewerAdapter；未实现的能力明确禁用并解释。
 */
export function ViewerToolbar({ lifecycle }: ViewerToolbarProps) {
  const { stats, cameraMode, setCameraMode, resetCamera } = lifecycle;
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
        <ViewerStats stats={stats} onClose={() => setPerfVisible(false)} />
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
            type="warning"
            showIcon
            message="渐近加载 / Streamed SOG（Phase 04 可用）"
            description="当前为一次性完整加载；自适应细节与分片策略将在 Phase 04 提供。"
          />
        </Space>
      </Modal>
    </>
  );
}