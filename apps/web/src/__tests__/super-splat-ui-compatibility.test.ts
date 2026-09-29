/**
 * FIX-03 §13/§16 — SuperSplat UI Compatibility Layer 契约测试。
 *
 * 单一文件集中管理官方内部 class CSS/DOM hack（§12）的契约校验：
 *   - 官方 annotation 层 / hotspot 真实存在（SSV-06 ui:true 能力）→ 必须 FAIL 于 class 变化；
 *   - 官方 chrome（.sse-ui）存在但按设计隐藏；
 *   - 锁定依赖版本声明匹配（升级依赖前必须重新验证）。
 */
import { describe, expect, it } from 'vitest';
import {
  SUPERSPLAT_UI_PINNED_VERSION,
  OFFICIAL_UI_CHROME_CLASS,
  OFFICIAL_SCENE_LAYER_CLASS,
  OFFICIAL_HOTSPOT_CLASS,
  OFFICIAL_HOTSPOTS_CONTAINER_CLASS,
  UI_SCOPE_CLASS,
  UI_SCOPE_STYLE_ID,
  buildUiScopeCss,
  applyUiScopeStyles,
  validateUiCompatibility,
} from '../scene-runtime/superSplatUiCompatibility';

describe('SuperSplat UI Compatibility 契约', () => {
  it('锁定依赖声明匹配当前实现（§14：@playcanvas/supersplat-viewer@1.35.0）', () => {
    expect(SUPERSPLAT_UI_PINNED_VERSION).toBe('@playcanvas/supersplat-viewer@1.35.0');
  });

  it('作用域 CSS 单一来源：引用官方内部 class（.sse-ui 隐藏 / .sse-sceneLayer 保留）', () => {
    const css = buildUiScopeCss();
    expect(css).toContain(`.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS}`);
    expect(css).toContain(`.${UI_SCOPE_CLASS} .${OFFICIAL_SCENE_LAYER_CLASS}`);
    expect(css).toContain('display: none !important');
    expect(css).toContain('display: block !important');
  });

  it('applyUiScopeStyles → 宿主 class + 幂等注入样式（含内部 class 选择器）', () => {
    const container = document.createElement('div');
    applyUiScopeStyles(container);
    expect(container.classList.contains(UI_SCOPE_CLASS)).toBe(true);
    const style = document.getElementById(UI_SCOPE_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(OFFICIAL_UI_CHROME_CLASS);
    expect(style?.textContent).toContain(OFFICIAL_SCENE_LAYER_CLASS);

    // 幂等：再次调用不重复注入。
    document.head.appendChild(container);
    applyUiScopeStyles(container);
    expect(document.querySelectorAll(`#${UI_SCOPE_STYLE_ID}`)).toHaveLength(1);
  });

  it('契约校验：官方 hotspots 层存在 + chrome 存在（应被隐藏）→ 报告全部成立', () => {
    const root = document.createElement('div');
    const hotspotsContainer = document.createElement('div');
    hotspotsContainer.className = OFFICIAL_HOTSPOTS_CONTAINER_CLASS;
    for (let i = 0; i < 3; i += 1) {
      const h = document.createElement('button');
      h.className = OFFICIAL_HOTSPOT_CLASS;
      hotspotsContainer.appendChild(h);
    }
    const chrome = document.createElement('div');
    chrome.className = OFFICIAL_UI_CHROME_CLASS;
    const sceneLayer = document.createElement('div');
    sceneLayer.className = OFFICIAL_SCENE_LAYER_CLASS;
    sceneLayer.appendChild(hotspotsContainer);
    root.appendChild(sceneLayer);
    root.appendChild(chrome);

    const report = validateUiCompatibility(root);
    expect(report.hotspotsContainer).toBe(true);
    expect(report.hotspotCount).toBe(3);
    expect(report.chromeCount).toBe(1);
    expect(report.pinnedVersionMatches).toBe(true);
  });

  it('契约校验 FAIL 条件：官方 class 变化（如 hotspots 容器改名）→ 报告为假', () => {
    const root = document.createElement('div');
    // 官方将来若把 .sse-annotation-hotspots 改名为其他 class —— 契约必须暴露。
    const renamed = document.createElement('div');
    renamed.className = 'sse-annotation-hotspots-NEW';
    const h = document.createElement('button');
    h.className = OFFICIAL_HOTSPOT_CLASS;
    renamed.appendChild(h);
    root.appendChild(renamed);

    const report = validateUiCompatibility(root);
    expect(report.hotspotsContainer).toBe(false);
    expect(report.hotspotCount).toBe(0);
  });
});