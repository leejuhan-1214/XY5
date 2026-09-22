import {observationAt,statistics,temperatureColor,boundsPolygon} from './observed-data.js';
import {footprintPoint} from './footprint.js';

const $=id=>document.getElementById(id);
const dialog=$('sources');
$('sources-open').onclick=()=>dialog.showModal();
$('sources-close').onclick=()=>dialog.close();
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
const celsius=value=>Number.isFinite(value)?`${value.toFixed(1)}°C`:'자료 없음';
const readJSON=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(`${url}: ${r.status}`);return r.json();};
let map,data,scene,selected,marker,ready=false;
const camera={center:[126.7065,37.4479],zoom:15.35,pitch:55,bearing:-24};

function imageURL(){
  const canvas=document.createElement('canvas');canvas.width=data.width;canvas.height=data.height;
  const context=canvas.getContext('2d'),pixels=context.createImageData(data.width,data.height);
  scene.values.forEach((v,i)=>{if(!Number.isFinite(v))return;pixels.data.set([...temperatureColor(v),255],i*4);});
  context.putImageData(pixels,0,0);return canvas.toDataURL();
}
function updateSelection(){
  if(!selected)return;
  const {lng,lat,building}=selected,{value,index}=observationAt(data,scene,lng,lat);
  $('place').textContent=building?.name|| (building?'선택한 건물 주변':'선택한 지점');
  $('temperature').textContent=celsius(value);
  $('value-label').textContent=index===null?'자료 범위 밖':value===null?'유효 관측 없음':'위성 지표면 온도';
  $('height').textContent=building?(Number.isFinite(building.height)?`${building.height} m`:'높이 미등록'):'건물 미선택';
  $('coordinates').textContent=`${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  $('building-source').hidden=!building;
  if(building)$('building-source').href=`https://www.openstreetmap.org/way/${building.osmId}`;
}
function updateScene(){
  scene=data.scenes[Number($('scene').value)];
  const stats=statistics(scene.values);
  $('mean').textContent=celsius(stats.mean);
  $('range').textContent=stats.count?`${stats.min.toFixed(1)} — ${stats.max.toFixed(1)}°C`:'자료 없음';
  const time=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(scene.datetime));
  $('acquisition').textContent=`${scene.platform.replace('landsat-','Landsat ')} · ${time} KST 촬영`;
  $('coverage').textContent=`관측일 ${scene.datetime.slice(0,10)} · 유효 자료 ${(stats.count/stats.total*100).toFixed(0)}%`;
  $('scene-source').href=scene.source;
  if(ready)map.getSource('observed-temperature').updateImage({url:imageURL()});
  updateSelection();
}
function setView(is3D){
  if(!map)return;
  map.easeTo({pitch:is3D?55:0,bearing:is3D?-24:0,duration:650});
}
function syncView(){
  const tilted=map.getPitch()>5;
  $('view3d').setAttribute('aria-pressed',String(tilted));
  $('view2d').setAttribute('aria-pressed',String(!tilted));
}
function error(message){$('map-status').hidden=false;$('map-status').classList.add('error');$('map-status').textContent=message;}

async function init(){
  const [observations,buildings,style]=await Promise.all([
    readJSON('./data/observations.json'),readJSON('./data/buildings.geojson'),readJSON('https://tiles.openfreemap.org/styles/liberty'),import('./vendor/maplibre-gl.js')
  ]);
  data=observations;
  $('scene').replaceChildren(...data.scenes.map((item,i)=>{const option=document.createElement('option');option.value=i;option.textContent=item.datetime.slice(0,10).replaceAll('-',' . ');return option;}));
  $('scene').disabled=false;$('scene').onchange=updateScene;updateScene();
  $('building-provenance').textContent=`${buildings.source.retrievedAt.slice(0,10)} 수집 · 건물 ${buildings.source.total.toLocaleString()}개 중 높이 등록 ${buildings.source.withHeight}개. 도로·배경지도는 OpenFreeMap으로 제공합니다.`;
  // Remove ALL provider extrusion layers: their render_height may be synthesized.
  style.layers=style.layers.filter(layer=>layer.type!=='fill-extrusion');
  for(const layer of style.layers){
    if(layer.type==='symbol'&&JSON.stringify(layer.layout?.['text-field']||'').includes('"name"'))layer.layout['text-field']=['coalesce',['get','name:ko'],['get','name'],['get','name_en']];
    if(layer['source-layer']==='building'&&layer.type==='fill'){delete layer.maxzoom;layer.paint['fill-color']='#cbd3d1';layer.paint['fill-opacity']=0.75;}
  }
  map=new globalThis.maplibregl.Map({container:'map',style,...camera,maxPitch:70,maxZoom:19,minZoom:12,attributionControl:false,locale:{'NavigationControl.ZoomIn':'확대','NavigationControl.ZoomOut':'축소','NavigationControl.ResetBearing':'북쪽으로 회전','AttributionControl.ToggleAttribution':'지도 출처'}});
  map.addControl(new globalThis.maplibregl.AttributionControl({compact:true}));
  map.addControl(new globalThis.maplibregl.NavigationControl({showCompass:true}),'top-right');
  map.addControl(new globalThis.maplibregl.ScaleControl({maxWidth:90,unit:'metric'}),'bottom-left');
  new ResizeObserver(()=>map.resize()).observe($('map'));
  map.getCanvas().setAttribute('aria-label','구월동 3D 지도. 방향키로 이동하고 +, - 키로 확대 또는 축소할 수 있습니다.');
  $('view3d').onclick=()=>setView(true);$('view2d').onclick=()=>setView(false);$('home').onclick=()=>map.flyTo({...camera,duration:900});
  map.on('pitchend',syncView);
  let tileErrors=0;
  map.on('error',()=>{tileErrors++;if(tileErrors>=3)error('배경지도 연결이 원활하지 않습니다. 잠시 후 새로고침해 주세요.');});
  map.once('load',()=>{
    const firstLabel=map.getStyle().layers.find(x=>x.type==='symbol')?.id;
    const [w,s,e,n]=data.bbox;
    map.addSource('observed-temperature',{type:'image',url:imageURL(),coordinates:[[w,n],[e,n],[e,s],[w,s]]});
    map.addLayer({id:'temperature',type:'raster',source:'observed-temperature',paint:{'raster-opacity':0.58,'raster-resampling':'nearest','raster-fade-duration':0}},firstLabel);
    map.addSource('extent',{type:'geojson',data:boundsPolygon(data.bbox)});
    map.addLayer({id:'extent',type:'line',source:'extent',paint:{'line-color':'#56786d','line-width':1,'line-dasharray':[3,3],'line-opacity':0.65}},firstLabel);
    map.addSource('recorded-buildings',{type:'geojson',data:buildings});
    map.addLayer({id:'building-footprints',type:'fill',source:'recorded-buildings',paint:{'fill-color':'#8fa69d','fill-opacity':0.28,'fill-outline-color':'#6f8b81'}},firstLabel);
    map.addLayer({id:'recorded-heights',type:'fill-extrusion',source:'recorded-buildings',filter:['>', ['coalesce',['get','height'],0],0],paint:{'fill-extrusion-height':['get','height'],'fill-extrusion-base':0,'fill-extrusion-color':'#dce8e1','fill-extrusion-opacity':0.94,'fill-extrusion-vertical-gradient':true}},firstLabel);
    map.setLight({anchor:'viewport',position:[1.5,210,40],color:'#fff8e9',intensity:0.4});
    ready=true;map.setPaintProperty('temperature','raster-opacity',$('thermal').checked?0.58:0);
    $('map-status').hidden=true;
    map.on('click',event=>{
      const hits=map.queryRenderedFeatures(event.point,{layers:['recorded-heights','building-footprints']});
      const hit=hits[0];
      // Use the full ground footprint, not the ground ray behind an elevated roof.
      const original=hit&&buildings.features.find(f=>f.properties.osmId===hit.properties.osmId);
      const point=original?footprintPoint(original.geometry):[event.lngLat.lng,event.lngLat.lat];
      selected={lng:point[0],lat:point[1],building:original?.properties};
      marker?.remove();marker=new globalThis.maplibregl.Marker({color:'#174c42',scale:0.65}).setLngLat(point).addTo(map);
      updateSelection();
    });
    map.on('mousemove',event=>{map.getCanvas().style.cursor=map.queryRenderedFeatures(event.point,{layers:['recorded-heights','building-footprints']}).length?'pointer':'';});
  });
  $('thermal').onchange=()=>{if(ready)map.setPaintProperty('temperature','raster-opacity',$('thermal').checked?0.58:0);$('legend').hidden=!$('thermal').checked;};
  $('legend').hidden=!$('thermal').checked;
}
init().catch(err=>{console.error(err);error('자료를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.');$('coverage').textContent='자료 연결 실패';});
