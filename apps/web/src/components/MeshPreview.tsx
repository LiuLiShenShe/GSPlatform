import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Progress, Space, Switch } from 'antd';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { fetchMeshFile } from '../services/meshModelsApi';
import { toApiError } from '../services/http';

export function MeshPreview({ modelId }: { modelId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const actions = useRef<{ fit: () => void; wire: (v: boolean) => void } | null>(null);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wire, setWire] = useState(false);
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const abort = new AbortController();
    let renderer: THREE.WebGLRenderer | undefined, controls: OrbitControls | undefined;
    let geometry: THREE.BufferGeometry | undefined, material: THREE.MeshStandardMaterial | undefined;
    let observer: ResizeObserver | undefined;
    setReady(false); setProgress(0); setError(null); setWire(false);
    const start = async () => {
      const buffer = await fetchMeshFile(modelId, abort.signal, n => { if (!abort.signal.aborted) setProgress(n); });
      if (abort.signal.aborted) return;
      geometry = new PLYLoader().parse(buffer);
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        if (attribute.array instanceof Float64Array) geometry.setAttribute(name,
          new THREE.Float32BufferAttribute(new Float32Array(attribute.array), attribute.itemSize, attribute.normalized));
      }
      geometry.computeVertexNormals(); geometry.computeBoundingBox();
      if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) throw new Error('网格为空');
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#202630');
      const camera = new THREE.PerspectiveCamera(45, 1, 0.0001, 10000); camera.up.set(0, -1, 0);
      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); container.appendChild(renderer.domElement);
      controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
      material = new THREE.MeshStandardMaterial({ vertexColors: geometry.hasAttribute('color'), color: geometry.hasAttribute('color') ? '#ffffff' : '#b6c8e0', side: THREE.DoubleSide, roughness: 1 });
      scene.add(new THREE.Mesh(geometry, material));
      scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7280, 2.3));
      const light = new THREE.DirectionalLight(0xffffff, 2.2); light.position.set(-2, -3, 4); scene.add(light);
      const center = geometry.boundingBox.getCenter(new THREE.Vector3());
      const radius = Math.max(geometry.boundingBox.getSize(new THREE.Vector3()).length() / 2, 0.0001);
      const fit = () => {
        camera.position.copy(center).add(new THREE.Vector3(0, 0, -radius / Math.sin(THREE.MathUtils.degToRad(22.5)) * 1.1));
        camera.near = radius / 10000; camera.far = radius * 100; camera.updateProjectionMatrix();
        controls!.target.copy(center); controls!.update();
      };
      fit(); actions.current = { fit, wire: value => { material!.wireframe = value; } };
      const resize = () => { const width = container.clientWidth, height = container.clientHeight;
        renderer!.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); };
      observer = new ResizeObserver(resize); observer.observe(container); resize();
      renderer.setAnimationLoop(() => { controls!.update(); renderer!.render(scene, camera); });
      container.dataset.vertices = String(geometry.attributes.position.count);
      container.dataset.faces = String(geometry.index ? geometry.index.count / 3 : geometry.attributes.position.count / 3);
      setReady(true);
    };
    void start().catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error && !('isAxiosError' in reason) ? reason.message : toApiError(reason).message); });
    return () => {
      abort.abort(); actions.current = null; observer?.disconnect(); controls?.dispose();
      renderer?.setAnimationLoop(null); geometry?.dispose(); material?.dispose(); renderer?.dispose(); renderer?.forceContextLoss();
      container.replaceChildren(); delete container.dataset.vertices; delete container.dataset.faces;
    };
  }, [modelId]);
  return <>
    <Space style={{ marginBottom: 12 }}><Button disabled={!ready} onClick={() => actions.current?.fit()}>完整模型取景</Button>
      <Switch checked={wire} disabled={!ready} checkedChildren="线框" unCheckedChildren="表面" onChange={v => { setWire(v); actions.current?.wire(v); }} />
      <span>左键旋转 · 滚轮缩放 · 右键平移</span></Space>
    {!ready && !error && <Progress percent={progress} format={n => n === 100 ? '准备显示…' : `加载 ${n}%`} />}
    {error && <Alert type="error" title={`网格预览失败：${error}`} />}
    <div ref={host} className="gs-mesh-preview" data-testid="mesh-preview" aria-label="Mesh 三维预览" />
  </>;
}
