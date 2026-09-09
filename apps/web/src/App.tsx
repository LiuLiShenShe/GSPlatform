import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { ConfigProvider, Layout, Menu } from 'antd';
import { HomeOutlined, CloudOutlined, UploadOutlined, UserOutlined, AppstoreOutlined } from '@ant-design/icons';
import HealthUI from './pages/HealthUI';
import Home from './pages/Home';
import UploadPage from './pages/UploadPage';
import ComputePage from './pages/ComputePage';
import MyWorksPage from './pages/MyWorksPage';
import SceneViewPage from './pages/SceneViewPage';

const { Header, Content, Sider } = Layout;

const MENU_ITEMS = [
  { key: '/', icon: <HomeOutlined />, label: <Link to="/">首页</Link> },
  { key: '/works', icon: <AppstoreOutlined />, label: <Link to="/works">我的作品</Link> },
  { key: '/upload', icon: <UploadOutlined />, label: <Link to="/upload">上传作品</Link> },
  { key: '/compute', icon: <CloudOutlined />, label: <Link to="/compute">免费计算</Link> },
  { key: '/health-ui', icon: <UserOutlined />, label: <Link to="/health-ui">Health UI</Link> },
];

function AppLayout() {
  const location = useLocation();
  const isSceneView = location.pathname.startsWith('/scene/');

  if (isSceneView) {
    return (
      <Routes>
        <Route path="/scene/:sceneId" element={<SceneViewPage />} />
      </Routes>
    );
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        theme="dark"
        breakpoint="lg"
        collapsedWidth={80}
        style={{ position: 'fixed', top: 0, bottom: 0, zIndex: 100 }}
      >
        <div style={{ color: '#fff', padding: '16px', fontWeight: 700, fontSize: 18 }}>
          GSPlatform
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENU_ITEMS}
        />
      </Sider>
      <Layout style={{ marginLeft: 200 }}>
        <Header style={{ background: '#fff', padding: '0 24px' }}>
          <h2 style={{ margin: 0, lineHeight: '64px' }}>
            {MENU_ITEMS.find((i) => i.key === location.pathname)?.key?.slice(1) || 'GSPlatform'}
          </h2>
        </Header>
        <Content style={{ margin: 24 }}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/works" element={<MyWorksPage />} />
            <Route path="/upload" element={<UploadPage />} />
            <Route path="/compute" element={<ComputePage />} />
            <Route path="/health-ui" element={<HealthUI />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

function App() {
  return (
    <ConfigProvider theme={{ token: { colorPrimary: '#1677ff' } }}>
      <BrowserRouter>
        <AppLayout />
      </BrowserRouter>
    </ConfigProvider>
  );
}

export default App;
