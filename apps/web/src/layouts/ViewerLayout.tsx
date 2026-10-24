import { ArrowLeftOutlined, CloseOutlined, MobileOutlined } from '@ant-design/icons';
import { Button, Space, Tooltip, Typography } from 'antd';
import { Outlet, useNavigate, useParams } from 'react-router-dom';

/**
 * 全屏 Viewer 布局：无平台 Sidebar / Topbar。
 * 顶部提供 返回 / 场景标题 / 进入 VR / 关闭。
 *
 * GS-DESKTOP-02：**移除平台全屏按钮** —— 官方 Viewer 原生工具条已有 Fullscreen
 * （对 viewer root 请求全屏），宿主不再维护第二套全屏控件。
 * "进入 VR" 是平台独有的独立 WebXR Runtime 入口，不属于官方 Viewer 控件。
 */
export default function ViewerLayout() {
  const navigate = useNavigate();
  const { sceneId } = useParams<{ sceneId: string }>();

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