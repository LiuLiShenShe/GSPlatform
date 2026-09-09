import { Card, Typography } from 'antd';

const { Title, Paragraph } = Typography;

export default function ComputePage() {
  return (
    <Card>
      <Title level={3}>免费计算</Title>
      <Paragraph type="secondary">
        免费计算说明、输入素材、参数确认与任务状态将在 Phase 01 / Phase 07 实现。
      </Paragraph>
    </Card>
  );
}
