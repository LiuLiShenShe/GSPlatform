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
  OFFICIAL_ANNOTATION_NAV_CLASS,
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

  describe('GS-NEXT-04：官方标注导览器改为放行（不隐藏）', () => {
    it('**不再整层隐藏** .sse-ui —— 否则子级无论如何都显示不出来', () => {
      const css = buildUiScopeCss();
      expect(css).not.toContain(
        `.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} { display: none !important; }`,
      );
      // 隐藏规则必须落在「.sse-ui 的直接子元素」上，且用 :not() 放行导览器。
      expect(css).toContain(
        `.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} > *:not(.${OFFICIAL_ANNOTATION_NAV_CLASS})`,
      );
    });

    it('**不对导览器本身设置 display** —— 官方靠 sse-hidden/sse-desktop 控制显隐', () => {
      const css = buildUiScopeCss();
      // 出现 `:not(.sse-annotationNav)` 是正确的（把它排除在隐藏之外）；
      // 出现「针对导览器自身的 display 规则」则是错的（会覆盖官方显隐逻辑）。
      const navDisplayRule = new RegExp(
        `\\.${OFFICIAL_ANNOTATION_NAV_CLASS}\\s*\\{[^}]*display`,
      );
      expect(css).not.toMatch(navDisplayRule);
    });

    it('用 :not() 白名单而非逐个枚举黑名单（官方新增 chrome 应自动被隐藏）', () => {
      const css = buildUiScopeCss();
      expect(css).not.toContain('sse-controlsWrap');
      expect(css).not.toContain('sse-settingsPanel');
      expect(css).not.toContain('sse-infoPanel');
    });
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

  /** 构造一份官方真实 DOM 结构（uiHtml 层级）：sceneLayer 与 ui 是兄弟。 */
  function buildOfficialDom(): HTMLElement {
    const root = document.createElement('div');
    const sceneLayer = document.createElement('div');
    sceneLayer.className = OFFICIAL_SCENE_LAYER_CLASS;
    const hotspotsContainer = document.createElement('div');
    hotspotsContainer.className = OFFICIAL_HOTSPOTS_CONTAINER_CLASS;
    for (let i = 0; i < 3; i += 1) {
      const h = document.createElement('button');
      h.className = OFFICIAL_HOTSPOT_CLASS;
      hotspotsContainer.appendChild(h);
    }
    sceneLayer.appendChild(hotspotsContainer);
    root.appendChild(sceneLayer);

    const chrome = document.createElement('div');
    chrome.className = OFFICIAL_UI_CHROME_CLASS;
    for (const cls of ['sse-controlsWrap', 'sse-joystickBase', 'sse-infoPanel']) {
      const child = document.createElement('div');
      child.className = cls;
      chrome.appendChild(child);
    }
    const nav = document.createElement('div');
    nav.className = `${OFFICIAL_ANNOTATION_NAV_CLASS} sse-hidden`;
    nav.appendChild(document.createElement('button'));
    chrome.appendChild(nav);
    root.appendChild(chrome);
    return root;
  }

  it('契约校验：官方 hotspots 层 + 导览器存在 + chrome 存在 → 报告全部成立', () => {
    const report = validateUiCompatibility(buildOfficialDom());
    expect(report.hotspotsContainer).toBe(true);
    expect(report.hotspotCount).toBe(3);
    expect(report.chromeCount).toBe(1);
    expect(report.annotationNav).toBe(true);
    expect(report.pinnedVersionMatches).toBe(true);
  });

  it('契约校验 FAIL：官方导览器改名/移除 → annotationNav 为假（不会静默丢失导览功能）', () => {
    const root = buildOfficialDom();
    root.querySelector(`.${OFFICIAL_ANNOTATION_NAV_CLASS}`)!.className = 'sse-annotationNav-NEW';
    expect(validateUiCompatibility(root).annotationNav).toBe(false);

    // 完全移除也一样必须暴露。
    const root2 = buildOfficialDom();
    root2.querySelector(`.${OFFICIAL_ANNOTATION_NAV_CLASS}`)!.remove();
    expect(validateUiCompatibility(root2).annotationNav).toBe(false);
  });

  it('契约校验 FAIL：导览器不再直接挂在 .sse-ui 下（`> *:not()` 放行不到）', () => {
    const root = buildOfficialDom();
    const nav = root.querySelector(`.${OFFICIAL_ANNOTATION_NAV_CLASS}`)!;
    // 挪到 sceneLayer 下（DOM 里挪动元素会改变层级）。
    root.querySelector(`.${OFFICIAL_SCENE_LAYER_CLASS}`)!.appendChild(nav);
    expect(validateUiCompatibility(root).annotationNav).toBe(false);
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