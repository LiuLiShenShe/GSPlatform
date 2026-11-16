import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import { SurfaceMeshPanel } from '../features/authoring/SurfaceMeshPanel';
import * as api from '../services/meshApi';

vi.mock('../services/meshApi', () => ({ fetchMesh: vi.fn(), createMesh: vi.fn(), cancelMesh: vi.fn(), downloadMesh: vi.fn() }));
const ready: api.MeshState = { currentVersionId: 'metric-v1', available: true, algorithm: 'nksr', job: null };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(api.fetchMesh).mockResolvedValue(ready); });

it('queues the current geometry with the automatic 3DGS mesher', async () => {
  vi.mocked(api.createMesh).mockResolvedValue({ ...ready, job: { id: 'm1', status: 'QUEUED', stage: null, progress: 0 } });
  renderWithRouter(<SurfaceMeshPanel sceneId="plant" />);
  await screen.findByText('当前方法：3DGS → NKSR');
  expect(screen.getByRole('button', { name: '生成表面网格' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: '确认当前已保存的高斯版本可以生成 Mesh' }));
  fireEvent.click(screen.getByRole('button', { name: '生成表面网格' }));
  await screen.findByText('等待 GPU 队列');
  expect(api.createMesh).toHaveBeenCalledWith('plant', 'metric-v1');
  expect(screen.getByRole('button', { name: /生成表面网格/ })).toBeDisabled();
});

it('blocks meshing before calibration with the server reason', async () => {
  vi.mocked(api.fetchMesh).mockResolvedValue({ ...ready, available: false, reason: '请先完成尺度标定' });
  renderWithRouter(<SurfaceMeshPanel sceneId="plant" />);
  await screen.findByText('请先完成尺度标定');
  expect(screen.getByRole('button', { name: '生成表面网格' })).toBeDisabled();
});

it('recovers the running native 2DGS job from the server after a reload', async () => {
  const running: api.MeshState = { ...ready, algorithm: '2dgs-tsdf', job: { id: 'm2', status: 'RUNNING', stage: 'TSDF', progress: 60 } };
  vi.mocked(api.fetchMesh).mockResolvedValue(running);
  vi.mocked(api.cancelMesh).mockResolvedValue({ ...running, job: { ...running.job!, status: 'CANCEL_REQUESTED' } });
  renderWithRouter(<SurfaceMeshPanel sceneId="plant" />);
  await screen.findByText('当前方法：2DGS 原生 TSDF');
  expect(screen.getByText('融合 2DGS 深度并提取网格')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '取消网格生成' }));
  await waitFor(() => expect(api.cancelMesh).toHaveBeenCalledWith('plant', 'm2'));
  await screen.findByText('正在取消');
});

it('downloads the completed metric mesh through the authenticated API', async () => {
  vi.mocked(api.fetchMesh).mockResolvedValue({ ...ready, job: { id: 'm3', status: 'SUCCEEDED', stage: 'SUCCEEDED', progress: 100,
    result: { vertices: 123, faces: 456, units: 'm', downloadUrl: '/api/v1/scenes/plant/mesh/m3/download' } } });
  vi.mocked(api.downloadMesh).mockResolvedValue();
  renderWithRouter(<SurfaceMeshPanel sceneId="plant" />);
  fireEvent.click(await screen.findByRole('button', { name: '下载彩色 PLY 网格' }));
  await waitFor(() => expect(api.downloadMesh).toHaveBeenCalledWith('plant', 'm3'));
  expect(screen.getByText(/123 个顶点/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看 Mesh 模型' })).toHaveAttribute('href', '/meshes');
});
