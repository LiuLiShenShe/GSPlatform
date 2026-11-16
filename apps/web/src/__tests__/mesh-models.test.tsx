import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import MeshModelsPage from '../pages/MeshModelsPage';
import * as api from '../services/meshModelsApi';

vi.mock('../services/meshModelsApi', () => ({ fetchMeshModels: vi.fn(), downloadMeshModel: vi.fn() }));
const model: api.MeshModel = { id: 'mesh-one', title: '植株 Mesh', sceneId: 'source', sceneSlug: 'plant', sceneTitle: '植株高斯',
  sourceVersionId: 'saved-v1', isCurrentSource: false, algorithm: '2dgs-tsdf', units: 'scene', vertices: 120, faces: 200,
  sizeBytes: 10240, sha256: 'a'.repeat(64), createdAt: '2026-11-16T00:00:00Z', downloadUrl: '/api/v1/mesh-models/mesh-one/file',
  previewUrl: '/meshes/mesh-one', jobId: 'job-one' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.fetchMeshModels).mockResolvedValue({ items: [model], total: 1, page: 1, pageSize: 24 }); vi.mocked(api.downloadMeshModel).mockResolvedValue(); });

it('shows immutable completed models with accurate units and source links', async () => {
  renderWithRouter(<MeshModelsPage />);
  await screen.findByText('植株 Mesh');
  expect(screen.getByText('未标定尺度')).toBeInTheDocument();
  expect(screen.getByText('历史版本')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看模型' })).toHaveAttribute('href', '/meshes/mesh-one');
  expect(screen.getByRole('link', { name: '来源高斯' })).toHaveAttribute('href', '/model/edit/plant?workspace=mesh');
  fireEvent.click(screen.getByRole('button', { name: '下载 PLY' }));
  await waitFor(() => expect(api.downloadMeshModel).toHaveBeenCalledWith(model));
  fireEvent.change(screen.getByRole('textbox', { name: '搜索 Mesh 模型' }), { target: { value: '植株' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索 Mesh 模型' }), { key: 'Enter', code: 'Enter' });
  await waitFor(() => expect(api.fetchMeshModels).toHaveBeenLastCalledWith(expect.objectContaining({ q: '植株', page: 1 }), expect.any(AbortSignal)));
});

it('provides a working path to source works when no mesh has finished', async () => {
  vi.mocked(api.fetchMeshModels).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 24 });
  renderWithRouter(<MeshModelsPage />);
  expect(await screen.findByRole('link', { name: '前往我的作品' })).toHaveAttribute('href', '/works');
});
