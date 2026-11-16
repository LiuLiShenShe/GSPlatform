import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import { AutomaticCalibrationPanel } from '../features/authoring/AutomaticCalibrationPanel';
import * as api from '../services/editorApi';

vi.mock('../services/editorApi', () => ({calibrateScene: vi.fn(), fetchEditSource: vi.fn(), fetchEditSession: vi.fn()}));
const source: api.EditSource = {sceneId:'s',sceneTitle:'Plant',currentVersionId:'v1',assetVersion:'asset1',
  format:'sog',counts:[43714],editorEnabled:true,maxGaussians:5000000,spatialState:null,calibrationAvailable:true};
const pending = {id:'e1',status:'QUEUED',progress:0,automaticCalibration:{scaleFactor:80,geometryUnits:'cm'}} as api.EditSession;
beforeEach(() => {vi.clearAllMocks();localStorage.clear();vi.mocked(api.fetchEditSource).mockResolvedValue(source);});

it('enables automatic submission from dimensions alone and refreshes after publication', async () => {
  const refresh = vi.fn();
  vi.mocked(api.calibrateScene).mockResolvedValue(pending);
  vi.mocked(api.fetchEditSession).mockResolvedValue({...pending,status:'COMPLETED',resultVersionId:'v2'});
  renderWithRouter(<AutomaticCalibrationPanel sceneId="s" onCompleted={refresh} />);
  const button = screen.getByRole('button',{name:'应用尺度标定并自动发布'});
  await screen.findByText(/Plant/);
  expect(button).toBeDisabled();
  fireEvent.change(screen.getByLabelText('原始测量距离'),{target:{value:'.25'}});
  fireEvent.change(screen.getByLabelText('标定物真实长度'),{target:{value:'20'}});
  expect(button).toBeEnabled();
  expect(screen.getByText(/缩放倍率：80.00000；标定后 PLY 和 Mesh 单位为厘米/)).toBeInTheDocument();
  expect(document.querySelector('input[type=file]')).toBeNull();
  fireEvent.click(button);
  await waitFor(()=>expect(api.calibrateScene).toHaveBeenCalledWith('s',{
    expectedCurrentVersion:'v1',referenceName:'标定方块',originalDistance:.25,realLength:20,unit:'cm'}));
  expect(button).toBeDisabled();
  await screen.findByText(/尺度标定已完成，新版本已发布/);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('shows the server lock reason and disables repeated calibration', async () => {
  vi.mocked(api.fetchEditSource).mockResolvedValue({...source,calibrationAvailable:false,calibrationBlockedReason:'已保存视角，尺度标定已锁定。'});
  renderWithRouter(<AutomaticCalibrationPanel sceneId="s" />);
  await screen.findByText('已保存视角，尺度标定已锁定。');
  expect(screen.getByLabelText('原始测量距离')).toBeDisabled();
  expect(screen.getByRole('button',{name:'应用尺度标定并自动发布'})).toBeDisabled();
});

it('resumes polling after a page refresh without submitting again', async () => {
  localStorage.setItem('gs-auto-calibration:s','e1');
  vi.mocked(api.fetchEditSession).mockResolvedValueOnce(pending).mockResolvedValue({...pending,status:'COMPLETED'});
  renderWithRouter(<AutomaticCalibrationPanel sceneId="s" />);
  await screen.findByText(/尺度标定已完成，新版本已发布/);
  expect(api.calibrateScene).not.toHaveBeenCalled();
});
