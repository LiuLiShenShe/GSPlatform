/**
 * SSV-09 §7 — 回归护栏：生产 Web 不得引用 apps/viewer（legacy fork）。
 *
 * SSV-09 删除了 `?runtime=legacy` 回退与整条 ViewerAdapter 链路
 * （features/viewer/、services/scenes.local.ts），官方
 * @playcanvas/supersplat-viewer runtime 是唯一渲染路径。本测试在源码层强制
 * 这一点：任何生产源码的 import/require 目标都不得指向 legacy viewer 包或
 * 其目录，且构建/配置（vite.config、tsconfig、package.json）不得残留 alias、
 * embed 静态服务或 sync-assets 钩子。
 *
 * 注释里复述“已删除 legacy”不受影响 —— 只检查真正的模块引用与配置残留。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(import.meta.dirname, '../..');
const SRC = path.join(WEB_ROOT, 'src');

/** 生产源码的模块引用不得指向这些目标。 */
const FORBIDDEN_IMPORT = [
  /@gsplatform\/viewer/,
  /@gsplatform\/xr-viewer/,
  /(^|\/)features\/viewer\//,
  /scenes\.local/,
  /viewer\/embed/,
  /(^|\/)\.\.\/viewer\//,
];

const CODE_EXT = /\.(ts|tsx)$/;

/** 递归收集生产源码文件（跳过 __tests__ 自身，避免护栏自匹配）。 */
function collectProductionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === '__mocks__') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectProductionFiles(full));
    } else if (CODE_EXT.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** 提取 import/require/export-from 的模块 specifier。 */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

describe('SSV-09: 生产 Web 不引用 apps/viewer', () => {
  it('生产源码的 import/require 均不指向 legacy viewer', () => {
    const violations: string[] = [];
    for (const file of collectProductionFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const spec of importSpecifiers(src)) {
        if (FORBIDDEN_IMPORT.some((re) => re.test(spec))) {
          violations.push(`${path.relative(WEB_ROOT, file)} -> ${spec}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('Scene 页面不再读取 runtime=legacy 分支（只有官方路径）', () => {
    const page = readFileSync(path.join(SRC, 'pages/SceneViewerPage.tsx'), 'utf8');
    // 生产页面不得再按 ?runtime 切换 runtime
    expect(page).not.toMatch(/get\(\s*['"]runtime['"]\s*\)/);
  });

  it('构建/配置无 legacy alias、embed 静态服务或 sync 钩子', () => {
    const configs = [
      'vite.config.ts',
      'tsconfig.app.json',
      'package.json',
    ].map((f) => path.join(WEB_ROOT, f));
    const tokens = [
      /@gsplatform\/viewer/,
      /gs-serve-viewer-embed/,
      /sync-assets/,
      /viewer\/embed/,
      /\.\.\/viewer\/src/,
      /predev/,
      /prebuild/,
    ];
    const violations: string[] = [];
    for (const file of configs) {
      const src = readFileSync(file, 'utf8');
      for (const re of tokens) {
        if (re.test(src)) violations.push(`${path.basename(file)}: ${re}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
