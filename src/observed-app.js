import {observationAt,statistics,temperatureColor} from './observed-data.js';
import {footprintPoint} from './footprint.js';
import {frameFor,loadViewport,pixelLocation} from './viewport-data.js';
import {setupFullscreen} from './fullscreen.js';
import {emptyBuildings,buildingBounds,fetchBuildings} from './live-buildings.js';
const $=id=>document.getElementById(id),dialog=$('sources');
$('sources-open').onclick=()=>dialog.showModal();$('sources-close').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
const celsius=v=>Number.isFinite(v)?`${v.toFixed(1)}°C`:'자료 없음';
const camera={center:[126.7065,37.4479],zoom:15.35,pitch:55,bearing:-24};
const readJSON=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(`${url}: ${r.status}`);return r.json();};
let map,data=null,selected,marker,ready=false,controller,timer,revision=0;
function setPanel(open){
  document.body.classList.toggle('panel-collapsed',!open);
  $('panel-toggle').setAttribute('aria-expanded',String(open));
  $('rail-observe').classList.toggle('active',open);
}
$('panel-toggle').onclick=()=>setPanel(document.body.classList.contains('panel-collapsed'));
$('panel-close').onclick=()=>setPanel(false);
$('compact-open').onclick=()=>setPanel(true);
$('rail-observe').onclick=()=>setPanel(document.body.classList.contains('panel-collapsed'));
$('rail-sources').onclick=()=>$('sources-open').click();
$('rail-view').onclick=()=>$(map?.getPitch()>5?'view2d':'view3d').click();
const cache=new Map();
let buildings=emptyBuildings(),buildingController,buildingTimer,buildingRevision=0,lastBuildingRequest=0;
const buildingCache=new Map();
function buildingStatus(text,retry=false){
  $('building-status').textContent=text;
  if(retry){const button=document.createElement('button');button.textContent='재시도';button.onclick=scheduleBuildings;$('building-status').append(button);}
}
function cancelBuildings(){buildingRevision++;buildingController?.abort();clearTimeout(buildingTimer);}
function scheduleBuildings(){
  cancelBuildings();
  buildingTimer=setTimeout(refreshBuildings,Math.max(900,4500-(Date.now()-lastBuildingRequest)));
}
async function refreshBuildings(){
  if(!ready||map.isMoving())return;
  const current=buildingRevision,b=map.getBounds(),bounds=buildingBounds([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]);
  if(map.getZoom()<13||!bounds){buildingStatus('3D 건물을 보려면 지도를 확대하세요');return;}
  buildingController=new AbortController();const signal=buildingController.signal;
  const key=bounds.map(x=>x.toFixed(6)).join(',');
  buildingStatus('등록된 건물 높이 불러오는 중…');
  try{
    let result=buildingCache.get(key);
    if(!result){lastBuildingRequest=Date.now();result=await fetchBuildings(bounds,signal);}
    if(signal.aborted||current!==buildingRevision)return;
    buildings=result;buildingCache.set(key,result);if(buildingCache.size>8)buildingCache.delete(buildingCache.keys().next().value);
    map.getSource('recorded-buildings').setData(buildings);
    buildingStatus(buildings.features.length?`3D · 등록 높이 ${buildings.features.length.toLocaleString()}개`:'이 화면에는 등록된 높이 자료가 없습니다');
    $('building-provenance').textContent=`현재 화면에서 OSM 높이가 등록된 건물 ${buildings.features.length.toLocaleString()}개를 조회했습니다. 원자료 기준 ${buildings.source.timestamp?.slice(0,10)||'확인 불가'}. 다른 지역으로 이동하면 해당 지역을 다시 조회합니다.`;
  }catch(error){if(signal.aborted||current!==buildingRevision)return;console.error(error);buildingStatus('건물 자료 연결 실패',true);$('building-provenance').textContent='현재 화면의 건물 조회가 실패했습니다. 지도에 이미 표시된 건물은 앞서 조회한 실제 자료입니다.';}
}
function status(message,isError=false){
  const el=$('map-status');el.hidden=!message;el.classList.toggle('error',isError);el.textContent=message;
  if(isError&&ready){const retry=document.createElement('button');retry.textContent='다시 시도';retry.onclick=refresh;el.append(retry);}
}
function imageURL(){
  const canvas=document.createElement('canvas');canvas.width=data?.width||1;canvas.height=data?.height||1;
  const ctx=canvas.getContext('2d'),pixels=ctx.createImageData(canvas.width,canvas.height);
  data?.values.forEach((v,i)=>{if(Number.isFinite(v))pixels.data.set([...temperatureColor(v),255],i*4);});
  ctx.putImageData(pixels,0,0);return canvas.toDataURL();
}
function updateSelection(){
  if(!selected)return;
  const {lng,lat,building}=selected;
  const hit=data?observationAt(data,data,lng,lat):{value:null,index:null};
  const origin=hit.index!==null?data?.sources[data.origins[hit.index]]:null;
  $('place').textContent=building?.name||(building?'선택한 건물 주변':'선택한 지점');
  $('temperature').textContent=data?celsius(hit.value):'—';
  $('compact-place').textContent=$('place').textContent;
  $('compact-temperature').textContent=$('temperature').textContent;
  $('value-label').textContent=!data?'분석 대기':origin?`촬영 ${origin.datetime.slice(0,10)}`:hit.index===null?'현재 분석 범위 밖':'유효 관측 없음';
  $('height').textContent=building?(Number.isFinite(building.height)?`${building.height} m`:'높이 미등록'):'등록 자료 없음';
  $('coordinates').textContent=`${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('building-source').hidden=!building;if(building)$('building-source').href=building.sourceURL;
}
function clearAnalysis(){
  revision++;controller?.abort();clearTimeout(timer);data=null;
  if(ready)map.setPaintProperty('temperature','raster-opacity',0);
  $('mean').textContent='—';$('compact-mean').textContent='—';$('range').textContent='—';$('acquisition').textContent='현재 화면 기준으로 자동 검색';$('compact-date').textContent='실제 촬영 자료 검색 중';
  $('coverage').textContent='지도 이동 후 자동 분석';$('scene-source').removeAttribute('href');$('scene-source').textContent='촬영 자료 검색 대기';$('used-scenes').replaceChildren();
  updateSelection();
}
function setSources(){
  const dates=[...new Set(data.sources.map(s=>s.datetime.slice(0,10)))].sort();
  $('acquisition').textContent=dates.length===1?`실제 촬영 ${dates[0]}`:dates.length?`촬영 ${dates[0]} ~ ${dates.at(-1)}`:'유효한 촬영 자료 없음';
  $('compact-date').textContent=$('acquisition').textContent;
  $('scene-source').hidden=true;
  $('used-scenes').replaceChildren(...data.sources.map(source=>{const a=document.createElement('a');a.href=source.url;a.target='_blank';a.rel='noopener';a.textContent=`${source.datetime.slice(0,10)} · ${source.platform.replace('landsat-','Landsat ')} 원자료 ↗`;return a;}));
}
function visibleStats(){
  const width=map.getContainer().clientWidth,height=map.getContainer().clientHeight,values=[];
  for(let y=0;y<data.height;y++)for(let x=0;x<data.width;x++){
    const point=map.project(pixelLocation(data,x,y));
    if(point.x>=0&&point.x<=width&&point.y>=0&&point.y<=height)values.push(data.values[y*data.width+x]);
  }
  return statistics(values);
}
async function refresh(){
  if(!ready||map.isMoving())return;
  clearAnalysis();const current=revision;controller=new AbortController();const signal=controller.signal;
  if(map.getZoom()<8){$('coverage').textContent='지역을 확대하면 자동 분석';status('분석할 지역을 확대해 주세요.');return;}
  status('현재 화면의 위성 자료를 불러오는 중…');
  try{
    const b=map.getBounds(),frame=frameFor([b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]);
    const key=[$('scene').value,...frame.bbox.map(x=>x.toFixed(5)),frame.width,frame.height].join('|');
    const result=cache.get(key)||await loadViewport(frame,$('scene').value,signal,message=>{if(current===revision)status(message);});
    if(signal.aborted||current!==revision)return;
    data=result;cache.set(key,result);if(cache.size>6)cache.delete(cache.keys().next().value);
    const [w,s,e,n]=data.bbox;
    map.getSource('observed-temperature').updateImage({url:imageURL(),coordinates:[[w,n],[e,n],[e,s],[w,s]]});
    map.setPaintProperty('temperature','raster-opacity',$('thermal').checked?0.58:0);
    const stats=visibleStats(),percent=stats.total?Math.floor(stats.count/stats.total*1000)/10:0;
    $('mean').textContent=celsius(stats.mean);$('compact-mean').textContent=$('mean').textContent;$('range').textContent=stats.count?`${stats.min.toFixed(1)} — ${stats.max.toFixed(1)}°C`:'자료 없음';
    $('coverage').textContent=`현재 화면 · 유효 관측 ${percent}% · ${data.sources.length}개 촬영 장면`;
    setSources();updateSelection();
    status(stats.count?'':'이 화면에서 유효한 관측을 찾지 못했습니다. 기준일을 바꾸거나 이동해 주세요.');
  }catch(err){if(signal.aborted||current!==revision)return;console.error(err);$('coverage').textContent='현재 화면 분석 실패';status(err.message||'위성 자료 연결 실패',true);}
}
function schedule(){clearTimeout(timer);timer=setTimeout(refresh,450);}
function syncView(){const tilted=map.getPitch()>5;$('view3d').setAttribute('aria-pressed',String(tilted));$('view2d').setAttribute('aria-pressed',String(!tilted));$('rail-view').setAttribute('aria-pressed',String(tilted));$('rail-view').querySelector('small').textContent=tilted?'3D':'2D';}
async function init(){
  const [style]=await Promise.all([readJSON('https://tiles.openfreemap.org/styles/bright'),import('./vendor/maplibre-gl.js')]);
  const now=new Date(),today=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  $('scene').max=today;$('scene').value=today;
  $('scene').disabled=false;$('scene').onchange=()=>{if(!$('scene').value)$('scene').value=today;clearAnalysis();schedule();};
  $('building-provenance').textContent='현재 화면의 OSM 등록 높이를 조회합니다. 특정 지역에 제한하지 않으며, 높이 미등록 건물은 평면으로 표시합니다.';
  style.layers=style.layers.filter(layer=>layer.type!=='fill-extrusion');
  for(const layer of style.layers){
    if(layer.type==='symbol'&&JSON.stringify(layer.layout?.['text-field']||'').includes('"name"'))layer.layout['text-field']=['coalesce',['get','name:ko'],['get','name'],['get','name_en']];
    if(layer['source-layer']==='building'&&layer.type==='fill'){delete layer.maxzoom;layer.paint['fill-color']='#c5d8d0';layer.paint['fill-opacity']=0.75;}
  }
  map=new globalThis.maplibregl.Map({container:'map',style,hash:true,...camera,maxPitch:65,maxZoom:19,minZoom:3,renderWorldCopies:false,attributionControl:false,locale:{'NavigationControl.ZoomIn':'확대','NavigationControl.ZoomOut':'축소','NavigationControl.ResetBearing':'북쪽으로 회전','AttributionControl.ToggleAttribution':'지도 출처'}});
  map.addControl(new globalThis.maplibregl.AttributionControl({compact:true}));map.addControl(new globalThis.maplibregl.ScaleControl({maxWidth:90,unit:'metric'}),'bottom-left');
  new ResizeObserver(()=>map.resize()).observe($('map'));
  setupFullscreen($('fullscreen'),()=>map.resize());
  map.getCanvas().setAttribute('aria-label','위성 관측 지도. 방향키로 이동하고 +, - 키로 확대 또는 축소할 수 있습니다.');
  $('view3d').onclick=()=>map.easeTo({pitch:55,bearing:-24,duration:650});$('view2d').onclick=()=>map.easeTo({pitch:0,bearing:0,duration:650});$('zoom-in').onclick=()=>map.zoomIn({duration:350});$('zoom-out').onclick=()=>map.zoomOut({duration:350});$('home').onclick=()=>map.flyTo({...camera,duration:900});map.on('pitchend',syncView);
  map.once('load',()=>{
    const firstLabel=map.getStyle().layers.find(x=>x.type==='symbol')?.id;
    map.addSource('observed-temperature',{type:'image',url:imageURL(),coordinates:[[0,1],[1,1],[1,0],[0,0]]});
    map.addLayer({id:'temperature',type:'raster',source:'observed-temperature',paint:{'raster-opacity':0,'raster-resampling':'nearest','raster-fade-duration':0}},firstLabel);
    map.addSource('recorded-buildings',{type:'geojson',data:buildings});
    map.addLayer({id:'building-footprints',type:'fill',source:'recorded-buildings',paint:{'fill-color':'#9bb9ae','fill-opacity':0.28,'fill-outline-color':'#789f91'}},firstLabel);
    map.addLayer({id:'recorded-heights',type:'fill-extrusion',source:'recorded-buildings',minzoom:13,filter:['>', ['coalesce',['get','height'],0],0],paint:{'fill-extrusion-height':['get','height'],'fill-extrusion-base':['get','base'],'fill-extrusion-color':'#e7ccb0','fill-extrusion-opacity':0.92,'fill-extrusion-vertical-gradient':true}},firstLabel);
    map.setLight({anchor:'viewport',position:[1.5,210,40],color:'#fff8e9',intensity:0.4});ready=true;
    map.on('movestart',()=>{clearAnalysis();status('지도 이동 중 · 멈추면 현재 화면을 분석합니다.');});map.on('moveend',schedule);map.on('resize',()=>{clearAnalysis();schedule();});
    map.on('movestart',()=>{cancelBuildings();buildingStatus('이동 후 등록 높이 자동 조회');});map.on('moveend',scheduleBuildings);map.on('resize',scheduleBuildings);
    map.on('click',event=>{
      const hit=map.queryRenderedFeatures(event.point,{layers:['recorded-heights','building-footprints']})[0];
      const original=hit&&buildings.features.find(f=>f.properties.osmId===hit.properties.osmId&&f.properties.osmType===hit.properties.osmType),point=original?footprintPoint(original.geometry):[event.lngLat.lng,event.lngLat.lat];
      selected={lng:point[0],lat:point[1],building:original?.properties};marker?.remove();marker=new globalThis.maplibregl.Marker({color:'#174c42',scale:0.65}).setLngLat(point).addTo(map);updateSelection();
    });
    map.on('mousemove',event=>{map.getCanvas().style.cursor=map.queryRenderedFeatures(event.point,{layers:['recorded-heights','building-footprints']}).length?'pointer':'';});
    refresh();scheduleBuildings();
  });
  $('thermal').onchange=()=>{if(ready&&data)map.setPaintProperty('temperature','raster-opacity',$('thermal').checked?0.58:0);$('legend').hidden=!$('thermal').checked;};$('legend').hidden=!$('thermal').checked;
}
init().catch(err=>{console.error(err);status('지도를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.',true);$('coverage').textContent='자료 연결 실패';});
