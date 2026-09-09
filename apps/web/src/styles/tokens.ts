/**
 * GSPlatform 项目自有设计令牌 —— 颜色 / 间距 / 圆角 / 字体 / 阴影 / 动效 / 布局常量。
 * 未复制任何第三方产品主题或素材，全部为项目自行设计的视觉语言。
 */

export const colors = {
  primary: '#3E5BDB',
  primaryHover: '#5C76E4',
  primaryActive: '#2F47B4',
  accent: '#0E9E95',
  bg: '#F3F4F8',
  surface: '#FFFFFF',
  surfaceMuted: '#EDEFF5',
  border: '#DDE1EC',
  borderStrong: '#C5CCDA',
  textPrimary: '#1B2438',
  textSecondary: '#5A6478',
  textTertiary: '#8A93A8',
  success: '#169B5B',
  warning: '#C97B1E',
  danger: '#D54856',
  dangerSurface: '#FBEAEC',
  onDark: '#FFFFFF',
  sidebarBg: '#0F1B34',
  sidebarSurface: '#182649',
  sidebarText: '#A9B6CF',
  sidebarTextStrong: '#E6EBF5',
  posterOverlay: 'rgba(10, 16, 32, 0.45)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  huge: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
} as const;

export const fontFamily =
  "Inter, -apple-system, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Arial, sans-serif";

export const shadows = {
  card: '0 2px 10px rgba(16, 24, 64, 0.06)',
  popover: '0 8px 28px rgba(16, 24, 64, 0.16)',
} as const;

export const motion = {
  fast: '120ms',
  base: '200ms',
  slow: '320ms',
} as const;

export const layout = {
  siderWidth: 224,
  topbarHeight: 58,
} as const;

/** Ant Design v6 主题配置：以项目令牌覆盖 seed/component token，形成独立视觉风格。 */
export const antdTheme = {
  token: {
    colorPrimary: colors.primary,
    colorInfo: colors.primary,
    colorSuccess: colors.success,
    colorWarning: colors.warning,
    colorError: colors.danger,
    colorTextBase: colors.textPrimary,
    colorBgBase: colors.surface,
    colorBgLayout: colors.bg,
    colorBorder: colors.border,
    colorBorderSecondary: colors.border,
    borderRadius: 8,
    fontFamily,
  },
  components: {
    Layout: {
      headerBg: colors.surface,
      headerHeight: layout.topbarHeight,
      bodyBg: colors.bg,
    },
    Menu: {
      darkItemBg: colors.sidebarBg,
      darkSubMenuItemBg: colors.sidebarSurface,
      darkItemColor: colors.sidebarText,
      darkItemHoverColor: colors.sidebarTextStrong,
      darkItemSelectedBg: 'rgba(92, 118, 228, 0.22)',
      darkItemSelectedColor: colors.sidebarTextStrong,
      itemHeight: 40,
      collapsedWidth: 64,
    },
    Card: {
      paddingLG: 16,
      borderRadiusLG: radius.md,
    },
    Button: {
      borderRadiusSM: radius.sm,
      borderRadius: radius.sm,
    },
  },
} as const;