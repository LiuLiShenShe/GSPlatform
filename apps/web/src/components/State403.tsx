import { Button, Result } from 'antd';
import { useNavigate } from 'react-router-dom';

/** 403 页面：无权限访问。 */
export default function State403() {
  const navigate = useNavigate();
  return (
    <Result
      status="403"
      title="403"
      subTitle="您没有权限访问该页面。"
      extra={
        <Button type="primary" onClick={() => navigate('/')}>
          返回首页
        </Button>
      }
    />
  );
}