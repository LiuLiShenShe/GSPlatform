import { act, render } from '@testing-library/react';
import { type ReactNode } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Providers } from '../app/providers';
import appRouter from '../app/router';

/** 通过内存路由渲染整个应用（覆盖指定初始路由），便于路由级测试。 */
export function renderApp({ route = '/' }: { route?: string } = {}) {
  const router = createMemoryRouter(appRouter.routes, {
    initialEntries: [route],
  });
  const utils = render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...utils, router };
}

/** 在完整应用上下文（Providers + 内存路由）中渲染单个元素。 */
export function renderWithRouter(
  element: ReactNode,
  { route = '/' }: { route?: string } = {},
) {
  const router = createMemoryRouter([{ path: '*', element }], {
    initialEntries: [route],
  });
  return render(
    <Providers>
      <RouterProvider router={router} />
    </Providers>,
  );
}

/** 修改视口宽度并派发 resize，驱动 useViewportWidth 系列 Hook。 */
export function setViewportWidth(width: number): void {
  act(() => {
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: width,
    });
    window.dispatchEvent(new Event('resize'));
  });
}

export const sceneIdsInOrder = [
  'shanghai-lujiazui',
  'tokyo-tower-sunset',
  'paris-notre-dame',
  'modernist-villa',
  'studio-apartment',
  'kitchen-showroom',
  'yosemite-valley',
  'guilin-karst',
  'portrait-studio-01',
  'candid-street-02',
  'micro-scene-01',
  'thermal-artifact',
];
