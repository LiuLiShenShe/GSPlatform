/**
 * 场景 fixture 数据。
 * 仅用于 Phase 01 本地开发和组件测试，明确标注为占位数据，
 * 后端 /api/v1 接入后由 services 层替换，不会被当作真实 API 响应。
 */

export interface SceneSummary {
  id: string;
  title: string;
  author: string;
  category: '城市' | '建筑' | '室内' | '自然' | '人物' | '实验';
  splatCount: number;
  sizeMB: number;
  views: number;
  likes: number;
  status: 'READY' | 'PROCESSING' | 'FAILED';
  poster: string;
}

const CATEGORIES: SceneSummary['category'][] = [
  '城市',
  '建筑',
  '室内',
  '自然',
  '人物',
  '实验',
];

/**
 * 生成确定性 SVG 海报 data URI —— 项目自有占位图，不含第三方素材。
 * 使用 URL-safe 编码，可直接作为 <img src>。
 */
function posterSvg(
  title: string,
  gradientFrom: string,
  gradientTo: string,
): string {
  const encoded = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${gradientFrom}"/>`,
    `<stop offset="1" stop-color="${gradientTo}"/>`,
    `</linearGradient></defs>`,
    `<rect width="480" height="360" fill="url(#bg)"/>`,
    `<text x="24" y="328" font-size="16" fill="rgba(255,255,255,0.7)" font-family="sans-serif">local-fixture · ${title}</text>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml;utf8,${encodeURIComponent(encoded)}`;
}

function poster(
  title: string,
  pairIndex: number,
): string {
  const pairs = [
    ['#4A6FE3', '#1D4ED8'],
    ['#0EA5A4', '#0D9488'],
    ['#F59E0B', '#D97706'],
    ['#6366F1', '#4F46E5'],
    ['#EC4899', '#DB2777'],
    ['#8B5CF6', '#6D28D9'],
    ['#14B8A6', '#059669'],
    ['#EF4444', '#B91C1C'],
    ['#06B6D4', '#0891B2'],
    ['#84CC16', '#65A30D'],
    ['#F97316', '#EA580C'],
    ['#2563EB', '#1E40AF'],
  ];
  const [from, to] = pairs[pairIndex % pairs.length];
  return posterSvg(title, from, to);
}

export const sceneFixtures: SceneSummary[] = [
  {
    id: 'shanghai-lujiazui',
    title: '上海陆家嘴天际线',
    author: '城市扫描组',
    category: '城市',
    splatCount: 320_000,
    sizeMB: 480,
    views: 12_300,
    likes: 430,
    status: 'READY',
    poster: poster('陆家嘴', 0),
  },
  {
    id: 'tokyo-tower-sunset',
    title: '东京塔落日全景',
    author: '城市扫描组',
    category: '城市',
    splatCount: 510_000,
    sizeMB: 720,
    views: 28_100,
    likes: 890,
    status: 'READY',
    poster: poster('东京塔', 1),
  },
  {
    id: 'paris-notre-dame',
    title: '巴黎圣母院修复前采集',
    author: '历史建筑小组',
    category: '建筑',
    splatCount: 740_000,
    sizeMB: 1_100,
    views: 35_200,
    likes: 1_200,
    status: 'READY',
    poster: poster('圣母院', 2),
  },
  {
    id: 'modernist-villa',
    title: '现代主义别墅 exterior',
    author: '建筑可视化工作室',
    category: '建筑',
    splatCount: 280_000,
    sizeMB: 380,
    views: 8_600,
    likes: 310,
    status: 'READY',
    poster: poster('别墅', 3),
  },
  {
    id: 'studio-apartment',
    title: '小户型公寓全屋扫描',
    author: '室内设计频道',
    category: '室内',
    splatCount: 220_000,
    sizeMB: 310,
    views: 6_400,
    likes: 210,
    status: 'READY',
    poster: poster('公寓', 4),
  },
  {
    id: 'kitchen-showroom',
    title: '开放式厨房展厅',
    author: '室内设计频道',
    category: '室内',
    splatCount: 180_000,
    sizeMB: 240,
    views: 5_100,
    likes: 180,
    status: 'READY',
    poster: poster('厨房', 5),
  },
  {
    id: 'yosemite-valley',
    title: '优胜美地山谷徒步路线',
    author: '自然场景采集',
    category: '自然',
    splatCount: 860_000,
    sizeMB: 1_400,
    views: 42_000,
    likes: 2_100,
    status: 'READY',
    poster: poster('优胜美地', 6),
  },
  {
    id: 'guilin-karst',
    title: '桂林阳朔喀斯特地貌',
    author: '自然场景采集',
    category: '自然',
    splatCount: 650_000,
    sizeMB: 980,
    views: 19_800,
    likes: 740,
    status: 'READY',
    poster: poster('喀斯特', 7),
  },
  {
    id: 'portrait-studio-01',
    title: '棚拍人像全身采集',
    author: '数字人实验室',
    category: '人物',
    splatCount: 420_000,
    sizeMB: 560,
    views: 15_400,
    likes: 520,
    status: 'PROCESSING',
    poster: poster('棚拍', 8),
  },
  {
    id: 'candid-street-02',
    title: '街头抓拍半身场景',
    author: '数字人实验室',
    category: '人物',
    splatCount: 310_000,
    sizeMB: 410,
    views: 9_200,
    likes: 290,
    status: 'READY',
    poster: poster('街拍', 9),
  },
  {
    id: 'micro-scene-01',
    title: '高反光金属零件微距',
    author: '工业视觉组',
    category: '实验',
    splatCount: 95_000,
    sizeMB: 120,
    views: 3_100,
    likes: 95,
    status: 'READY',
    poster: poster('微距', 10),
  },
  {
    id: 'thermal-artifact',
    title: '热红外成像数据集可视化',
    author: '工业视觉组',
    category: '实验',
    splatCount: 150_000,
    sizeMB: 190,
    views: 2_800,
    likes: 70,
    status: 'FAILED',
    poster: poster('热红外', 11),
  },
];

export const sceneCategories = CATEGORIES;