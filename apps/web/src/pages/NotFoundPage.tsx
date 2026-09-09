import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useBreakpoints';

/** 404 页面。 */
export default function NotFoundPage() {
  useDocumentTitle('页面不存在');
  const navigate = useNavigate();

  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在或已被移除。"
      extra={
        <Button type="primary" onClick={() => navigate('/')}>
          返回首页
        </Button>
      }
    />
  );
}