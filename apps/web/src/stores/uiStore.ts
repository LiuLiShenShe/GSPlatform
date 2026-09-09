import { create } from 'zustand';

interface UiState {
  /** 移动端抽屉导航是否打开（跨 Sidebar / Topbar / Drawer 共享的 UI 状态）。 */
  mobileNavOpen: boolean;
  openMobileNav: () => void;
  closeMobileNav: () => void;
  /** 首页当前选中的分类，TopBar 与 HomePage 共享。 */
  homeCategory: string;
  setHomeCategory: (category: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  mobileNavOpen: false,
  openMobileNav: () => set({ mobileNavOpen: true }),
  closeMobileNav: () => set({ mobileNavOpen: false }),
  homeCategory: '发现',
  setHomeCategory: (category) => set({ homeCategory: category }),
}));