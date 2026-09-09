import { useState } from 'react';
import { Alert, Button, Modal, Segmented, Space, Tooltip } from 'antd';
import {
  ExperimentOutlined,
  FullscreenOutlined,
  QuestionCircleOutlined,
  RestOutlined,
  SlidersOutlined,
} from '@ant-design/icons';

/**
 * Viewer 底部工具条：顺序固定为 Reset / Orbit-Fly / Performance / Quality / Help。
 * 未接入 ViewerViewer 的能力明确禁用并解释，Help 打开说明面板。
 */
export function ViewerBottomToolbar() {
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <>
      <footer className="gs-viewer__bottom-toolbar" aria-label="Viewer 工具条">
        <Tooltip title="Phase 02 集成 Viewer 后生效">
          <Button icon={<RestOutlined aria-hidden />} disabled>
            Reset
          </Button>
        </Tooltip>
        <Tooltip title="Phase 02 集成 Viewer 后生效">
          <span>
            <Segmented
              disabled
              options={[
                { label: 'Orbit', value: 'orbit' },
                { label: 'Fly', value: 'fly' },
              ]}
              value="orbit"
            />
          </span>
        </Tooltip>
        <Tooltip title="性能面板将在 Phase 04 接入">
          <Button icon={<SlidersOutlined aria-hidden />} disabled>
            Performance
          </Button>
        </Tooltip>
        <Tooltip title="质量设置将在 Phase 04 接入">
          <Button icon={<ExperimentOutlined aria-hidden />} disabled>
            Quality
          </Button>
        </Tooltip>
        <Tooltip title="查看说明">
          <Button
            icon={<QuestionCircleOutlined aria-hidden />}
            onClick={() => setHelpOpen(true)}
          >
            Help
          </Button>
        </Tooltip>
      </footer>

      <Modal
        open={helpOpen}
        title="Viewer 使用说明（Phase 01 外壳）"
        onCancel={() => setHelpOpen(false)}
        footer={null}
        width={560}
      >
        <Space orientation="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="当前为 Viewer 页面外壳，尚未加载真实 3D 场景。"
            description="Phase 02 将在此挂载区域集成 SuperSplat Viewer fork，届时可以真实加载 SOG 场景并交互。"
          />
          <Alert
            type="warning"
            showIcon
            message="本阶段不展示伪造的 3D 渲染、静态封面或伪进度。"
          />
          <p style={{ color: 'var(--gs-text-secondary)', margin: 0 }}>
            右侧面板：作者 / 收藏 / 分享 / 问 AI / 详情。
            <br />
            底部工具条：Reset / Orbit-Fly / Performance / Quality / Help。
            <br />
            除 Help 与详情外，其余能力将在 Phase 02 / 04 / 08 逐步接入。
          </p>
          <Button
            icon={<FullscreenOutlined aria-hidden />}
            onClick={() => {
              setHelpOpen(false);
              document.documentElement.requestFullscreen?.().catch(() => {
                /* 全屏被拒绝时忽略 */
              });
            }}
          >
            试试进入全屏
          </Button>
        </Space>
      </Modal>
    </>
  );
}