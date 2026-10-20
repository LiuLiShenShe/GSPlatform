/**
 * VersionPanel — 历史版本列表 + 回滚（GS-NEXT-11 §6）。
 *
 * 只做一件事：让所有者看清「现在正在展示哪个版本」，并把当前版本切换回某个
 * **已存在**的不可变版本。切换不会重新生成 SOG、不会改历史 manifest、不会
 * 删除旧版本。
 *
 * 切换成功后必须：
 *   1. 立刻回读场景详情与运行时描述符（`onSwitched`），让预览/列表显示真实
 *      的新版本 —— 不做「请求成功即认为已切换」的乐观假设；
 *   2. 明确告知用户空间配置（初始视角/观察点/标注/碰撞）已失效，需要重新确认。
 */
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, List, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd';
import { HistoryOutlined, ReloadOutlined, RollbackOutlined } from '@ant-design/icons';
import {
  activateSceneVersion,
  listSceneVersions,
  type SceneVersionItem,
  type SceneVersionList,
} from '../../services/versionApi';
import { toApiError } from '../../services/http';

const { Text } = Typography;

const FORMAT_LABEL: Record<string, string> = {
  sog: '单文件 SOG',
  'streamed-sog': '流式 SOG',
  ply: 'PLY',
  splat: 'SPLAT',
};

function formatSize(bytes: number): string {
  if (!bytes) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${String(bytes)} B`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatCount(value: number | null | undefined): string {
  if (value == null || value <= 0) return '—';
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`;
  return String(value);
}

function availability(item: SceneVersionItem): { ok: boolean; reason: string | null } {
  if (!item.assetsReady) return { ok: false, reason: '资产文件缺失，无法切换' };
  if (!item.manifestReady) return { ok: false, reason: '发布清单缺失，无法切换' };
  return { ok: true, reason: null };
}

type Feedback = { kind: 'success' | 'error' | 'conflict'; text: string };

interface Props {
  sceneId: string;
  /** 切换成功（或失败后）需要上层刷新场景详情 + 运行时描述符。 */
  onSwitched: (result: { currentVersionId: string; spatialStale: boolean }) => void;
}

export function VersionPanel({ sceneId, onSwitched }: Props) {
  const [data, setData] = useState<SceneVersionList | null>(null);
  const [loading, setLoading] = useState(true);
  const [activating, setActivating] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const listing = await listSceneVersions(sceneId, { limit: 50, signal });
        setData(listing);
      } catch (error) {
        if (!signal?.aborted) {
          setFeedback({ kind: 'error', text: toApiError(error).message });
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [sceneId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleActivate = useCallback(
    async (item: SceneVersionItem) => {
      if (!data) return;
      const expected = data.currentVersionId;
      setActivating(item.id);
      setFeedback(null);
      try {
        const result = await activateSceneVersion(sceneId, item.id, expected);
        setFeedback({
          kind: 'success',
          text: result.changed
            ? `已切换到 ${formatTime(item.createdAt)} 的版本`
            : '该版本已是当前版本',
        });
        // 重新读取列表（当前标记）= 服务器真相，而不是本地猜。
        await load();
        onSwitched({ currentVersionId: result.currentVersionId, spatialStale: result.spatial.state === 'STALE' });
      } catch (error) {
        const api = toApiError(error);
        if (api.status === 409) {
          setFeedback({
            kind: 'conflict',
            text: '当前版本已被其他操作（后台发布 / 另一个窗口）改变，列表已刷新，请确认后再切换。',
          });
          await load();
          onSwitched({
            currentVersionId: data.currentVersionId ?? '',
            spatialStale: false,
          });
        } else if (api.status === 404) {
          setFeedback({ kind: 'error', text: '目标版本不存在或不属于该场景' });
          await load();
        } else {
          setFeedback({ kind: 'error', text: api.message });
        }
      } finally {
        setActivating(null);
      }
    },
    [data, sceneId, load, onSwitched],
  );

  const spatial = data?.spatial;
  const items = data?.items ?? [];
  const current = items.find((item) => item.isCurrent) ?? null;

  return (
    <div className="authoring-panel" data-testid="version-panel">
      <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
        <Space>
          <HistoryOutlined aria-hidden />
          <Text strong>历史版本</Text>
          <Tag>{items.length}</Tag>
        </Space>
        <Button
          size="small"
          icon={<ReloadOutlined aria-hidden />}
          onClick={() => void load()}
          loading={loading}
          data-testid="version-refresh"
        >
          刷新
        </Button>
      </Space>

      {spatial?.state === 'STALE' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          data-testid="version-spatial-stale"
          message="空间配置需要重新确认"
          description="切换版本后，已保存的初始视角 / 观察点 / 标注 / 碰撞可能不再对应新的几何体，运行时已按保守策略停用它们。请重新核对并保存初始视角、观察点与标注，碰撞/尺度标定需要重新构建后再启用行走。"
        />
      )}

      {feedback && (
        <Alert
          type={feedback.kind === 'error' ? 'error' : feedback.kind === 'conflict' ? 'warning' : 'success'}
          showIcon
          closable
          onClose={() => setFeedback(null)}
          style={{ marginBottom: 8 }}
          message={feedback.text}
          data-testid="version-feedback"
        />
      )}

      {items.length === 0 && !loading && (
        <Text type="secondary" data-testid="version-empty">
          暂无历史版本。发布作品后，每次发布的版本都会出现在这里。
        </Text>
      )}

      <List
        size="small"
        dataSource={items}
        renderItem={(item) => {
          const { ok, reason } = availability(item);
          const isCurrent = item.isCurrent;
          return (
            <List.Item
              data-testid={`version-item-${item.id}`}
              data-current={isCurrent ? 'true' : 'false'}
              actions={[
                isCurrent ? (
                  <Tag key="cur" color="success" data-testid={`version-current-${item.id}`}>
                    当前版本
                  </Tag>
                ) : (
                  <Popconfirm
                    key="act"
                    title="切换到这个历史版本？"
                    description={
                      <div style={{ maxWidth: 280 }}>
                        场景会立即改用该版本渲染。不会重新生成模型、不会修改或删除其他版本。
                        <br />
                        切换后，初始视角 / 观察点 / 标注 / 碰撞需要重新确认。
                      </div>
                    }
                    okText="确认切换"
                    cancelText="取消"
                    disabled={!ok}
                    onConfirm={() => handleActivate(item)}
                  >
                    <Tooltip title={reason ?? ''}>
                      <Button
                        size="small"
                        icon={<RollbackOutlined aria-hidden />}
                        loading={activating === item.id}
                        disabled={!ok || activating !== null}
                        data-testid={`version-activate-${item.id}`}
                      >
                        切换到此版本
                      </Button>
                    </Tooltip>
                  </Popconfirm>
                ),
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={6} wrap>
                    <Text>{formatTime(item.createdAt)}</Text>
                    {isCurrent && <Tag color="success">当前</Tag>}
                    <Tag>{FORMAT_LABEL[item.format] ?? item.format}</Tag>
                    {!item.assetsReady && <Tag color="error">资产缺失</Tag>}
                    {item.assetsReady && !item.manifestReady && <Tag color="warning">清单缺失</Tag>}
                  </Space>
                }
                description={
                  <Space size={12} wrap>
                    <Text type="secondary">大小 {formatSize(item.sizeBytes)}</Text>
                    <Text type="secondary">高斯点 {formatCount(item.gaussianCount)}</Text>
                    {item.lodLevels != null && (
                      <Text type="secondary">{item.lodLevels} 级 LOD</Text>
                    )}
                    {item.entryName && <Text type="secondary">{item.entryName}</Text>}
                  </Space>
                }
              />
            </List.Item>
          );
        }}
      />

      {current && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          当前正在展示：{formatTime(current.createdAt)} 的版本
        </Text>
      )}
    </div>
  );
}