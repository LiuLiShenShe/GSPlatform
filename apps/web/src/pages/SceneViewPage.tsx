import { Card, Typography } from 'antd';
import { useParams } from 'react-router-dom';

const { Title, Paragraph } = Typography;

export default function SceneViewPage() {
  const { sceneId } = useParams<{ sceneId: string }>();

  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Card style={{ margin: 24 }}>
        <Title level={3}>Scene Viewer</Title>
        <Paragraph type="secondary">
          正在加载场景 <code>{sceneId}</code> —— 全屏 Viewer 将在 Phase 02 集成 SuperSplat fork。
        </Paragraph>
      </Card>
    </div>
  );
}
