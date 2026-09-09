import { createBrowserRouter } from 'react-router-dom';
import PlatformLayout from '../layouts/PlatformLayout';
import ViewerLayout from '../layouts/ViewerLayout';
import HomePage from '../pages/HomePage';
import MyWorksPage from '../pages/MyWorksPage';
import ComputePage from '../pages/ComputePage';
import UploadPage from '../pages/UploadPage';
import SceneViewerPage from '../pages/SceneViewerPage';
import NotFoundPage from '../pages/NotFoundPage';
import State403 from '../components/State403';
import HealthUI from '../pages/HealthUI';

/**
 * 应用路由（React Router v7 data router）。
 * 平台页面共用一个 PlatformLayout（固定 Sidebar + Topbar）；
 * /scene/:sceneId 使用无 Sidebar 的全屏 ViewerLayout。
 */
export const appRouter = createBrowserRouter([
  {
    path: '/',
    element: <PlatformLayout />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'works', element: <MyWorksPage /> },
      { path: 'compute', element: <ComputePage /> },
      { path: 'upload', element: <UploadPage /> },
      { path: 'health-ui', element: <HealthUI /> },
    ],
  },
  {
    path: '/scene/:sceneId',
    element: <ViewerLayout />,
    children: [{ index: true, element: <SceneViewerPage /> }],
  },
  { path: '/403', element: <State403 /> },
  { path: '*', element: <NotFoundPage /> },
]);

export default appRouter;