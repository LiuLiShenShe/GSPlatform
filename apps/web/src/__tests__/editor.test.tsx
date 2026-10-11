import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import { GaussianEditorPanel } from '../features/authoring/GaussianEditorPanel';
import * as api from '../services/editorApi';
import { httpClient } from '../services/http';
import { ResumableUploader } from '../features/upload/ResumableUploader';

vi.mock('../services/editorApi', async original => {
  const actual = await original<typeof api>();
  return { ...actual, fetchEditSource: vi.fn(), fetchEditSession: vi.fn(),
    createEditSession: vi.fn(), cancelEditSession: vi.fn() };
});

const source: api.EditSource = { sceneId: 'scene-1', sceneTitle: 'Private guitar',
  currentVersionId: 'version-1', assetVersion: 'asset-1', format: 'ply', counts: [90854],
  editorEnabled: true, maxGaussians: 5000000, spatialState: null };
const session: api.EditSession = { id: 'edit-1', sceneSlug: 'scene-1', sceneTitle: 'Private guitar',
  sourceVersionId: 'version-1', sourceAssetVersion: 'asset-1', sourceKind: 'FULL_RESOLUTION_SOURCE',
  sourceCounts: [90854], selectedLod: null, editorUpstreamCommit: 'f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b',
  editorBuildIdentity: 'a'.repeat(64), status: 'CREATED', expiresAt: '2026-10-12T10:00:00Z',
  editorUrl: '/gaussian-editor/?load=%2Fapi%2Fv1%2Fprivate', uploadId: null,
  resultVersionId: null, errorCode: null, stage: null, progress: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.fetchEditSource).mockResolvedValue(source);
  vi.mocked(api.createEditSession).mockResolvedValue(session);
  vi.mocked(api.fetchEditSession).mockResolvedValue(session);
  vi.spyOn(window, 'open').mockReturnValue(null);
});

describe('Official editor orchestration, not Gaussian algorithms', () => {
  it('authorizes before opening and discloses popup fallback and manual export', async () => {
    renderWithRouter(<GaussianEditorPanel sceneId="scene-1" />);
    expect(await screen.findByText(/Private guitar/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开 SuperSplat Editor' }));
    await waitFor(() => expect(window.open).toHaveBeenCalled());
    expect(api.createEditSession).toHaveBeenCalledWith('scene-1', source, 0, false);
    expect(localStorage.getItem('gs-editor-session:scene-1')).toBe('edit-1');
    expect(screen.getByText(/浏览器拦截了新窗口/)).toBeInTheDocument();
    expect(screen.getByText(/仅编辑不会修改原场景/)).toBeInTheDocument();
    expect(vi.mocked(api.createEditSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(window.open).mock.invocationCallOrder[0]);
  });

  it('rejects untrusted editor origin and path', () => {
    expect(() => api.officialEditorUrl({ ...session, editorUrl: 'https://evil.example/' })).toThrow();
    expect(() => api.officialEditorUrl({ ...session, editorUrl: '/wrong-editor/' })).toThrow();
  });

  it('requires explicit Streamed LOD acknowledgement and count disclosure', async () => {
    vi.mocked(api.fetchEditSource).mockResolvedValue({ ...source, format: 'streamed-sog',
      counts: [90854, 27256, 9085] });
    renderWithRouter(<GaussianEditorPanel sceneId="scene-1" />);
    expect(await screen.findByText(/降采样导出冒充原始全精度/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: '打开 SuperSplat Editor' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /确认所选 LOD/ }));
    expect(button).not.toBeDisabled();
  });

  it('restores an expired session without enabling submit after refresh', async () => {
    localStorage.setItem('gs-editor-session:scene-1', 'edit-1');
    vi.mocked(api.fetchEditSession).mockResolvedValue({ ...session, status: 'EXPIRED' });
    renderWithRouter(<GaussianEditorPanel sceneId="scene-1" />);
    expect(await screen.findByText(/授权状态：EXPIRED/)).toBeInTheDocument();
    expect(screen.queryByLabelText('官方编辑导出文件')).not.toBeInTheDocument();
  });

  it('only published completion exposes Viewer link and stale bindings notice', async () => {
    localStorage.setItem('gs-editor-session:scene-1', 'edit-1');
    vi.mocked(api.fetchEditSource).mockResolvedValue({ ...source, spatialState: 'STALE' });
    vi.mocked(api.fetchEditSession).mockResolvedValue({ ...session, status: 'COMPLETED',
      resultVersionId: 'new-version' });
    renderWithRouter(<GaussianEditorPanel sceneId="scene-1" />);
    expect(await screen.findByText(/新 SceneVersion 已发布：new-version/)).toBeInTheDocument();
    expect(screen.getByText(/空间绑定已失效/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '在正式 Viewer 查看新版本' })).toHaveAttribute('href', '/scene/scene-1');
  });

  it('caps 409 resync retries when an edit expires during chunk transfer', async () => {
    const conflict = { response: { status: 409, data: { code: 'EDIT_SESSION_INVALID', message: 'Expired' } } };
    vi.spyOn(httpClient, 'patch').mockRejectedValue(conflict);
    vi.spyOn(httpClient, 'head').mockResolvedValue({ headers: { 'upload-offset': '0' } });
    const event = vi.fn();
    const uploader = new ResumableUploader(new File(['export'], 'edited.ply'), {
      uploadId: 'upload-1', status: 'UPLOADING', offset: 0, totalSize: 6, chunkMaxBytes: 6,
    }, event);
    await expect(uploader.run()).rejects.toBe(conflict);
    expect(httpClient.patch).toHaveBeenCalledTimes(3);
    expect(event).toHaveBeenLastCalledWith({ type: 'error', message: 'Expired', code: 'EDIT_SESSION_INVALID' });
  });
});
