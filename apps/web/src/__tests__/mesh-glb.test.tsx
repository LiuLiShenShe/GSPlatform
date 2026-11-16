import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithRouter } from '../test/utils';
import { MeshGlbPanel } from '../components/MeshGlbPanel';
import * as api from '../services/meshModelsApi';
vi.mock('../services/meshModelsApi',()=>({fetchGlbState:vi.fn(),generateGlb:vi.fn(),downloadGlb:vi.fn()}));
vi.mock('../components/MeshPreview',()=>({MeshPreview:({format,orientation}:{format:string;orientation?:number[][]})=><div data-testid="mesh-display">{format}{orientation?' orientation':''}</div>}));
const model={id:'metric',sha256:'a'.repeat(64)} as api.MeshModel;
const pending={id:'variant',status:'QUEUED',orientationEvidence:{upAxis:'-Y'}} as api.GlbVariant;
const state:api.GlbState={eligible:true,reason:null,orientations:[{upAxis:'-Y',rotation:[[-1,0,0],[0,-1,0],[0,0,1]]}],variants:[]};
beforeEach(()=>{vi.clearAllMocks();vi.mocked(api.fetchGlbState).mockResolvedValue(state);vi.mocked(api.generateGlb).mockResolvedValue(pending);});
it('requires orientation confirmation and submits source checksum with no scale',async()=>{
 renderWithRouter(<MeshGlbPanel model={model}/>);
 await screen.findByText('确认朝向和底部位置');
 expect(screen.getByRole('button',{name:'生成标准 GLB'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'预览方向与底部'}));
 expect(screen.getByTestId('mesh-display')).toHaveTextContent('ply orientation');
 fireEvent.click(screen.getByRole('checkbox',{name:'确认朝向和底部位置'}));
 fireEvent.click(screen.getByRole('button',{name:'生成标准 GLB'}));
 await waitFor(()=>expect(api.generateGlb).toHaveBeenCalledWith(model,'-Y'));
 await screen.findByText(/等待 CPU 队列/);
});
it('keeps unknown metric units untouched and provides original preview',async()=>{
 vi.mocked(api.fetchGlbState).mockResolvedValue({...state,eligible:false,reason:'没有米制证据'});
 renderWithRouter(<MeshGlbPanel model={model}/>);
 await screen.findByText('没有米制证据');
 expect(screen.queryByRole('button',{name:'生成标准 GLB'})).not.toBeInTheDocument();
 expect(screen.getByTestId('mesh-display')).toHaveTextContent('ply');
});
it('loads standard GLB directly and retains PLY comparison',async()=>{
 vi.mocked(api.fetchGlbState).mockResolvedValue({...state,variants:[{...pending,status:'READY',metadata:{dimensionsMeters:[.5,1,.2],vertices:42,faces:80,validator:{issues:{numErrors:0}}}} as api.GlbVariant]});
 renderWithRouter(<MeshGlbPanel model={model}/>);
 const button=await screen.findByRole('button',{name:'标准 GLB 预览'});
 await waitFor(()=>expect(button).toBeEnabled());fireEvent.click(button);
 expect(screen.getByTestId('mesh-display')).toHaveTextContent(/^glb$/);
 expect(screen.getByText(/0.5000000 × 1.000000 × 0.2000000/)).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'原始 PLY 预览'}));
 expect(screen.getByTestId('mesh-display')).toHaveTextContent(/^ply$/);
});

it('explains the cm to m conversion without applying a preview model transform',async()=>{
 vi.mocked(api.fetchGlbState).mockResolvedValue({...state,variants:[{...pending,status:'READY',metadata:{dimensionsMeters:[.2,.3,.1],sourceUnits:'cm',unitConversionScale:.01,vertices:42,faces:80,validator:{issues:{numErrors:0}}}} as api.GlbVariant]});
 renderWithRouter(<MeshGlbPanel model={{...model,units:'cm'}}/>);
 await screen.findByText(/源 PLY 为厘米，GLB 自动按 0.01 换算为米/);
 expect(screen.getByText('厘米 → 米 × 0.01；不重新标定')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'标准 GLB 预览'}));
 expect(screen.getByTestId('mesh-display')).toHaveTextContent(/^glb$/);
});
