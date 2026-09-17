import { useEffect } from 'react';
import { RouterProvider } from 'react-router-dom';
import appRouter from './router';
import { useAuthStore } from '../stores/authStore';

export function App() {
  // 在应用挂载时恢复会话（HttpOnly cookie 已由浏览器自动携带）。
  useEffect(() => {
    void useAuthStore.getState().fetchMe();
  }, []);

  return <RouterProvider router={appRouter} />;
}

export default App;
