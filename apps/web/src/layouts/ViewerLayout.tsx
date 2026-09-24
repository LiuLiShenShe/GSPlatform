import { ArrowLeftOutlined, CloseOutlined, FullscreenOutlined, MobileOutlined } from '@ant-design/icons';
import { Button, Space, Tooltip, Typography } from 'antd';
import { Outlet, useNavigate, useParams } from 'react-router-dom';

/**
 * 全屏 Viewer 布局：无平台 Sidebar / Topbar。
 * 顶部提供 返回 / 场景标题 / 进入全屏 / 进入 VR / 关闭。
 * "进入全屏" 是 requestFullscreen()；"进入 VR" 是独立的 WebXR 入口，
 * 跳转到 /xr/:sceneId（独立 XR Runtime，非 iframe）。
 */
export default function ViewerLayout() {
  const navigate = useNavigate();
  const { sceneId } = useParams<{ sceneId: string }>();

  const enterFullscreen = (): void => {
    document.documentElement.requestFullscreen?.().catch(() => {
      /* 全屏被拒绝或不可用时静默忽略 */
    });
  };

  const enterVR = (): void => {
    if (sceneId) {
      navigate(`/xr/${sceneId}`);
    }
  };

  return (
    <div className="gs-viewer">
      <header className="gs-viewer__topbar">
        <Tooltip title="返回上一页">
          <Button
            type="text"
            icon={<ArrowLeftOutlined aria-hidden />}
            aria-label="返回"
            onClick={() => navigate(-1)}
          >
            返回
          </Button>
        </Tooltip>
        <Typography.Text className="gs-viewer__title" ellipsis>
          场景 {sceneId}
        </Typography.Text>
        <Space size={4}>
          <Tooltip title="进入系统全屏">
            <Button
              type="text"
              icon={<FullscreenOutlined aria-hidden />}
              aria-label="进入全屏"
              onClick={enterFullscreen}
            >
              进入全屏
            </Button>
          </Tooltip>
          <Tooltip title="进入 WebXR 沉浸式 VR（独立 XR Runtime）">
            <Button
              type="text"
              icon={<MobileOutlined aria-hidden />}
              aria-label="进入 VR"
              data-testid="enter-vr-nav"
              onClick={enterVR}
            >
              进入 VR
            </Button>
          </Tooltip>
          <Tooltip title="关闭并回到首页">
            <Button
              type="text"
              icon={<CloseOutlined aria-hidden />}
              aria-label="关闭场景"
              onClick={() => navigate('/')}
            >
              关闭
            </Button>
          </Tooltip>
        </Space>
      </header>
      <main className="gs-viewer__main">
        <Outlet />
      </main>
    </div>
  );
}