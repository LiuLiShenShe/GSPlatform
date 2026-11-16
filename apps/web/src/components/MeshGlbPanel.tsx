import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Select, Space, Tag, Typography } from 'antd';
import { downloadGlb, fetchGlbState, generateGlb, type GlbState, type MeshModel } from '../services/meshModelsApi';
import { toApiError } from '../services/http';
import { MeshPreview } from './MeshPreview';

export function MeshGlbPanel({ model }: { model: MeshModel }) {
  const [state,setState]=useState<GlbState|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [axis,setAxis]=useState('-Y');
  const [confirmed,setConfirmed]=useState(false);
  const [preview,setPreview]=useState<'ply'|'orientation'|'glb'>('ply');
  const [selected,setSelected]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [download,setDownload]=useState(false);
  useEffect(()=>{
    const abort=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{try{const data=await fetchGlbState(model.id,abort.signal);if(!abort.signal.aborted){setState(data);setError(null);}}
      catch(reason){if(!abort.signal.aborted)setError(toApiError(reason).message);}
      finally{if(!abort.signal.aborted)timer=setTimeout(()=>{void poll();},2000);}};
    void poll();return()=>{abort.abort();clearTimeout(timer);};
  },[model.id]);
  const ready=state?.variants.filter(v=>v.status==='READY')??[];
  const chosen=ready.find(v=>v.id===selected)??ready[0];
  const rotation=state?.orientations.find(v=>v.upAxis===axis)?.rotation;
  const submit=async()=>{setBusy(true);setError(null);try{const v=await generateGlb(model,axis);setState(s=>s?{...s,variants:[v,...s.variants.filter(x=>x.id!==v.id)]}:s);}
    catch(reason){setError(toApiError(reason).message);}finally{setBusy(false);}};
  const metadata=chosen?.metadata;
  return <>
    <Space wrap style={{marginBottom:16}}>
      <Button type={preview==='ply'?'primary':'default'} onClick={()=>setPreview('ply')}>原始 PLY 预览</Button>
      <Button type={preview==='glb'?'primary':'default'} disabled={!chosen} onClick={()=>setPreview('glb')}>标准 GLB 预览</Button>
      <Button disabled={!chosen} loading={download} onClick={()=>{if(!chosen)return;setDownload(true);void downloadGlb(model.id,chosen.id).catch(e=>setError(toApiError(e).message)).finally(()=>setDownload(false));}}>下载 GLB</Button>
      {ready.length>1&&<Select aria-label="GLB 版本" value={chosen?.id} style={{width:220}} onChange={setSelected} options={ready.map(v=>({value:v.id,label:`${v.orientationEvidence.upAxis} 朝上 · ${v.id.slice(0,8)}`}))}/>}
    </Space>
    {error&&<Alert type="error" title={error}/>}
    {state&&!state.eligible&&<Alert type="info" title={state.reason}/>}
    {state?.eligible&&<Space orientation="vertical" style={{width:'100%',marginBottom:16}}>
      <Typography.Text>确认源模型哪个方向朝上。保留原 Mesh 的实际尺寸；{model.units === 'cm' ? '源 PLY 为厘米，GLB 自动按 0.01 换算为米；' : '源 PLY 已为米，GLB 不再换算；'}朝向预览以绿色地面表示 Y=0。</Typography.Text>
      <Space wrap><Select aria-label="源模型朝上轴" value={axis} style={{width:190}} onChange={v=>{setAxis(v);setConfirmed(false);setPreview('orientation');}}
        options={state.orientations.map(v=>({value:v.upAxis,label:`源 ${v.upAxis} → 资产 +Y`}))}/>
        <Button onClick={()=>setPreview('orientation')}>预览方向与底部</Button>
        <Checkbox checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}>确认朝向和底部位置</Checkbox>
        <Button loading={busy} disabled={!confirmed||state.variants.some(v=>['QUEUED','RUNNING'].includes(v.status)&&!v.retryable&&v.orientationEvidence.upAxis===axis)} onClick={()=>{void submit();}}>生成标准 GLB</Button>
      </Space>
      {state.variants.filter(v=>v.status!=='READY').map(v=><Typography.Text key={v.id} type={v.status==='FAILED'?'danger':'secondary'}>
        GLB · {v.orientationEvidence.upAxis} 朝上 · {v.status==='QUEUED'?'等待 CPU 队列':v.status==='RUNNING'?(v.retryable?'任务中断，可重新确认后重试':'转换并验证完整几何中'):`转换失败（${v.errorCode}），可重新确认后重试`}</Typography.Text>)}
    </Space>}
    {metadata&&<Descriptions size="small" column={{xs:1,sm:2,lg:3}} items={[
      {key:'dimensions',label:'标准尺寸 X/Y/Z（米）',children:metadata.dimensionsMeters.map(v=>v.toPrecision(7)).join(' × ')},
      {key:'axes',label:'坐标',children:'右手坐标 · Y-up · 米'},
      {key:'pivot',label:'Pivot',children:'包围盒底部中心（0,0,0）'},
      {key:'geometry',label:'完整几何',children:`${metadata.vertices.toLocaleString()} 顶点 / ${metadata.faces.toLocaleString()} 三角面`},
      {key:'validator',label:'glTF 2.0',children:<Tag color="success">Validator {metadata.validator.issues.numErrors} errors</Tag>},
      {key:'scale',label:'单位换算',children:model.units==='cm'?'厘米 → 米 × 0.01；不重新标定':'米 → 米 × 1；不重新标定'},
    ]}/>}
    {preview==='orientation'&&<Alert type="info" title="朝向确认预览：按所选轴旋转并移动到底部中心，尚未写入资产。" style={{marginBottom:12}}/>}
    <MeshPreview modelId={model.id} format={preview==='glb'?'glb':'ply'} variantId={chosen?.id}
      orientation={preview==='orientation'?rotation:undefined}/>
    {metadata&&<details><summary>标准坐标与转换溯源</summary><pre style={{overflowX:'auto'}}>{JSON.stringify({sourceToAssetMatrix:metadata.sourceToAssetMatrix,sourceBounds:metadata.sourceBounds,assetBounds:metadata.assetBounds,pivotPolicy:metadata.pivotPolicy,transformVersion:chosen?.transformVersion,converterVersion:chosen?.converterVersion,sourcePlySha256:chosen?.sourcePlySha256,glbSha256:chosen?.sha256},null,2)}</pre></details>}
  </>;
}
