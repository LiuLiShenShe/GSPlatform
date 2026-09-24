import { createBrowserRouter } from 'react-router-dom';
import PlatformLayout from '../layouts/PlatformLayout';
import ViewerLayout from '../layouts/ViewerLayout';
import HomePage from '../pages/HomePage';
import MyWorksPage from '../pages/MyWorksPage';
import FavoritesPage from '../pages/FavoritesPage';
import ComputePage from '../pages/ComputePage';
import UploadPage from '../pages/UploadPage';
import SceneViewerPage from '../pages/SceneViewerPage';
import SceneAuthoringPage from '../pages/SceneAuthoringPage';
import ShareRedirectPage from '../pages/ShareRedirectPage';
import LoginPage from '../pages/LoginPage';
import RegisterPage from '../pages/RegisterPage';
import NotFoundPage from '../pages/NotFoundPage';
import State403 from '../components/State403';
import HealthUI from '../pages/HealthUI';
import XRViewerPage from '../pages/XRViewerPage';
import XRTestPage from '../pages/XRTestPage';

/**
 * 应用路由（React Router v7 data router）。
 * 平台页面共用一个 PlatformLayout（固定 Sidebar + Topbar）；
 * /scene/:sceneId 使用无 Sidebar 的全屏 ViewerLayout；
 * /xr/* 使用独立 XR Runtime（WebGL + WebXR，非 iframe / postMessage）；
 * /s/:token 分享解析页面独立路由，不使用 PlatformLayout。
 */
export const appRouter = createBrowserRouter([
  {
    path: '/',
    element: <PlatformLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'works', element: <MyWorksPage /> },
      { path: 'favorites', element: <FavoritesPage /> },
      { path: 'compute', element: <ComputePage /> },
      { path: 'upload', element: <UploadPage /> },
      { path: 'health-ui', element: <HealthUI /> },
      { path: 'model/edit/:sceneId', element: <SceneAuthoringPage /> },
    ],
  },
  {
    path: '/scene/:sceneId',
    element: <ViewerLayout />,
    children: [{ index: true, element: <SceneViewerPage /> }],
  },
  { path: '/xr/test', element: <XRTestPage /> },
  { path: '/xr/:sceneId', element: <XRViewerPage /> },
  { path: '/s/:token', element: <ShareRedirectPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/403', element: <State403 /> },
  { path: '*', element: <NotFoundPage /> },
]);

export default appRouter;
