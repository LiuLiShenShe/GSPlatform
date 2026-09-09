import { Card, Typography, Button } from 'antd';
import { Link } from 'react-router-dom';

const { Title, Paragraph } = Typography;

export default function Home() {
  return (
    <div>
      <Title level={3}>欢迎使用 GSPlatform</Title>
      <Paragraph>
        面向 3D Gaussian Splatting 场景的 Web 平台：浏览公开场景、管理作品、上传已生成场景、提交免费计算任务。
      </Paragraph>
      <Button type="primary">
        <Link to="/upload">上传作品</Link>
      </Button>
      <Card title="场景卡片（Phase 01 实现 5 列网格）" style={{ marginTop: 16 }}>
        <Paragraph type="secondary">
          首页将展示公开场景的 5 列卡片网格。此占位内容将在 Phase 01 被真实数据替换。
        </Paragraph>
      </Card>
    </div>
  );
}
