import { Button, Dropdown, Tooltip, Typography } from 'antd';
import { LogoutOutlined, MenuOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useUiStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { CategoryNav } from './CategoryNav';
import { SearchBox } from './SearchBox';

interface TopBarProps {
  onOpenMobileNav: () => void;
}

/**
 * 全宽 Topbar：品牌 + 分类导航 + 搜索 + 用户入口（登录/登出）+ 移动端菜单开关。
 * Phase 08：接入真实会话状态，显示当前用户/登出。
 */
export function TopBar({ onOpenMobileNav }: TopBarProps) {
  const navigate = useNavigate();
  const homeCategory = useUiStore((s) => s.homeCategory);
  const setHomeCategory = useUiStore((s) => s.setHomeCategory);
  const { user, loading: authLoading, logout } = useAuthStore();

  const onCategoryChange = (category: string): void => {
    setHomeCategory(category);
    navigate('/');
  };

  const onSearch = (keyword: string): void => {
    navigate(keyword ? `/?q=${encodeURIComponent(keyword)}` : '/');
  };

  const userMenuItems = user
    ? [
        {
          key: 'works',
          label: '我的作品',
          onClick: () => navigate('/works'),
        },
        {
          key: 'favorites',
          label: '我的收藏',
          onClick: () => navigate('/favorites'),
        },
        { type: 'divider' as const },
        {
          key: 'logout',
          icon: <LogoutOutlined aria-hidden />,
          label: '退出登录',
          danger: true,
          onClick: () => {
            void logout();
            navigate('/');
          },
        },
      ]
    : [];

  return (
    <header className="gs-topbar">
      <Button
        className="gs-topbar__menu-toggle"
        type="text"
        icon={<MenuOutlined aria-hidden />}
        aria-label="打开导航菜单"
        onClick={onOpenMobileNav}
      />
      <span className="gs-topbar__brand" aria-label="GSPlatform 首页">
        <span aria-hidden>◇</span> GSPlatform
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="gs-categories-desktop">
          <CategoryNav active={homeCategory} onChange={onCategoryChange} />
        </div>
      </div>
      <div className="gs-topbar__search">
        <SearchBox placeholder="搜索场景、作者…" onSearch={onSearch} />
      </div>

      {authLoading ? (
        <Button
          type="text"
          icon={<UserOutlined aria-hidden />}
          loading
          aria-label="加载用户信息"
        />
      ) : user ? (
        <Dropdown menu={{ items: userMenuItems }} placement="bottomRight" trigger={['click']}>
          <Button
            type="text"
            icon={<UserOutlined aria-hidden />}
            aria-label={`用户菜单 - ${user.displayName}`}
          >
            <Typography.Text ellipsis style={{ maxWidth: 100, marginLeft: 4 }}>
              {user.displayName}
            </Typography.Text>
          </Button>
        </Dropdown>
      ) : (
        <Tooltip title="登录后可管理作品和收藏">
          <Button
            type="text"
            icon={<UserOutlined aria-hidden />}
            onClick={() => {
              const returnTo = window.location.pathname;
              navigate(`/login?returnTo=${encodeURIComponent(returnTo)}`);
            }}
          >
            登录
          </Button>
        </Tooltip>
      )}
    </header>
  );
}
