import { useEffect, useRef, useState } from 'react';
import {
  App,
  Button,
  Descriptions,
  Divider,
  Empty,
  Input,
  List,
  Modal,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CommentOutlined,
  EyeOutlined,
  InfoCircleOutlined,
  LinkOutlined,
  ShareAltOutlined,
  StarFilled,
  StarOutlined,
  StopOutlined,
} from '@ant-design/icons';
import type { SceneSummary } from '../../fixtures/scenes';
import {
  addFavorite,
  removeFavorite,
  fetchFavoriteStatus,
} from '../../services/favoritesApi';
import { createShare, listShares, revokeShare } from '../../services/sharesApi';
import {
  askSceneAssistant,
  type AssistantResponse,
} from '../../services/assistantApi';
import { useAuthStore } from '../../stores/authStore';

interface ViewerRightPanelProps {
  scene: SceneSummary | undefined;
}

type FavState = 'checked' | 'unchecked' | 'checking';
type ShareState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };
type AskState =
  | { kind: 'idle' }
  | { kind: 'asking'; question: string }
  | { kind: 'done'; data: AssistantResponse; question: string }
  | { kind: 'error'; message: string; question: string };

const ASK_HINTS = [
  '这个场景的主要内容是什么？',
  '有哪些可能存在的数据采集问题？',
  '推荐如何查看这个场景？',
];

/**
 * Viewer 右侧工具面板：作者 / 收藏 / 分享 / 问 AI / 详情。
 * Phase 08 全部接入真实后端 API；未登录时分享与问 AI 仍然可用，
 * 收藏需要登录（由 401 拦截器引导）。
 */
export function ViewerRightPanel({ scene }: ViewerRightPanelProps) {
  const { message, modal } = App.useApp();
  const user = useAuthStore((s) => s.user);
  const sceneSlug = scene?.id;

  // 收藏状态（需要登录；匿名访客直接显示未收藏，避免 401 拦截器误跳转）
  const [fav, setFav] = useState<FavState>('checking');
  useEffect(() => {
    if (!sceneSlug) return;
    if (!user) {
      setFav('unchecked');
      return;
    }
    const controller = new AbortController();
    setFav('checking');
    fetchFavoriteStatus([sceneSlug], controller.signal)
      .then((status) => {
        if (!controller.signal.aborted) {
          setFav(status[sceneSlug] ? 'checked' : 'unchecked');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFav('unchecked');
      });
    return () => controller.abort();
  }, [sceneSlug, user]);

  // 分享状态（需要登录才能创建/列出）
  const [share, setShare] = useState<ShareState>({ kind: 'idle' });
  const [shareList, setShareList] = useState<Array<{ id: string; expiresAt: string | null }>>([]);
  const shareListedRef = useRef(false);

  const refreshShareList = async (): Promise<void> => {
    if (!sceneSlug || !user) return;
    const links = await listShares(sceneSlug);
    setShareList(links.map((l) => ({ id: l.id, expiresAt: l.expiresAt })));
  };

  const doShare = async (hours?: number): Promise<void> => {
    if (!sceneSlug || !user) return;
    setShare({ kind: 'creating' });
    try {
      const created = await createShare(sceneSlug, hours);
      // raw token 仅在创建响应中出现一次（服务端只存 hash），因此只在这里展示并复制。
      if (created.token) {
        Modal.success({
          title: '分享链接已创建',
          content: (
            <Space direction="vertical" size={8}>
              <Typography.Paragraph style={{ margin: 0 }} copyable={{ text: created.shareUrl }}>
                {created.shareUrl}
              </Typography.Paragraph>
              <Typography.Text type="secondary">
                token 仅显示一次，请立即复制保存。分享后可在此面板撤销，或创建时指定过期时间。
              </Typography.Text>
            </Space>
          ),
        });
      } else {
        message.success('公开场景可通过平台链接直接访问，无需分享凭证');
      }
      await refreshShareList();
      setShare({ kind: 'ready' });
      shareListedRef.current = true;
    } catch {
      setShare({ kind: 'error', message: '创建分享失败，请稍后重试。' });
    }
  };

  const openSharePanel = async (): Promise<void> => {
    if (!sceneSlug || !user) return;
    if (!shareListedRef.current) {
      try {
        await refreshShareList();
        shareListedRef.current = true;
        setShare({ kind: 'ready' });
        return;
      } catch {
        setShare({ kind: 'error', message: '加载分享列表失败，请稍后重试。' });
        return;
      }
    }
    // 已加载过：点分享直接新建一条
    void doShare();
  };

  const revokeOne = async (id: string): Promise<void> => {
    if (!sceneSlug) return;
    try {
      await revokeShare(sceneSlug, id);
      setShareList((prev) => prev.filter((l) => l.id !== id));
      message.success('已撤销该分享链接');
    } catch {
      message.error('撤销失败，请重试。');
    }
  };

  // 问 AI 状态
  const [ask, setAsk] = useState<AskState>({ kind: 'idle' });
  const [askText, setAskText] = useState('');
  const askControllerRef = useRef<AbortController | null>(null);

  const openAuthor = (): void => {
    modal.info({
      title: '作者信息',
      content: scene
        ? `${scene.author} · 已贡献 ${scene.views.toLocaleString()} 次浏览量的场景。`
        : '暂无作者信息。',
    });
  };

  const toggleFavorite = async (): Promise<void> => {
    if (!sceneSlug) return;
    if (!user) {
      message.warning('收藏需要登录。');
      window.location.href = `/login?returnTo=${encodeURIComponent(window.location.pathname)}`;
      return;
    }
    const prev = fav;
    const target = prev === 'checked' ? 'unchecked' : 'checked';
    setFav(target); // 乐观更新
    try {
      if (target === 'checked') {
        await addFavorite(sceneSlug);
      } else {
        await removeFavorite(sceneSlug);
      }
      message.success(target === 'checked' ? '已加入收藏' : '已取消收藏');
    } catch {
      setFav(prev); // 回滚
      message.error('操作失败，请重试。');
    }
  };

  const askQuestion = async (question: string): Promise<void> => {
    if (!sceneSlug || !question.trim()) return;
    askControllerRef.current?.abort();
    const controller = new AbortController();
    askControllerRef.current = controller;
    setAsk({ kind: 'asking', question: question.trim() });
    try {
      const data = await askSceneAssistant(sceneSlug, question.trim(), controller.signal);
      if (!controller.signal.aborted) {
        setAsk({ kind: 'done', data, question: question.trim() });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
        setAsk({ kind: 'error', message: '场景已不可用，请刷新后重试。', question: question.trim() });
      } else {
        setAsk({ kind: 'error', message: 'AI 暂时不可用，请稍后重试。', question: question.trim() });
      }
    }
  };

  const stopAsking = (): void => {
    askControllerRef.current?.abort();
  };

  const openDetails = (): void => {
    if (!scene) {
      message.info('暂无场景详情。');
      return;
    }
    modal.info({
      title: scene.title,
      width: 520,
      content: (
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="作者">{scene.author}</Descriptions.Item>
          <Descriptions.Item label="分类">{scene.category}</Descriptions.Item>
          <Descriptions.Item label="高斯点数">
            {scene.splatCount?.toLocaleString() ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="大小">{scene.sizeMB ?? '—'} MB</Descriptions.Item>
          <Descriptions.Item label="浏览">
            {scene.views?.toLocaleString() ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="点赞">
            {scene.likes?.toLocaleString() ?? '—'}
          </Descriptions.Item>
        </Descriptions>
      ),
    });
  };

  const shareCreating = share.kind === 'creating';

  return (
    <aside className="gs-viewer__right-panel" aria-label="场景操作面板">
      <Space orientation="vertical" size={6} style={{ width: '100%' }}>
        <Tooltip title={scene ? `查看作者 ${scene.author}` : '作者信息'}>
          <Button block type="text" icon={<EyeOutlined aria-hidden />} onClick={openAuthor}>
            作者
          </Button>
        </Tooltip>

        <Tooltip title={user ? '收藏 / 取消收藏' : '登录后收藏'}>
          <Button
            block
            type="text"
            icon={fav === 'checked' ? <StarFilled aria-hidden /> : <StarOutlined aria-hidden />}
            onClick={toggleFavorite}
            loading={fav === 'checking'}
          >
            {fav === 'checked' ? '已收藏' : '收藏'}
          </Button>
        </Tooltip>

        <Tooltip title="生成可分享、可撤销、可过期的链接">
          <Button
            block
            type="text"
            icon={<ShareAltOutlined aria-hidden />}
            onClick={() => void openSharePanel()}
            loading={shareCreating}
          >
            分享
          </Button>
        </Tooltip>

        <Tooltip title="基于场景内容向 AI 提问">
          <Button
            block
            type="text"
            icon={<CommentOutlined aria-hidden />}
            onClick={() => setAsk((a) => (a.kind === 'idle' || a.kind === 'asking' ? a : { kind: 'idle' }))}
          >
            问 AI
          </Button>
        </Tooltip>

        <Tooltip title="查看场景详情">
          <Button block type="text" icon={<InfoCircleOutlined aria-hidden />} onClick={openDetails}>
            详情
          </Button>
        </Tooltip>
      </Space>

      {/* 分享面板 */}
      {(share.kind === 'ready' || share.kind === 'error') && (
        <div className="gs-viewer-panel-section">
          <Divider style={{ margin: '8px 0' }} />
          <Space
            size={8}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              marginBottom: 4,
            }}
          >
            <Typography.Text strong style={{ fontSize: 13 }}>
              <LinkOutlined aria-hidden /> 分享
            </Typography.Text>
            {share.kind === 'error' && <Tag color="error">失败</Tag>}
          </Space>
          {share.kind === 'error' && (
            <Typography.Paragraph type="danger" style={{ margin: 0, fontSize: 12 }}>
              {share.message}
            </Typography.Paragraph>
          )}
          {share.kind === 'ready' && (
            <List
              size="small"
              dataSource={shareList}
              locale={{
                emptyText: (
                  <Empty
                    description="暂无活跃分享"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                ),
              }}
              renderItem={(link) => (
                <List.Item
                  key={link.id}
                  actions={[
                    <Button
                      key="revoke"
                      size="small"
                      danger
                      type="text"
                      icon={<StopOutlined aria-hidden />}
                      onClick={() => void revokeOne(link.id)}
                    >
                      撤销
                    </Button>,
                  ]}
                >
                  <Typography.Text style={{ fontSize: 12 }}>
                    {link.expiresAt
                      ? `到期 ${new Date(link.expiresAt).toLocaleDateString()}`
                      : '长期有效'}
                  </Typography.Text>
                </List.Item>
              )}
            />
          )}
          <Button
            block
            size="small"
            type="primary"
            ghost
            onClick={() => void doShare()}
            loading={shareCreating}
            style={{ marginTop: 8 }}
          >
            新建分享链接
          </Button>
        </div>
      )}

      {/* 问 AI 面板 */}
      {ask.kind === 'asking' && (
        <div className="gs-viewer-panel-section">
          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            <CommentOutlined aria-hidden /> 问 AI
          </Typography.Text>
          <Skeleton active paragraph={{ rows: 3 }} style={{ marginTop: 8 }} />
          <Button size="small" danger type="text" onClick={stopAsking}>
            停止
          </Button>
        </div>
      )}

      {ask.kind === 'done' && (
        <div className="gs-viewer-panel-section">
          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            <CommentOutlined aria-hidden /> 问 AI
          </Typography.Text>
          <Typography.Paragraph style={{ fontSize: 12, marginTop: 4 }}>
            Q: {ask.question}
          </Typography.Paragraph>
          <Typography.Paragraph
            style={{
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              maxHeight: 240,
              overflowY: 'auto',
            }}
          >
            {ask.data.answer}
          </Typography.Paragraph>
          <Space size={4} wrap>
            <Tag>模型 {ask.data.model}</Tag>
            <Tag>耗时 {ask.data.durationMs}ms</Tag>
          </Space>
          {ask.data.sources.length > 0 && (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                依据来源：
              </Typography.Text>
              <Space size={4} wrap>
                {ask.data.sources.map((src, i) => (
                  <Tag key={`${src}-${i}`} color="blue" style={{ fontSize: 11 }}>
                    {src}
                  </Tag>
                ))}
              </Space>
            </>
          )}
          {ask.data.contextSkipped.length > 0 && (
            <Typography.Paragraph type="warning" style={{ fontSize: 11, marginTop: 4 }}>
              已跳过不匹配的内容片段：{ask.data.contextSkipped.join('、')}
            </Typography.Paragraph>
          )}
          <Divider style={{ margin: '8px 0' }} />
          {ASK_HINTS.map((hint) => (
            <Button
              key={hint}
              size="small"
              type="link"
              style={{ display: 'block', textAlign: 'left', paddingLeft: 0 }}
              onClick={() => void askQuestion(hint)}
            >
              {hint}
            </Button>
          ))}
        </div>
      )}

      {ask.kind === 'error' && (
        <div className="gs-viewer-panel-section">
          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            <CommentOutlined aria-hidden /> 问 AI
          </Typography.Text>
          <Typography.Paragraph type="danger" style={{ fontSize: 12, marginTop: 4 }}>
            {ask.message}
          </Typography.Paragraph>
          <Button
            size="small"
            type="primary"
            ghost
            onClick={() => void askQuestion(ask.question)}
          >
            重试
          </Button>
        </div>
      )}

      {ask.kind === 'idle' && sceneSlug && (
        <div className="gs-viewer-panel-section">
          <Divider style={{ margin: '8px 0' }} />
          <Typography.Text strong style={{ fontSize: 13 }}>
            问 AI 这个小场景
          </Typography.Text>
          <Space.Compact block style={{ marginTop: 8 }}>
            <Input
              placeholder="输入问题…"
              value={askText}
              onChange={(e) => setAskText(e.target.value)}
              onPressEnter={() => void askQuestion(askText)}
              aria-label="向 AI 提问"
            />
            <Button
              type="primary"
              onClick={() => void askQuestion(askText)}
              disabled={!askText.trim()}
            >
              发送
            </Button>
          </Space.Compact>
          <Space size={4} wrap style={{ marginTop: 6 }}>
            {ASK_HINTS.slice(0, 2).map((hint) => (
              <Button
                key={hint}
                size="small"
                type="link"
                style={{ paddingLeft: 0 }}
                onClick={() => {
                  setAskText(hint);
                  void askQuestion(hint);
                }}
              >
                {hint}
              </Button>
            ))}
          </Space>
        </div>
      )}
    </aside>
  );
}