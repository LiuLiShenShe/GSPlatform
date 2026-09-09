import { Button, Tooltip } from 'antd';
import { MenuOutlined, UserOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { useUiStore } from '../stores/uiStore';
import { CategoryNav } from './CategoryNav';
import { SearchBox } from './SearchBox';

interface TopBarProps {
  onOpenMobileNav: () => void;
}

/**
 * 全宽 Topbar：品牌 + 分类导航 + 搜索 + 用户入口 + 移动端菜单开关。
 */
export function TopBar({ onOpenMobileNav }: TopBarProps) {
  const navigate = useNavigate();
  const homeCategory = useUiStore((s) => s.homeCategory);
  const setHomeCategory = useUiStore((s) => s.setHomeCategory);

  const onCategoryChange = (category: string): void => {
    setHomeCategory(category);
    navigate('/');
  };

  const onSearch = (keyword: string): void => {
    // 搜索词写入 URL 查询参数，由 HomePage 读取过滤（与 URL 同步，可后退）。
    navigate(keyword ? `/?q=${encodeURIComponent(keyword)}` : '/');
  };

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
      <Tooltip title="登录与账户功能将在 Phase 08 接入">
        <span>
          <Button
            type="text"
            icon={<UserOutlined aria-hidden />}
            disabled
            aria-label="用户菜单（未接入）"
          >
            登录
          </Button>
        </span>
      </Tooltip>
    </header>
  );
}