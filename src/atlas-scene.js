import { CityScene3D as CanvasScene } from './scene3d.js';
import { GRID_W, GRID_H, CELL_COUNT } from './engine.js';
import { byId } from './materials.js';
import { selectMetric, colorAt, SCENARIOS } from './atlas-data.js';

export class CityScene3D extends CanvasScene {
  constructor(canvas,options) {
    super(canvas,options);
    this.selected=217;this.atmosphere='day';this.flat=false;this.auto=false;this.disposed=false;
    this.selection=()=>selectMetric({city:this.city,history:this.history,state:this.getState(),metricName:this.metricSelect.value,scenario:this.scenarioSelect.value,sceneIndex:this.sceneSelect.value});
    this.load3D();
  }
  metricValues(){const d=selectMetric({city:this.city,history:this.history,state:this.getState(),metricName:this.metricSelect.value,scenario:this.scenarioSelect.value,sceneIndex:this.sceneSelect.value});return {...d,metric:{...d.metric,key:d.metric.key||this.metricSelect.value,palette:'thermal'}};}
  describe(index){const state=this.getState(),types=this.scenarioSelect.value==='optimized'?state.optimizedTypes:this.scenarioSelect.value==='material'?state.materialTypes:this.city.types;const {metric,values}=this.metricValues();return `셀 ${index+1} · ${SCENARIOS[this.scenarioSelect.value]} · ${byId(types[index]).name} · 집계 건물 높이 ${this.city.heights[index].toFixed(0)}m · ${metric.label} ${values[index].toFixed(1)}${metric.unit}`;}
  async load3D(){
    try {
      const [T,{OrbitControls}]=await Promise.all([import('./vendor/three.module.min.js'),import('./vendor/OrbitControls.js')]);
      if(this.disposed)return;
      this.T=T;const canvas=document.createElement('canvas');canvas.id='city-webgl';canvas.tabIndex=0;canvas.setAttribute('aria-label','구월동 3D 분석 격자. 드래그 회전, 두 손가락 확대 및 이동. 셀 클릭으로 상세 확인. 화살표로 셀 선택, + − 확대.');
      this.renderer=new T.WebGLRenderer({canvas,antialias:true,alpha:false});this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));this.renderer.setClearColor('#172329');
      this.world=new T.Scene();this.world.fog=new T.Fog('#172329',70,150);
      this.camera=new T.OrthographicCamera(-24,24,19,-19,.1,250);this.camera.position.set(27,30,38);
      this.orbit=new OrbitControls(this.camera,canvas);this.orbit.target.set(0,0,0);this.orbit.enableDamping=true;this.orbit.dampingFactor=.075;this.orbit.minZoom=.55;this.orbit.maxZoom=4;this.orbit.maxPolarAngle=Math.PI/2.08;this.orbit.autoRotateSpeed=.5;
      this.light=new T.DirectionalLight('#fff0d5',2.5);this.light.position.set(-20,35,15);this.world.add(this.light);this.ambient=new T.HemisphereLight('#e8f6ff','#455360',2.1);this.world.add(this.ambient);
      this.mapGroup=new T.Group();this.world.add(this.mapGroup);
      const box=new T.BoxGeometry(1,1,1),groundMat=new T.MeshStandardMaterial({color:'#bac6c1',roughness:1});
      this.ground=new T.InstancedMesh(box,new T.MeshBasicMaterial({transparent:true,opacity:.78,depthWrite:false}),CELL_COUNT);this.mapGroup.add(this.ground);this.ground.renderOrder=2;
      this.buildings=new T.InstancedMesh(box,groundMat,CELL_COUNT);this.mapGroup.add(this.buildings);
      this.roofs=new T.InstancedMesh(box,new T.MeshBasicMaterial(),CELL_COUNT);this.mapGroup.add(this.roofs);
      this.grid=new T.GridHelper(28,28,'#51646b','#31434b');this.grid.position.y=-.18;this.world.add(this.grid);
      const plinth=new T.Mesh(new T.BoxGeometry(24.15,.38,28),new T.MeshStandardMaterial({color:'#31444b',roughness:1}));plinth.position.y=-.35;this.mapGroup.add(plinth);
      this.baseMap=new T.Mesh(new T.PlaneGeometry(24,27.83),new T.MeshBasicMaterial({color:'#596b71'}));this.baseMap.rotation.x=-Math.PI/2;this.baseMap.position.y=-.14;this.mapGroup.add(this.baseMap);
      new T.TextureLoader().load(new URL('../data/guwol-osm-basemap.webp',import.meta.url).href,texture=>{if(this.disposed){texture.dispose();return}texture.colorSpace=T.SRGBColorSpace;this.baseMap.material.map=texture;this.baseMap.material.color.set('#a4b6ba');this.baseMap.material.needsUpdate=true;this.draw();},undefined,()=>{});
      this.hubs=new T.Group();this.mapGroup.add(this.hubs);
      this.selectionBox=new T.Mesh(new T.BoxGeometry(1.015,.06,1.56),new T.MeshBasicMaterial({color:'#fff4cc',wireframe:true}));this.world.add(this.selectionBox);
      this.dummy=new T.Object3D();this.color=new T.Color();this.ray=new T.Raycaster();this.pointer=new T.Vector2();
      this.canvas.parentElement.append(canvas);this.canvas.hidden=true;this.webglCanvas=canvas;
      let down=null;
      canvas.addEventListener('pointerdown',event=>{down=[event.clientX,event.clientY];this.setAuto(false);});
      canvas.addEventListener('pointerup',event=>{if(!down||Math.hypot(event.clientX-down[0],event.clientY-down[1])>5)return;const rect=canvas.getBoundingClientRect();this.pointer.set((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1);this.ray.setFromCamera(this.pointer,this.camera);const hits=this.ray.intersectObjects([this.roofs,this.buildings,this.ground]);if(hits[0]?.instanceId!=null)this.select(hits[0].instanceId);});
      canvas.addEventListener('keydown',event=>{const step={ArrowLeft:-1,ArrowRight:1,ArrowUp:-GRID_W,ArrowDown:GRID_W}[event.key];if(step){event.preventDefault();this.select(Math.max(0,Math.min(CELL_COUNT-1,this.selected+step)));}if(['+','=','-'].includes(event.key)){event.preventDefault();this.zoomBy(event.key==='-'?.85:1.15);}});
      this.orbit.addEventListener('change',()=>this.draw());
      this.observer=new ResizeObserver(()=>this.resize());this.observer.observe(canvas.parentElement);
      this.render();this.resize();
      const tick=()=>{if(this.disposed)return;if(!document.hidden){this.orbit.autoRotate=this.auto&&!matchMedia('(prefers-reduced-motion: reduce)').matches;this.orbit.update();}this.frame=requestAnimationFrame(tick);};tick();
      const modeBadge=document.getElementById('render-mode');if(modeBadge)modeBadge.textContent='3D · WebGL';
      document.dispatchEvent(new Event('atlas-renderer-ready'));
    }catch(error){
      this.renderer?.dispose();this.webglCanvas?.remove();this.webglCanvas=null;this.canvas.hidden=false;
      const badge=document.getElementById('render-mode');if(badge)badge.textContent='경량 3D · 호환 모드';
      this.render();
    }
  }
  render(){
    if(!this.webglCanvas){super.render();this.updateLegend();return;}
    const T=this.T,state=this.getState(),d=this.selection(),types=this.scenarioSelect.value==='optimized'?state.optimizedTypes:this.scenarioSelect.value==='material'?state.materialTypes:this.city.types;
    const exag=+this.exaggerationInput.value;
    for(let i=0;i<CELL_COUNT;i++){
      const x=i%GRID_W-GRID_W/2+.5,z=(Math.floor(i/GRID_W)-GRID_H/2+.5)*1.546,h=this.city.heights[i]/108*exag;
      const tint=colorAt(d.values[i],d.min,d.max,d.palette);
      this.dummy.position.set(x,-.08,z);this.dummy.scale.set(.985,.04,1.52);this.dummy.updateMatrix();this.ground.setMatrixAt(i,this.dummy.matrix);this.ground.setColorAt(i,this.color.set(tint));
      const building=this.city.buildings[i],sz=building?.76:.001,sy=building?Math.max(.08,h):.001;
      this.dummy.position.set(x,sy/2,z);this.dummy.scale.set(sz,sy,sz*1.546);this.dummy.updateMatrix();this.buildings.setMatrixAt(i,this.dummy.matrix);
      const base=byId(types[i]);this.buildings.setColorAt(i,this.color.set(base.green?'#85c7a2':this.atmosphere==='night'?'#87979f':'#b2bfc0').lerp(new T.Color(tint),.25));
      this.dummy.position.y=sy+.012;this.dummy.scale.y=.022;this.dummy.updateMatrix();this.roofs.setMatrixAt(i,this.dummy.matrix);this.roofs.setColorAt(i,this.color.set(tint));
    }
    for(const mesh of [this.ground,this.buildings,this.roofs]){mesh.instanceMatrix.needsUpdate=true;mesh.instanceColor.needsUpdate=true;mesh.computeBoundingSphere();}
    while(this.hubs.children.length){const child=this.hubs.children[0];child.geometry.dispose();child.material.dispose();this.hubs.remove(child);}
    if(state.plan&&this.scenarioSelect.value==='optimized')for(const i of state.plan.hubs){const ring=new T.Mesh(new T.TorusGeometry(.42,.04,6,36),new T.MeshBasicMaterial({color:'#d2ffd9'}));ring.rotation.x=Math.PI/2;ring.position.set(i%GRID_W-GRID_W/2+.5,.12,(Math.floor(i/GRID_W)-GRID_H/2+.5)*1.546);this.hubs.add(ring);}
    this.updateLegend();this.select(this.selected);this.draw();
  }
  updateLegend(){const d=this.metricValues(),el=document.getElementById('atlas-legend');if(el)el.innerHTML=`<div><strong>${d.metric.label}</strong><span>${d.metric.kind==='simulation'?'모의 결과':'위성 관측'}</span></div><div class="thermal-ramp" style="background:linear-gradient(90deg,${d.palette.join(',')})"></div><div><span>${d.min.toFixed(1)} ${d.metric.unit}</span><span>${d.max.toFixed(1)} ${d.metric.unit}</span></div>`;const description=document.getElementById('metric-description');if(description)description.textContent=d.metric.description;this.sceneSelect.disabled=this.metricSelect.value!=='scene';this.sceneSelect.closest('.explorer')?.classList.toggle('observation-layer',d.metric.kind!=='simulation');}
  select(index){this.selected=index;const state=this.getState(),i=index;this.detailElement.textContent=this.describe(i);if(this.selectionBox){this.selectionBox.position.set(i%GRID_W-GRID_W/2+.5,(this.buildings.visible&&this.city.buildings[i]?Math.max(.08,this.city.heights[i]/108*+this.exaggerationInput.value):0)+.06,(Math.floor(i/GRID_W)-GRID_H/2+.5)*1.546);}
    const detail=document.getElementById('cell-inspector');if(detail&&state.latest){const h=state.hour,b=state.latest.base.hourly[h][i],m=state.latest.material.hourly[h][i],o=state.latest.opt.hourly[h][i];detail.innerHTML=`<div class="inspector-top">선택 셀 <strong>${String(i+1).padStart(3,'0')}</strong></div><div class="inspector-value">${o.toFixed(1)}<span>°C</span></div><span class="inspector-label">AI 설계 · ${h}시 모의 지표면온도</span><dl><div><dt>현재 도시</dt><dd>${b.toFixed(1)}°C</dd></div><div><dt>재료 변경</dt><dd>${m.toFixed(1)}°C</dd></div><div><dt>AI − 현재</dt><dd class="${o<=b?'cool-text':'warm-text'}">${o-b>0?'+':''}${(o-b).toFixed(1)}°C</dd></div><div><dt>집계 건물 높이</dt><dd>${this.city.heights[i].toFixed(0)} m</dd></div></dl><span class="inspector-label">셀을 클릭하면 비교값이 바뀝니다</span>`;}
    this.draw();}
  resize(){if(!this.webglCanvas)return;const {width,height}=this.webglCanvas.parentElement.getBoundingClientRect();if(!width||!height)return;this.renderer.setSize(width,height,false);const half=19;this.camera.left=-half*width/height;this.camera.right=half*width/height;this.camera.top=half;this.camera.bottom=-half;this.camera.updateProjectionMatrix();this.draw();}
  draw(){if(this.webglCanvas&&!document.hidden)this.renderer.render(this.world,this.camera);}
  rotate(delta){if(!this.webglCanvas)return super.rotate(delta);this.setAuto(false);const offset=this.camera.position.clone().sub(this.orbit.target);offset.applyAxisAngle(new this.T.Vector3(0,1,0),delta);this.camera.position.copy(this.orbit.target).add(offset);this.orbit.update();this.draw();}
  reset(){if(!this.webglCanvas)return super.reset();this.setAuto(false);this.flat=false;this.orbit.target.set(0,0,0);this.camera.position.set(27,30,38);this.camera.zoom=1;this.camera.updateProjectionMatrix();this.orbit.update();this.draw();document.getElementById('view-flat')?.setAttribute('aria-pressed','false');}
  zoomBy(factor){if(!this.webglCanvas){this.zoom=Math.max(.62,Math.min(1.75,this.zoom*factor));this.render();return;}this.camera.zoom=Math.max(.55,Math.min(4,this.camera.zoom*factor));this.camera.updateProjectionMatrix();this.draw();}
  setAuto(on){this.auto=on;document.getElementById('auto-tour')?.setAttribute('aria-pressed',String(on));if(this.orbit)this.orbit.autoRotate=on;}
  setFlat(){if(!this.webglCanvas)return;this.flat=!this.flat;this.setAuto(false);const t=this.orbit.target;this.camera.position.set(t.x+(this.flat?0:27),this.flat?55:30,t.z+(this.flat?.001:38));this.orbit.update();this.draw();document.getElementById('view-flat')?.setAttribute('aria-pressed',String(this.flat));}
  setAtmosphere(mode){this.atmosphere=mode;if(!this.webglCanvas)return;const styles={day:['#172329','#fff0d5',2.5,2.1],sunset:['#302831','#ffb481',2.4,1.2],night:['#0b1624','#83aaff',1.2,.65]},[bg,light,power,ambient]=styles[mode];this.renderer.setClearColor(bg);this.world.fog.color.set(bg);this.light.color.set(light);this.light.intensity=power;this.ambient.intensity=ambient;this.render();}
  focusHotspot(){const d=this.metricValues();let index=0;for(let i=1;i<d.values.length;i++)if(d.values[i]>d.values[index])index=i;this.select(index);if(this.orbit){this.orbit.target.set(index%GRID_W-GRID_W/2+.5,0,(Math.floor(index/GRID_W)-GRID_H/2+.5)*1.546);this.camera.position.copy(this.orbit.target).add(new this.T.Vector3(15,21,23));this.camera.zoom=1.3;this.camera.updateProjectionMatrix();this.orbit.update();this.draw();}}
  dispose(){this.disposed=true;cancelAnimationFrame(this.frame);this.observer?.disconnect();this.orbit?.dispose();this.world?.traverse(o=>{o.geometry?.dispose();if(o.material){o.material.map?.dispose();o.material.dispose();}});this.renderer?.dispose();}
}
