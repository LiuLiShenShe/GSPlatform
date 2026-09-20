/**
 * CollisionPanel — collision asset management and physics settings (Phase 12).
 */
import React, { useState, useEffect, useCallback } from 'react';
import { Card, Button, Select, InputNumber, Switch, Alert, Space, Typography, Spin } from 'antd';
import { ReloadOutlined, BuildOutlined } from '@ant-design/icons';
import {
  getCollision,
  buildCollision,
  updateCollision,
  rebuildCollision,
  type CollisionAsset,
  type CollisionBuildRequest,
} from '../../services/collisionApi';

const { Text, Link } = Typography;

interface CollisionPanelProps {
  sceneId: string;
  isOwner: boolean;
}

export const CollisionPanel: React.FC<CollisionPanelProps> = ({ sceneId, isOwner }) => {
  const [collision, setCollision] = useState<CollisionAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [mode, setMode] = useState<'INDOOR' | 'OUTDOOR'>('OUTDOOR');
  const [gravity, setGravity] = useState(9.81);
  const [slopeLimit, setSlopeLimit] = useState(45);
  const [stepOffset, setStepOffset] = useState(0.3);
  const [playerHeight, setPlayerHeight] = useState(1.8);
  const [collisionEnabled, setCollisionEnabled] = useState(false);

  const fetchCollision = useCallback(async () => {
    try {
      setLoading(true);
      const data = await getCollision(sceneId);
      setCollision(data);
      setMode(data.mode);
      setGravity(data.gravity);
      setSlopeLimit(data.slopeLimitDegrees);
      setStepOffset(data.stepOffset);
      setPlayerHeight(data.playerHeight);
      setCollisionEnabled(data.collisionEnabled);
    } catch (error) {
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
      const request: CollisionBuildRequest = {
        mode,
        gravity,
        slopeLimitDegrees: slopeLimit,
        stepOffset,
        playerHeight,
      };
      await buildCollision(sceneId, request);
      // Poll for status
      setTimeout(fetchCollision, 2000);
    } catch (error) {
      console.error('Build failed:', error);
    } finally {
      setBuilding(false);
    }
  };

  const handleRebuild = async () => {
    try {
      setBuilding(true);
      await rebuildCollision(sceneId);
      setTimeout(fetchCollision, 2000);
    } catch (error) {
      console.error('Rebuild failed:', error);
    } finally {
      setBuilding(false);
    }
  };

  const handleUpdateParams = async () => {
    try {
      await updateCollision(sceneId, {
        gravity,
        slopeLimitDegrees: slopeLimit,
        stepOffset,
        playerHeight,
        collisionEnabled,
      });
      fetchCollision();
    } catch (error) {
      console.error('Update failed:', error);
    }
  };

  if (loading) {
    return <Spin tip="加载碰撞设置..." />;
  }

  return (
    <Card title="碰撞设置" size="small">
      <Space direction="vertical" style={{ width: '100%' }}>
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
                disabled={!isOwner}
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
                <Text>重力 (m/s²):</Text>
                <InputNumber
                  value={gravity}
                  onChange={(v) => setGravity(v ?? 9.81)}
                  min={0}
                  max={20}
                  step={0.1}
                  disabled={building}
                />
              </Space>

              <Space>
                <Text>坡度限制 (度):</Text>
                <InputNumber
                  value={slopeLimit}
                  onChange={(v) => setSlopeLimit(v ?? 45)}
                  min={0}
                  max={90}
                  step={5}
                  disabled={building}
                />
              </Space>

              <Space>
                <Text>台阶高度 (米):</Text>
                <InputNumber
                  value={stepOffset}
                  onChange={(v) => setStepOffset(v ?? 0.3)}
                  min={0}
                  max={2}
                  step={0.1}
                  disabled={building}
                />
              </Space>

              <Space>
                <Text>玩家高度 (米):</Text>
                <InputNumber
                  value={playerHeight}
                  onChange={(v) => setPlayerHeight(v ?? 1.8)}
                  min={0.5}
                  max={3}
                  step={0.1}
                  disabled={building}
                />
              </Space>

              <Space>
                <Text>启用碰撞:</Text>
                <Switch
                  checked={collisionEnabled}
                  onChange={setCollisionEnabled}
                  disabled={building}
                />
              </Space>

              <Space>
                <Button
                  onClick={handleUpdateParams}
                  disabled={building || !isOwner}
                >
                  保存参数
                </Button>
                <Button
                  icon={<ReloadOutlined />}
                  onClick={handleRebuild}
                  loading={building}
                  disabled={!isOwner}
                >
                  重建碰撞
                </Button>
              </Space>

              {collision.status === 'SUCCEEDED' && (
                <Alert
                  message="碰撞已就绪"
                  description={`状态: ${collision.status}, 尝试次数: ${collision.attempt}`}
                  type="success"
                  showIcon
                />
              )}

              {collision.status === 'FAILED' && (
                <Alert
                  message="碰撞构建失败"
                  description={collision.errorMessage || '未知错误'}
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
