/**
 * CollisionPanel — collision asset management and real runtime capabilities (Phase 12 / FIX-03 §9/§10).
 *
 * FIX-03 §9/§10：官方 SuperSplat Walk 使用**固定物理参数**（gravity 9.8 m/s²、
 * capsuleHeight 1.5m、eyeHeight 1.3m、moveGroundSpeed 7m/s），官方 public API
 * 无 gravity/slopeLimitDegrees/stepOffset/playerHeight 可调接口 —— 这些参数在当前
 * runtime **不生效**。因此本面板只保留真实能力：
 *
 *   - Collision 启用开关（collisionEnabled → descriptor.collision.enabled →
 *     runtime 加载碰撞网格，真实生效）
 *   - INDOOR / OUTDOOR 构建策略（Select）
 *   - 构建碰撞 / 重建碰撞（异步任务）
 *
 * 重力/坡度限制/台阶高度/玩家高度 **不再以可调控件出现**（避免"看起来能配、
 * 实际无效"的虚假能力）；DB 字段保留向后兼容但构建请求不再携带（后端忽略）。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Card, Button, Select, Switch, Alert, Space, Typography, Spin, Checkbox } from 'antd';
import { ReloadOutlined, BuildOutlined } from '@ant-design/icons';
import {
  getCollision,
  buildCollision,
  updateCollision,
  rebuildCollision,
  type CollisionAsset,
} from '../../services/collisionApi';
import { getSceneProcessing, type SceneProcessingSettings } from '../../services/sceneProcessingApi';

const { Text } = Typography;

interface CollisionPanelProps {
  sceneId: string;
  isOwner: boolean;
}

/** FIX-03 §8/§9：官方 Walk 固定物理参数（只读展示，非可调能力）。 */
const FIXED_PHYSICS_NOTICE =
  '当前 runtime（@playcanvas/supersplat-viewer Walk）使用固定物理参数：重力 9.8 m/s²、' +
  '角色胶囊高 1.5 m、眼高 1.3 m、步行速度 7 m/s。重力/坡度限制/台阶高度/玩家高度' +
  '在官方 public API 中不可配置，以下参数对运行态无效：已停用（仅保留数据库兼容字段）';

const UNSUPPORTED_PARAMS = [
  { key: 'gravity', label: '重力 (m/s²)' },
  { key: 'slopeLimitDegrees', label: '坡度限制 (度)' },
  { key: 'stepOffset', label: '台阶高度 (米)' },
  { key: 'playerHeight', label: '玩家高度 (米)' },
] as const;

export const CollisionPanel: React.FC<CollisionPanelProps> = ({ sceneId, isOwner }) => {
  const [collision, setCollision] = useState<CollisionAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<'INDOOR' | 'OUTDOOR'>('OUTDOOR');
  const [collisionEnabled, setCollisionEnabled] = useState(false);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [processing, setProcessing] = useState<SceneProcessingSettings | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let disposed = false;
    setProcessing(null);
    setAcknowledged(false);
    setBuildError(null);
    getSceneProcessing(sceneId).then((value) => {
      if (!disposed) setProcessing(value);
    }).catch(() => {
      if (!disposed) setBuildError('处理策略读取失败，请刷新后重试');
    });
    return () => {
      disposed = true;
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    };
  }, [sceneId]);

  const fetchCollision = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getCollision(sceneId);
      setCollision(data);
      setMode(data.mode);
      setCollisionEnabled(data.collisionEnabled);
    } catch {
      // 404 means no collision asset yet
      setCollision(null);
    } finally {
      setLoading(false);
    }
  }, [sceneId]);

  useEffect(() => {
    fetchCollision();
  }, [fetchCollision]);

  const handleBuild = async () => {
    try {
      setBuilding(true);
      const request = { mode, acknowledge_unverified_scale: acknowledged };
      setBuildError(null);
      await buildCollision(sceneId, request);
      // Poll for status
      refreshTimer.current = setTimeout(fetchCollision, 2000);
    } catch (error) {
      console.error('Build failed:', error);
      setBuildError('碰撞构建请求失败；不影响已发布场景查看，请检查版本、尺度确认和资源预算');
    } finally {
      setBuilding(false);
    }
  };

  const handleRebuild = async () => {
    try {
      setBuilding(true);
      setBuildError(null);
      await rebuildCollision(sceneId, undefined, acknowledged);
      refreshTimer.current = setTimeout(fetchCollision, 2000);
    } catch (error) {
      console.error('Rebuild failed:', error);
      setBuildError('碰撞重建请求失败；不影响已发布场景查看');
    } finally {
      setBuilding(false);
    }
  };

  // FIX-03 §10：启用开关是真实能力（collisionEnabled → runtime 加载碰撞网格），
  // 切换即保存 —— 不再有"保存参数"按钮（物理参数不可调）。
  const handleToggleEnabled = async (checked: boolean) => {
    setCollisionEnabled(checked);
    try {
      setSavingEnabled(true);
      await updateCollision(sceneId, { collisionEnabled: checked });
      fetchCollision();
    } catch (error) {
      console.error('Update collision enabled failed:', error);
      fetchCollision();
    } finally {
      setSavingEnabled(false);
    }
  };

  if (loading) {
    return <Spin tip="加载碰撞设置..." />;
  }

  return (
    <Card title="碰撞设置" size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Alert type="info" message="场景处理策略" description={processing
          ? `类型：${processing.sceneType}；碰撞策略：${processing.collisionPolicy}；尺度：${processing.calibration.state}；未自动构建原因：${processing.collisionDecision?.reasonCode ?? '未知'}`
          : '正在读取服务端处理策略'} data-testid="collision-processing-policy" />
        {processing && !processing.calibration.physicalWalkAllowed && (
          <Alert type="warning" message="尚无有效米制标定，物理 Walk 禁用"
            description="可明确确认后生成非物理测试碰撞；ASSUMED 不代表 VERIFIED。碰撞失败不影响场景查看。" />
        )}
        {isOwner && !processing?.calibration.physicalWalkAllowed && (
          <Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)}>
            我确认仅生成非物理测试碰撞，不将场景单位当作真实米制
          </Checkbox>
        )}
        {buildError && <Alert type="error" message={buildError} />}
        {/* FIX-03 §9：注明官方 Walk 固定物理，以下参数不可配置 —— 不再显示可调控件 */}
        <Alert
          type="info"
          showIcon
          message="物理参数由官方 runtime 固定"
          description={
            <div>
              {FIXED_PHYSICS_NOTICE}
              <ul style={{ margin: '4px 0 0 18px', paddingLeft: 0 }}>
                {UNSUPPORTED_PARAMS.map((p) => (
                  <li key={p.key}>
                    <Text type="secondary" delete>{p.label}</Text>
                    <Text type="secondary"> （不支持）</Text>
                  </li>
                ))}
              </ul>
            </div>
          }
          data-testid="collision-unsupported-notice"
        />

        {!collision ? (
          <>
            <Text type="secondary">尚未创建碰撞资产</Text>
            <Space>
              <Select
                value={mode}
                onChange={setMode}
                style={{ width: 120 }}
                disabled={building}
              >
                <Select.Option value="OUTDOOR">户外</Select.Option>
                <Select.Option value="INDOOR">室内</Select.Option>
              </Select>
              <Button
                type="primary"
                icon={<BuildOutlined />}
                onClick={handleBuild}
                loading={building}
                disabled={!isOwner || !processing || (!processing.calibration.physicalWalkAllowed && !acknowledged)}
              >
                构建碰撞
              </Button>
            </Space>
          </>
        ) : (
          <>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Text>模式:</Text>
                <Select
                  value={mode}
                  onChange={setMode}
                  style={{ width: 120 }}
                  disabled={building}
                >
                  <Select.Option value="OUTDOOR">户外</Select.Option>
                  <Select.Option value="INDOOR">室内</Select.Option>
                </Select>
              </Space>

              <Space>
                <Text>启用碰撞:</Text>
                <Switch
                  checked={collisionEnabled}
                  onChange={handleToggleEnabled}
                  loading={savingEnabled}
                  disabled={building || !isOwner || !processing?.calibration.physicalWalkAllowed}
                  data-testid="collision-enabled-switch"
                />
              </Space>

              <Space>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={handleRebuild}
                  loading={building}
                  disabled={!isOwner || !processing || (!processing.calibration.physicalWalkAllowed && !acknowledged)}
                >
                  重建碰撞
                </Button>
              </Space>

              {collision.status === 'SUCCEEDED' && (
                <>
                  <Alert
                    message="碰撞已就绪"
                    description={`状态: ${collision.status}, 尝试次数: ${collision.attempt}`}
                    type="success"
                    showIcon
                  />
                  {/* FIX-05 §23/§25：世界变换在构建后改变 → STALE，walk 已禁用，
                      必须重建。官方 runtime 无法可靠重变换碰撞几何。 */}
                  {collision.stale && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Scene transform changed. Collision must be rebuilt."
                      description="场景世界变换在碰撞构建后发生改变，碰撞与场景不再对齐；Walk 入口已禁用，请点击「重建碰撞」后重新启用。"
                      data-testid="collision-stale-notice"
                    />
                  )}
                </>
              )}

              {collision.status === 'FAILED' && (
                <Alert
                  message="碰撞构建失败"
                  description={`${collision.errorMessage || '未知错误'}；碰撞失败不影响已发布场景查看`}
                  type="error"
                  showIcon
                />
              )}

              {collision.status === 'QUEUED' && (
                <Alert
                  message="碰撞构建中"
                  description="任务已排队，正在等待执行..."
                  type="info"
                  showIcon
                />
              )}
            </Space>
          </>
        )}
      </Space>
    </Card>
  );
};
