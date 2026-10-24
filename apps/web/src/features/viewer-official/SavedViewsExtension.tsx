/**
 * SavedViewsExtension —— GSPlatform 平台扩展入口（GS-DESKTOP-02 §2 Saved Views）。
 *
 * 官方 `@playcanvas/supersplat-viewer@1.35.0` 的 ExperienceSettings v2 只有
 * `cameras[0]`（初始相机）与 annotations[]（各自 camera），**没有**任意数量的
 * Saved Views 列表。Viewpoint 是 GSPlatform 的产品数据（数据库表），因此：
 *
 *   - 不把每个 Viewpoint 伪装成官方 annotation（会造成重复热点 / 导览器污染）；
 *   - 不复制官方相机控制算法（导航仍走官方 `selectAnnotation` 过渡，见
 *     SuperSplatRuntime.selectViewpoint）；
 *   - 只保留这个**小型 PCUI 扩展入口**，标题明确写「平台视角」以区别于官方控件。
 *
 * 导航：`onSelect(id)` → `useSuperSplatDesktop.selectViewpoint` → runtime
 * 把 SCENE 空间 pose 换算到 RUNTIME 空间后交给官方 CameraManager 过渡。
 */
import { Button, Container, Label } from '@playcanvas/pcui/react';
import type { RuntimeViewpoint } from '../../scene-runtime/types';

interface Props {
  viewpoints: RuntimeViewpoint[];
  onSelect: (viewpointId: string) => boolean | void;
}

export function SavedViewsExtension({ viewpoints, onSelect }: Props) {
  // 与 FIX-02 §10 一致：只列 enabled，按 orderIndex 排序。
  const enabled = viewpoints
    .filter((vp) => vp.enabled !== false)
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex);

  if (enabled.length === 0) return null;

  return (
    <Container class="gs-saved-views" flexDirection="column">
      <Label class="gs-saved-views__title" text={`平台视角 · ${enabled.length}`} />
      {/* e2e/旧版语义锚点：视角列表始终展开（PCUI），点击名称即导航。 */}
      <div data-testid="ov-saved-views" className="gs-saved-views__trigger">
        <Label text={`视角 (${enabled.length})`} />
      </div>
      <Container class="gs-saved-views__list" flexDirection="column">
        {enabled.map((vp) => (
          <Button
            key={vp.id}
            text={vp.name || '未命名视角'}
            onClick={() => {
              onSelect(vp.id);
            }}
          />
        ))}
      </Container>
    </Container>
  );
}
