import { Card, Typography } from 'antd';

const { Title, Paragraph } = Typography;

export default function MyWorksPage() {
  return (
    <Card>
      <Title level={3}>我的作品</Title>
      <Paragraph type="secondary">
        作品列表、状态筛选、继续编辑 / 查看 / 删除功能将在 Phase 01 实现。
      </Paragraph>
    </Card>
  );
}
