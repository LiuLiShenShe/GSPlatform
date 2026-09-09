import { Card, Typography } from 'antd';

const { Title, Paragraph } = Typography;

export default function UploadPage() {
  return (
    <Card>
      <Title level={3}>上传作品</Title>
      <Paragraph type="secondary">
        作品信息、场景文件上传、可见性设置将在 Phase 01 / Phase 06 实现。
      </Paragraph>
    </Card>
  );
}
