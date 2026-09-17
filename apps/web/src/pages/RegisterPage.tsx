import { useState } from 'react';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { useDocumentTitle } from '../hooks/useBreakpoints';

/**
 * 注册页 — 创建真实后端账号（argon2 密码哈希 + 会话 Cookie）。
 */
export default function RegisterPage() {
  useDocumentTitle('注册');
  const navigate = useNavigate();
  const { register, error, clearError } = useAuthStore();
  const [submitting, setSubmitting] = useState(false);

  const onFinish = async (values: {
    email: string;
    password: string;
    confirm: string;
    displayName: string;
  }) => {
    setSubmitting(true);
    try {
      await register(values.email, values.password, values.displayName);
      navigate('/works', { replace: true });
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
          注册 GSPlatform
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ textAlign: 'center' }}>
          免费创建账号，发布你的 3D 高斯场景
        </Typography.Paragraph>

        {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />}

        <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
          <Form.Item
            name="displayName"
            label="显示名称"
            rules={[
              { required: true, message: '请输入显示名称' },
              { max: 120, message: '名称过长' },
            ]}
          >
            <Input prefix={<UserOutlined aria-hidden />} placeholder="你的昵称" maxLength={120} />
          </Form.Item>
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
            rules={[
              { required: true, message: '请输入密码' },
              { min: 8, message: '密码至少 8 位' },
            ]}
          >
            <Input.Password prefix={<LockOutlined aria-hidden />} placeholder="至少 8 位" autoComplete="new-password" />
          </Form.Item>
          <Form.Item
            name="confirm"
            label="确认密码"
            dependencies={['password']}
            rules={[
              { required: true, message: '请再次输入密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('password') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password prefix={<LockOutlined aria-hidden />} placeholder="再次输入密码" autoComplete="new-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting} onClick={clearError}>
            注册
          </Button>
        </Form>

        <Typography.Paragraph style={{ textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
          已有账号？<Link to="/login">登录</Link>
        </Typography.Paragraph>
      </div>
    </div>
  );
}
