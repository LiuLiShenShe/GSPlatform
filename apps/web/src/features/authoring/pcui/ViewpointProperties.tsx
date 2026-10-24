/**
 * ViewpointProperties —— 选中观察点（GSPlatform 数据）的 PCUI 属性区。
 *
 * Viewpoint 与 Annotation 是两类数据对象（GS-DESKTOP-02 §3.3），绝不合并：
 *   - 保留 CRUD / 排序 / 启停 / 初始选择 / 桌面导航 / XR 目的地映射；
 *   - 导航仍走官方 Viewer 的相机过渡（runtime.setCameraPose → 官方
 *     selectAnnotation 过渡），不自建第二套相机控制器；
 *   - 数据库 ID 不变。
 */
import { useEffect, useState } from 'react';
import { BooleanInput, Label, NumericInput, TextInput } from '@playcanvas/pcui/react';
import { PcuiField } from './PcuiField';
import { PcuiButton } from './PcuiButton';
import type { SceneViewpoint } from '../../../services/presentationApi';
import type { AuthoringCameraPose } from '../authoringTypes';

interface Props {
  viewpoint: SceneViewpoint;
  saving: boolean;
  onRename: (id: string, name: string) => Promise<void>;
  onToggleEnabled: (id: string, enabled: boolean) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onMove: (id: string, direction: -1 | 1) => Promise<void>;
  onNavigate: (vp: SceneViewpoint) => void;
  onGetCurrentPose: () => Promise<AuthoringCameraPose | null>;
  onUpdatePose: (id: string, pose: AuthoringCameraPose) => Promise<void>;
  onSetActive: (id: string | null) => void;
}

export function ViewpointProperties({
  viewpoint,
  saving,
  onRename,
  onToggleEnabled,
  onDelete,
  onMove,
  onNavigate,
  onGetCurrentPose,
  onUpdatePose,
  onSetActive,
}: Props) {
  const [name, setName] = useState(viewpoint.name);
  const [enabled, setEnabled] = useState(viewpoint.enabled);
  const [fov, setFov] = useState(viewpoint.fov);

  useEffect(() => {
    setName(viewpoint.name);
    setEnabled(viewpoint.enabled);
    setFov(viewpoint.fov);
  }, [viewpoint]);

  return (
    <div className="gs-props" data-testid="viewpoint-properties">
      <Label class="gs-props__title" text="观察点属性" />
      <PcuiField label="名称">
        <TextInput
          value={name}
          onChange={(v: string) => setName(v)}
        />
      </PcuiField>
      <PcuiField label="启用">
        <BooleanInput type="toggle" value={enabled} onChange={(v: boolean) => setEnabled(v)} />
      </PcuiField>
      <PcuiField label="FOV">
        <NumericInput
          value={fov}
          min={10}
          max={120}
          precision={0}
          step={1}
          onChange={(v: number) => setFov(v)}
        />
      </PcuiField>
      <PcuiField label="位置">
        <Label
          text={`(${viewpoint.position.x.toFixed(2)}, ${viewpoint.position.y.toFixed(2)}, ${viewpoint.position.z.toFixed(2)})`}
        />
      </PcuiField>
      <PcuiField label="目标">
        <Label
          text={`(${viewpoint.target.x.toFixed(2)}, ${viewpoint.target.y.toFixed(2)}, ${viewpoint.target.z.toFixed(2)})`}
        />
      </PcuiField>

      <div className="gs-props__row">
        <PcuiButton
          text={saving ? '保存中…' : '保存属性'}
          enabled={!saving}
          onClick={() => {
            void onRename(viewpoint.id, name.trim() || viewpoint.name);
            void onToggleEnabled(viewpoint.id, enabled);
            if (fov !== viewpoint.fov) {
              void onUpdatePose(viewpoint.id, {
                position: [viewpoint.position.x, viewpoint.position.y, viewpoint.position.z],
                target: [viewpoint.target.x, viewpoint.target.y, viewpoint.target.z],
                fov,
              });
            }
          }}
        />
        <PcuiButton
          text="用当前视角更新"
          onClick={() => {
            void onGetCurrentPose().then((pose) => {
              if (pose) return onUpdatePose(viewpoint.id, pose);
            });
          }}
        />
      </div>
      <div className="gs-props__row">
        <PcuiButton text="↑ 上移" onClick={() => void onMove(viewpoint.id, -1)} />
        <PcuiButton text="↓ 下移" onClick={() => void onMove(viewpoint.id, 1)} />
        <PcuiButton
          text="定位"
          onClick={() => {
            onSetActive(viewpoint.id);
            onNavigate(viewpoint);
          }}
        />
        <PcuiButton text="删除" class={['gs-props__danger']} onClick={() => void onDelete(viewpoint.id)} />
      </div>
    </div>
  );
}
