import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useDocumentTitle } from '../hooks/useBreakpoints';

/**
 * 登录页 — 真实后端会话（HttpOnly Cookie + CSRF）。
 * 登录成功跳回 returnTo（若有）否则 /works。
 */
export default function LoginPage() {
  useDocumentTitle('登录');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, error, user } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) {
      const returnTo = searchParams.get('returnTo');
      navigate(returnTo && !returnTo.includes('/login') ? returnTo : '/works', {
        replace: true,
      });
    }
  }, [user, navigate, searchParams]);

  const onFinish = async (values: { email: string; password: string }) => {
    setSubmitting(true);
    try {
      await login(values.email, values.password);
    } catch {
      // error state handled by store
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="gs-auth-page">
      <div className="gs-auth-card">
        <Typography.Title level={3} style={{ textAlign: 'center', marginBottom: 4 }}>
          登录 GSPlatform
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          管理你的作品、收藏与分享
        </Typography.Paragraph>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: '请输入邮箱' },
              { type: 'email', message: '邮箱格式不正确' },
            ]}
          >
            <Input prefix={<MailOutlined aria-hidden />} placeholder="you@example.com" autoComplete="email" />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password prefix={<LockOutlined aria-hidden />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>

        <Typography.Paragraph style={{ textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
          还没有账号？<Link to="/register">注册</Link>
        </Typography.Paragraph>
      </div>
    </div>
  );
}
