import { Card, Typography, Descriptions, Tag } from 'antd';
import { CheckCircleOutlined } from '@ant-design/icons';

const { Title, Paragraph } = Typography;

const buildInfo = {
  name: 'GSPlatform Web',
  version: '0.1.0',
  framework: 'React 19 + TypeScript + Vite',
  ui: 'Ant Design',
  state: 'Zustand',
  http: 'Axios',
  routing: 'React Router',
  environment: import.meta.env.MODE,
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8001',
};

export default function HealthUI() {
  return (
    <Card>
      <Title level={3}>Web Build Health</Title>
      <Paragraph>
        <Tag color="success" icon={<CheckCircleOutlined />}>
          UI 服务正常
        </Tag>
      </Paragraph>
      <Descriptions column={1} bordered size="middle">
        <Descriptions.Item label="应用名称">{buildInfo.name}</Descriptions.Item>
        <Descriptions.Item label="版本">{buildInfo.version}</Descriptions.Item>
        <Descriptions.Item label="框架">{buildInfo.framework}</Descriptions.Item>
        <Descriptions.Item label="UI 组件库">{buildInfo.ui}</Descriptions.Item>
        <Descriptions.Item label="状态管理">{buildInfo.state}</Descriptions.Item>
        <Descriptions.Item label="HTTP 客户端">{buildInfo.http}</Descriptions.Item>
        <Descriptions.Item label="路由">{buildInfo.routing}</Descriptions.Item>
        <Descriptions.Item label="构建环境">{buildInfo.environment}</Descriptions.Item>
        <Descriptions.Item label="API 地址">{buildInfo.apiBaseUrl}</Descriptions.Item>
      </Descriptions>
    </Card>
  );
}
