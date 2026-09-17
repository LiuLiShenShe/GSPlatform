import { useEffect, useState } from 'react';
import { Button, Result, Spin, Typography } from 'antd';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';
import { resolveShareToken } from '../services/sharesApi';

type LoadState = 'loading' | 'error' | 'redirecting';

/**
 * 分享访问页 /s/:token — 解析分享 token 并跳转到对应场景。
 * 匿名可访问；失效/被撤销的链接给出明确错误提示。
 */
export default function ShareRedirectPage() {
  useDocumentTitle('分享场景');
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>('loading');
  const [errorText, setErrorText] = useState('');

  useEffect(() => {
    if (!token) {
      setState('error');
      setErrorText('链接缺少分享凭证。');
      return;
    }
    const controller = new AbortController();
    resolveShareToken(token, controller.signal)
      .then((res) => {
        const sceneId = String(res.scene?.slug ?? res.scene?.id ?? '');
        if (sceneId) {
          setState('redirecting');
          navigate(`/scene/${encodeURIComponent(sceneId)}`, { replace: true });
        } else {
          setState('error');
          setErrorText('分享内容已不存在。');
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 404) {
          setErrorText('分享链接不存在或已被撤销。');
        } else if (status === 410) {
          setErrorText('分享链接已过期。');
        } else {
          setErrorText('分享链接解析失败，请稍后重试。');
        }
        setState('error');
      });
    return () => controller.abort();
  }, [token, navigate]);

  if (state === 'loading') {
    return (
      <div className="gs-share-loading">
        <Spin tip="正在解析分享链接…">
          <div style={{ height: 60 }} />
        </Spin>
      </div>
    );
  }

  if (state === 'redirecting') {
    return (
      <div className="gs-share-loading">
        <Spin tip="正在打开场景…">
          <div style={{ height: 60 }} />
        </Spin>
      </div>
    );
  }

  return (
    <div className="gs-share-error">
      <Result
        status="404"
        title="无法打开分享"
        subTitle={errorText}
        extra={[
          <Button type="primary" key="home" onClick={() => navigate('/')}>
            返回首页
          </Button>,
          <Button key="contact">
            <Link to="/">联系创作者</Link>
          </Button>,
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
        或 <Link to="/login">登录</Link> 后继续浏览
      </Typography.Paragraph>
    </div>
  );
}
