import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { Providers } from '../app/providers';
import { SceneCard } from '../components/SceneCard';
import { sceneFixtures } from '../fixtures/scenes';
import { formatOriginalFormat, formatUploadTime } from '../utils/provenance';

const base = sceneFixtures[0];

describe('GS-UI-01 作品卡片真实上传元数据', () => {
  it('按 YYYY-MM-DD HH:mm 与原始扩展名大写展示', () => {
    const router = createMemoryRouter(
      [
        {
          path: '*',
          element: (
            <SceneCard scene={{ ...base, uploadedAt: '2026-03-04T05:06:00Z', originalFormat: 'ply' }} />
          ),
        },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    expect(screen.getByTestId(`scene-format-${base.id}`)).toHaveTextContent('PLY');
    const time = screen.getByTestId(`scene-upload-time-${base.id}`).textContent ?? '';
    expect(time).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('没有真实上传记录的旧作品不显示任何伪造值', () => {
    const router = createMemoryRouter(
      [{ path: '*', element: <SceneCard scene={{ ...base, uploadedAt: null, originalFormat: null }} /> }],
      { initialEntries: ['/'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    expect(screen.queryByTestId(`scene-upload-time-${base.id}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`scene-format-${base.id}`)).not.toBeInTheDocument();
  });

  it('格式化助手对空值/非法值返回 null（不猜测）', () => {
    expect(formatUploadTime(null)).toBeNull();
    expect(formatUploadTime('not-a-date')).toBeNull();
    expect(formatOriginalFormat('')).toBeNull();
    expect(formatOriginalFormat('.zip')).toBe('ZIP');
    expect(formatOriginalFormat('sog')).toBe('SOG');
  });
});

describe('GS-UI-01 后续：卡片「VR 版」入口', () => {
  function renderCard() {
    const router = createMemoryRouter(
      [
        { path: '/', element: <SceneCard scene={base} /> },
        { path: '/xr/:sceneId', element: <div data-testid="xr-route" /> },
        { path: '/scene/:sceneId', element: <div data-testid="scene-route" /> },
      ],
      { initialEntries: ['/'] },
    );
    render(
      <Providers>
        <RouterProvider router={router} />
      </Providers>,
    );
    return router;
  }

  it('点 VR版 → 路由到 /xr/:sceneId（VR 模式页），且不触发卡片主体跳转', () => {
    const router = renderCard();
    fireEvent.click(screen.getByTestId(`scene-vr-${base.id}`));
    expect(router.state.location.pathname).toBe(`/xr/${base.id}`);
    expect(screen.getByTestId('xr-route')).toBeInTheDocument();
  });

  it('点卡片主体仍进网页版 /scene/:id（原行为保留）', () => {
    const router = renderCard();
    fireEvent.click(screen.getByRole('link', { name: `打开场景 ${base.title}` }));
    expect(router.state.location.pathname).toBe(`/scene/${base.id}`);
  });
});
