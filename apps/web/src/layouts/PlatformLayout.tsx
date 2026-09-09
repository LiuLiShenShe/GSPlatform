import { Drawer, Menu } from 'antd';
import {
  AppstoreOutlined,
  CloudOutlined,
  HistoryOutlined,
  HomeOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  StarOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { useIsMobile } from '../hooks/useBreakpoints';
import { useUiStore } from '../stores/uiStore';
import { layout } from '../styles/tokens';

const PHASE_08_NOTE = '账户与平台功能将在 Phase 08 接入';

const PRIMARY_MENU = [
  {
    key: '/',
    icon: <HomeOutlined aria-hidden />,
    label: '首页',
  },
  {
    key: '/works',
    icon: <AppstoreOutlined aria-hidden />,
    label: '我的作品',
  },
  {
    key: '/upload',
    icon: <UploadOutlined aria-hidden />,
    label: '上传作品',
  },
  {
    key: '/compute',
    icon: <CloudOutlined aria-hidden />,
    label: '免费计算',
  },
];

const SECONDARY_MENU = [
  {
    key: '/favorites',
    icon: <StarOutlined aria-hidden />,
    label: '收藏',
    disabled: true,
  },
  {
    key: '/recent',
    icon: <HistoryOutlined aria-hidden />,
    label: '最近浏览',
    disabled: true,
  },
];

const FOOTER_MENU = [
  {
    key: '/settings',
    icon: <SettingOutlined aria-hidden />,
    label: '设置',
    disabled: true,
  },
  {
    key: '/help',
    icon: <QuestionCircleOutlined aria-hidden />,
    label: '帮助',
    disabled: true,
  },
];

const NAV = [
  ...PRIMARY_MENU,
  { type: 'divider' as const },
  ...SECONDARY_MENU.map((item) => ({ ...item, title: PHASE_08_NOTE })),
  { type: 'divider' as const },
  ...FOOTER_MENU.map((item) => ({ ...item, title: PHASE_08_NOTE })),
];

/**
 * 平台布局：固定 224px Sidebar（页面滚动不影响）+ 全宽 Topbar + 内容区。
 * 移动端窄屏时 Sidebar 隐藏，由 Topbar 菜单按钮打开抽屉导航。
 */
export default function PlatformLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const mobileNavOpen = useUiStore((s) => s.mobileNavOpen);
  const closeMobileNav = useUiStore((s) => s.closeMobileNav);
  const openMobileNav = useUiStore((s) => s.openMobileNav);

  const selectedKey =
    location.pathname === '/' ? '/' : `/${location.pathname.split('/')[1]}`;

  const menu = (
    <Menu
      theme="dark"
      mode="inline"
      selectedKeys={[selectedKey]}
      items={NAV}
      onClick={({ key }) => {
        if (!location.pathname.startsWith(key)) {
          navigate(key);
        }
        closeMobileNav();
      }}
    />
  );

  return (
    <>
      <TopBar onOpenMobileNav={openMobileNav} />
      <div className="gs-platform-body">
        {!isMobile && (
          <aside
            className="gs-sider"
            aria-label="平台导航"
            data-testid="platform-sider"
            style={{ width: layout.siderWidth }}
          >
            <nav className="gs-sider__menu">{menu}</nav>
          </aside>
        )}
        <main
          className="gs-platform-main"
          style={{ marginLeft: isMobile ? 0 : layout.siderWidth }}
        >
          <div className="gs-platform-content">
            <Outlet />
          </div>
        </main>
      </div>

      <Drawer
        open={isMobile && mobileNavOpen}
        onClose={closeMobileNav}
        placement="left"
        size={layout.siderWidth}
        title="GSPlatform"
        styles={{ body: { padding: 0, background: '#0f1b34' } }}
        aria-label="导航菜单"
      >
        {menu}
      </Drawer>
    </>
  );
}