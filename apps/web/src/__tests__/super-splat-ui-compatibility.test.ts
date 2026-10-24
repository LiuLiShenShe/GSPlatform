/**
 * FIX-03 §13/§16 → GS-DESKTOP-02 —— SuperSplat UI Compatibility Layer 契约测试。
 *
 * GS-DESKTOP-02 起官方 Viewer 原生 UI **完整保留**（不再隐藏 chrome、不再由
 * 宿主自绘工具条）。本文件校验：
 *   - 官方 annotation 层 / hotspot 存在（SSV-06 ui:true 能力）；
 *   - 官方原生控件（工具条 / Reset / Frame / Orbit / Fly / Walk / Settings /
 *     Annotations / Info / 全屏）全部存在 —— class 变化即 FAIL；
 *   - 本层只保留**一条**内部 class 规则：Walk 安全闸门（尺度未校准）；
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
  OFFICIAL_CONTROLS_CLASS,
  OFFICIAL_RESET_BUTTON_CLASS,
  OFFICIAL_FRAME_BUTTON_CLASS,
  OFFICIAL_ORBIT_BUTTON_CLASS,
  OFFICIAL_FLY_BUTTON_CLASS,
  OFFICIAL_WALK_BUTTON_CLASS,
  OFFICIAL_SETTINGS_BUTTON_CLASS,
  OFFICIAL_ANNOTATIONS_ROW_CLASS,
  OFFICIAL_INFO_BUTTON_CLASS,
  OFFICIAL_FULLSCREEN_BUTTON_CLASS,
  UI_SCOPE_CLASS,
  UI_SCOPE_STYLE_ID,
  WALK_BLOCKED_CLASS,
  buildUiScopeCss,
  applyUiScopeStyles,
  setWalkGateBlocked,
  validateUiCompatibility,
} from '../scene-runtime/superSplatUiCompatibility';

describe('SuperSplat UI Compatibility 契约（GS-DESKTOP-02）', () => {
  it('锁定依赖声明匹配当前实现（@playcanvas/supersplat-viewer@1.35.0）', () => {
    expect(SUPERSPLAT_UI_PINNED_VERSION).toBe('@playcanvas/supersplat-viewer@1.35.0');
  });

  it('**不隐藏**官方 chrome：作用域 CSS 不再包含 .sse-ui 的 display:none 规则', () => {
    const css = buildUiScopeCss();
    expect(css).not.toContain(`.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} > *`);
    expect(css).not.toContain(`.${UI_SCOPE_CLASS} .${OFFICIAL_UI_CHROME_CLASS} { display: none`);
    expect(css).not.toContain(`.${OFFICIAL_ANNOTATION_NAV_CLASS}) { display: none`);
  });

  it('唯一保留的内部 class 规则是 Walk 安全闸门（尺度未校准 → 隐藏官方 Walk）', () => {
    const css = buildUiScopeCss();
    expect(css).toContain(`.${UI_SCOPE_CLASS}.${WALK_BLOCKED_CLASS}`);
    expect(css).toContain(`.${OFFICIAL_WALK_BUTTON_CLASS}`);
    // 只有一条 display:none（闸门）；其余官方控件不受影响。
    const hideRules = css.match(/display\s*:\s*none/g) ?? [];
    expect(hideRules).toHaveLength(1);
  });

  it('官方 hotspot 场景层显式保留（防止宿主全局 CSS 误伤）', () => {
    const css = buildUiScopeCss();
    expect(css).toContain(`.${UI_SCOPE_CLASS} .${OFFICIAL_SCENE_LAYER_CLASS}`);
    expect(css).toContain('display: block');
  });

  it('applyUiScopeStyles → 宿主 class + 幂等注入样式', () => {
    const container = document.createElement('div');
    applyUiScopeStyles(container);
    expect(container.classList.contains(UI_SCOPE_CLASS)).toBe(true);
    const style = document.getElementById(UI_SCOPE_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(OFFICIAL_WALK_BUTTON_CLASS);

    document.head.appendChild(container);
    applyUiScopeStyles(container);
    expect(document.querySelectorAll(`#${UI_SCOPE_STYLE_ID}`)).toHaveLength(1);
  });

  it('setWalkGateBlocked 只切换宿主 class，不改官方 DOM', () => {
    const container = document.createElement('div');
    applyUiScopeStyles(container);
    setWalkGateBlocked(container, true);
    expect(container.classList.contains(WALK_BLOCKED_CLASS)).toBe(true);
    setWalkGateBlocked(container, false);
    expect(container.classList.contains(WALK_BLOCKED_CLASS)).toBe(false);
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
    for (const cls of [
      OFFICIAL_CONTROLS_CLASS,
      'sse-joystickBase',
      'sse-infoPanel',
      'sse-settingsPanel',
    ]) {
      const child = document.createElement('div');
      child.className = cls;
      chrome.appendChild(child);
    }
    const controls = chrome.querySelector(`.${OFFICIAL_CONTROLS_CLASS}`)!;
    for (const cls of [
      OFFICIAL_ORBIT_BUTTON_CLASS,
      OFFICIAL_FLY_BUTTON_CLASS,
      OFFICIAL_WALK_BUTTON_CLASS,
      OFFICIAL_RESET_BUTTON_CLASS,
      OFFICIAL_FRAME_BUTTON_CLASS,
      OFFICIAL_SETTINGS_BUTTON_CLASS,
      OFFICIAL_INFO_BUTTON_CLASS,
      OFFICIAL_FULLSCREEN_BUTTON_CLASS,
      OFFICIAL_ANNOTATIONS_ROW_CLASS,
    ]) {
      const btn = document.createElement('button');
      btn.className = cls;
      controls.appendChild(btn);
    }
    const nav = document.createElement('div');
    nav.className = `${OFFICIAL_ANNOTATION_NAV_CLASS} sse-hidden`;
    nav.appendChild(document.createElement('button'));
    chrome.appendChild(nav);
    root.appendChild(chrome);
    return root;
  }

  it('契约校验：官方 hotspots + 导览器 + 全部原生控件 → 报告全部成立', () => {
    const report = validateUiCompatibility(buildOfficialDom());
    expect(report.hotspotsContainer).toBe(true);
    expect(report.hotspotCount).toBe(3);
    expect(report.chromeCount).toBe(1);
    expect(report.annotationNav).toBe(true);
    expect(report.pinnedVersionMatches).toBe(true);
    expect(report.officialControls).toEqual({
      controls: true,
      reset: true,
      frame: true,
      orbit: true,
      fly: true,
      walk: true,
      settings: true,
      annotationsToggle: true,
      info: true,
      fullscreen: true,
    });
  });

  it('契约校验 FAIL：官方控件改名/移除 → 对应字段为假（不会静默丢失能力）', () => {
    for (const [cls, field] of [
      [OFFICIAL_RESET_BUTTON_CLASS, 'reset'],
      [OFFICIAL_FRAME_BUTTON_CLASS, 'frame'],
      [OFFICIAL_WALK_BUTTON_CLASS, 'walk'],
      [OFFICIAL_SETTINGS_BUTTON_CLASS, 'settings'],
      [OFFICIAL_FULLSCREEN_BUTTON_CLASS, 'fullscreen'],
    ] as const) {
      const root = buildOfficialDom();
      root.querySelector(`.${cls}`)!.remove();
      expect(
        validateUiCompatibility(root).officialControls[field],
        `${cls} 缺失必须暴露`,
      ).toBe(false);
    }
  });

  it('契约校验 FAIL：官方导览器移除 → annotationNav 为假', () => {
    const root2 = buildOfficialDom();
    root2.querySelector(`.${OFFICIAL_ANNOTATION_NAV_CLASS}`)!.remove();
    expect(validateUiCompatibility(root2).annotationNav).toBe(false);
  });

  it('契约校验 FAIL 条件：官方 class 变化（如 hotspots 容器改名）→ 报告为假', () => {
    const root = document.createElement('div');
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
