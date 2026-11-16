import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Progress, Space, Switch } from 'antd';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fetchGlbFile, fetchMeshFile } from '../services/meshModelsApi';
import { toApiError } from '../services/http';

export function MeshPreview({ modelId, format='ply', variantId, orientation }: {
  modelId: string; format?: 'ply'|'glb'; variantId?: string; orientation?: number[][];
}) {
  const host=useRef<HTMLDivElement>(null);
  const actions=useRef<{fit:()=>void;wire:(v:boolean)=>void}|null>(null);
  const [progress,setProgress]=useState(0),[ready,setReady]=useState(false),[error,setError]=useState<string|null>(null),[wire,setWire]=useState(false);
  const rotationKey=orientation?JSON.stringify(orientation):'';
  useEffect(()=>{
    const container=host.current;if(!container)return;
    const abort=new AbortController();let renderer:THREE.WebGLRenderer|undefined,controls:OrbitControls|undefined,observer:ResizeObserver|undefined;
    const geometries:THREE.BufferGeometry[]=[],materials:THREE.Material[]=[];
    setReady(false);setProgress(0);setError(null);setWire(false);
    const start=async()=>{
      const onProgress=(n:number)=>{if(!abort.signal.aborted)setProgress(n);};
      const buffer=format==='glb'?await fetchGlbFile(modelId,variantId,abort.signal,onProgress):await fetchMeshFile(modelId,abort.signal,onProgress);
      if(abort.signal.aborted)return;
      let object:THREE.Object3D;
      if(format==='glb'){
        object=(await new GLTFLoader().parseAsync(buffer,'')).scene;
      }else{
        const geometry=new PLYLoader().parse(buffer);
        for(const [name,attribute] of Object.entries(geometry.attributes))if(attribute.array instanceof Float64Array)geometry.setAttribute(name,new THREE.Float32BufferAttribute(new Float32Array(attribute.array),attribute.itemSize,attribute.normalized));
        if(!geometry.hasAttribute('normal'))geometry.computeVertexNormals();
        // Explicit temporary direction preview only; exported GLB receives NO correction.
        if(rotationKey){const r=JSON.parse(rotationKey) as number[][];geometry.applyMatrix4(new THREE.Matrix4().set(r[0][0],r[0][1],r[0][2],0,r[1][0],r[1][1],r[1][2],0,r[2][0],r[2][1],r[2][2],0,0,0,0,1));geometry.computeBoundingBox();const b=geometry.boundingBox!;geometry.translate(-(b.min.x+b.max.x)/2,-b.min.y,-(b.min.z+b.max.z)/2);}
        object=new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({vertexColors:geometry.hasAttribute('color'),color:geometry.hasAttribute('color')?'#ffffff':'#b6c8e0',side:THREE.DoubleSide,roughness:1,metalness:0}));
      }
      let vertices=0,faces=0;const meshMaterials:THREE.Material[]=[];
      object.traverse(o=>{if(o instanceof THREE.Mesh){geometries.push(o.geometry);vertices+=o.geometry.attributes.position.count;faces+=o.geometry.index?o.geometry.index.count/3:o.geometry.attributes.position.count/3;const list=Array.isArray(o.material)?o.material:[o.material];materials.push(...list);meshMaterials.push(...list);}});
      if(abort.signal.aborted){geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());return;}
      const bounds=new THREE.Box3().setFromObject(object,true);if(bounds.isEmpty())throw new Error('网格为空');
      const canonical=format==='glb'||!!rotationKey;
      const scene=new THREE.Scene();scene.background=new THREE.Color('#202630');scene.add(object);
      const camera=new THREE.PerspectiveCamera(45,1,.0001,10000);camera.up.set(0,canonical?1:-1,0);
      renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));container.appendChild(renderer.domElement);
      controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
      scene.add(new THREE.HemisphereLight(0xffffff,0x6b7280,2.3));const light=new THREE.DirectionalLight(0xffffff,2.2);light.position.set(-2,canonical?3:-3,4);scene.add(light);
      const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3()),radius=Math.max(size.length()/2,.0001);
      if(canonical){const grid=new THREE.GridHelper(Math.max(size.x,size.z)*1.4,10,0x5ad2ac,0x42645a);geometries.push(grid.geometry);materials.push(...(Array.isArray(grid.material)?grid.material:[grid.material]));scene.add(grid);}
      const fit=()=>{camera.position.copy(center).add(new THREE.Vector3(0,0,-radius/Math.sin(THREE.MathUtils.degToRad(22.5))*1.1));camera.near=radius/10000;camera.far=radius*100;camera.updateProjectionMatrix();controls!.target.copy(center);controls!.update();};
      fit();actions.current={fit,wire:v=>meshMaterials.forEach(m=>{if('wireframe' in m)m.wireframe=v;})};
      const resize=()=>{const width=container.clientWidth,height=container.clientHeight;renderer!.setSize(width,height);camera.aspect=width/height;camera.updateProjectionMatrix();};observer=new ResizeObserver(resize);observer.observe(container);resize();
      renderer.setAnimationLoop(()=>{controls!.update();renderer!.render(scene,camera);});
      container.dataset.vertices=String(vertices);container.dataset.faces=String(faces);container.dataset.bounds=JSON.stringify([bounds.min.toArray(),bounds.max.toArray()]);container.dataset.dimensions=JSON.stringify(size.toArray());container.dataset.format=format;container.dataset.objectMatrix=JSON.stringify(object.matrix.toArray());setReady(true);
    };
    void start().catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error&&!('isAxiosError' in reason)?reason.message:toApiError(reason).message);});
    return()=>{abort.abort();actions.current=null;observer?.disconnect();controls?.dispose();renderer?.setAnimationLoop(null);geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());renderer?.dispose();renderer?.forceContextLoss();container.replaceChildren();for(const k of ['vertices','faces','bounds','dimensions','format','objectMatrix'])delete container.dataset[k];};
  },[modelId,format,variantId,rotationKey]);
  return <><Space style={{marginBottom:12}} wrap><Button disabled={!ready} onClick={()=>actions.current?.fit()}>完整模型取景</Button><Switch checked={wire} disabled={!ready} checkedChildren="线框" unCheckedChildren="表面" onChange={v=>{setWire(v);actions.current?.wire(v);}}/><span>左键旋转 · 滚轮缩放 · 右键平移</span></Space>
    {!ready&&!error&&<Progress percent={progress} format={n=>n===100?'准备显示…':`加载 ${n}%`}/>}{error&&<Alert type="error" title={`网格预览失败：${error}`}/>}
    <div ref={host} className="gs-mesh-preview" data-testid="mesh-preview" aria-label="Mesh 三维预览"/>
  </>;
}
