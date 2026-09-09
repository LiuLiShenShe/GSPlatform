/**
 * 我的作品 fixture —— Phase 01 仅用于验证 UI，后端接入后由 services 层替换。
 */

export interface WorkSummary {
  id: string;
  title: string;
  status: 'PUBLISHED' | 'DRAFT' | 'PROCESSING' | 'FAILED';
  updatedAt: string;
  progress: number | null;
  sceneId: string | null;
  poster: string;
}

function poster(title: string, from: string, to: string): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">`,
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0" stop-color="${from}"/>`,
    `<stop offset="1" stop-color="${to}"/>`,
    `</linearGradient></defs>`,
    `<rect width="480" height="360" fill="url(#bg)"/>`,
    `<text x="24" y="328" font-size="15" fill="rgba(255,255,255,0.7)" font-family="sans-serif">local-fixture · ${title}</text>`,
    `</svg>`,
  ].join('');
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const myWorksFixtures: WorkSummary[] = [
  {
    id: 'work-01',
    title: '我的街拍作品 A',
    status: 'PUBLISHED',
    updatedAt: '2026-09-08',
    progress: null,
    sceneId: 'street-scene-a',
    poster: poster('街拍A', '#3E5BDB', '#1E40AF'),
  },
  {
    id: 'work-02',
    title: '我的街拍作品 B',
    status: 'PUBLISHED',
    updatedAt: '2026-09-07',
    progress: null,
    sceneId: 'street-scene-b',
    poster: poster('街拍B', '#0EA5A4', '#059669'),
  },
  {
    id: 'work-03',
    title: '古建筑内饰扫描',
    status: 'DRAFT',
    updatedAt: '2026-09-06',
    progress: null,
    sceneId: null,
    poster: poster('古建筑', '#F59E0B', '#D97706'),
  },
  {
    id: 'work-04',
    title: '高精度人物采集',
    status: 'DRAFT',
    updatedAt: '2026-09-05',
    progress: null,
    sceneId: null,
    poster: poster('人物采集', '#EC4899', '#DB2777'),
  },
  {
    id: 'work-05',
    title: '自然场景重建中',
    status: 'PROCESSING',
    updatedAt: '2026-09-08',
    progress: 43,
    sceneId: null,
    poster: poster('自然重建', '#6366F1', '#4F46E5'),
  },
  {
    id: 'work-06',
    title: '实验数据集导入失败',
    status: 'FAILED',
    updatedAt: '2026-09-04',
    progress: null,
    sceneId: null,
    poster: poster('实验', '#EF4444', '#B91C1C'),
  },
  {
    id: 'work-07',
    title: '室内环境拍摄',
    status: 'PUBLISHED',
    updatedAt: '2026-09-03',
    progress: null,
    sceneId: 'indoor-01',
    poster: poster('室内', '#14B8A6', '#0D9488'),
  },
  {
    id: 'work-08',
    title: '建筑外部结构扫描',
    status: 'PUBLISHED',
    updatedAt: '2026-09-02',
    progress: null,
    sceneId: 'building-01',
    poster: poster('建筑', '#8B5CF6', '#6D28D9'),
  },
  {
    id: 'work-09',
    title: '城市道路场景',
    status: 'PUBLISHED',
    updatedAt: '2026-09-01',
    progress: null,
    sceneId: 'city-road',
    poster: poster('城市', '#06B6D4', '#0891B2'),
  },
  {
    id: 'work-10',
    title: '户外风景项目',
    status: 'PUBLISHED',
    updatedAt: '2026-08-30',
    progress: null,
    sceneId: 'landscape-01',
    poster: poster('户外', '#84CC16', '#65A30D'),
  },
  {
    id: 'work-11',
    title: '二次拍摄采集',
    status: 'PUBLISHED',
    updatedAt: '2026-08-28',
    progress: null,
    sceneId: 'second-pass',
    poster: poster('二次拍摄', '#F97316', '#EA580C'),
  },
  {
    id: 'work-12',
    title: '旧版草稿（待清理）',
    status: 'DRAFT',
    updatedAt: '2026-08-20',
    progress: null,
    sceneId: null,
    poster: poster('草稿', '#2563EB', '#1E40AF'),
  },
];