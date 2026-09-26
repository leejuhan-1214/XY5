import assert from 'node:assert/strict';
import {frameFor,readNPY,temperatures,mergeObservations,rankScenes,rasterURL,loadViewport,pixelLocation,clearPixel,containsBounds,sceneScore,selectSceneRaster,searchScenes,STAC,MAX_SEARCH_PAGES} from '../src/viewport-data.js';
import {observationAt} from '../src/observed-data.js';
const first=frameFor([126.65,37.4,126.8,37.55]),other=frameFor([129.05,35.14,129.09,35.18]);
assert.notDeepEqual(first.bbox,other.bbox);
assert.deepEqual(other.bbox,[129.05,35.14,129.09,35.18]);
assert.ok(other.width<=256&&other.height<=256);
const polar=frameFor([10,65,16,72]),cells={values:Array.from({length:polar.width*polar.height},(_,i)=>i)};
for(const [x,y] of [[0,0],[12,90],[polar.width-1,polar.height-1]])assert.equal(observationAt(polar,cells,...pixelLocation(polar,x,y)).index,y*polar.width+x);
assert.throws(()=>frameFor([-180,-85,180,85]),/확대/);
const header="{'descr': '<u2', 'fortran_order': False, 'shape': (3, 1, 4), }\n";
const buffer=new ArrayBuffer(10+header.length+24),bytes=new Uint8Array(buffer),view=new DataView(buffer);
bytes.set([147,78,85,77,80,89,1,0]);view.setUint16(8,header.length,true);bytes.set(new TextEncoder().encode(header),10);
// Valid, cloudy, absent in source, fill DN. Missing values never become zero Celsius.
[45540,45540,45540,0,64,8,64,64,255,255,0,255].forEach((v,i)=>view.setUint16(10+header.length+i*2,v,true));
assert.deepEqual(temperatures(readNPY(buffer)),[31.51,null,null,null]);
assert.throws(()=>readNPY(buffer.slice(0,-2)),/완료/);
const merged={values:[31.51,null,null,null],origins:[0,null,null,null]};
assert.equal(mergeObservations(merged,[40,35,null,36],1),2);
assert.deepEqual(merged,{values:[31.51,35,null,36],origins:[0,1,null,1]});
const item=(day,cloud)=>({id:'LC09_L2SP_'+day,properties:{datetime:day+'T02:00:00Z','eo:cloud_cover':cloud},assets:{lwir11:{},qa_pixel:{}}});
assert.equal(rankScenes([item('2025-06-01',0),item('2025-06-05',20)],'2025-06-05')[0].properties['eo:cloud_cover'],20);
assert.ok(rasterURL(item('2025-06-05',0),other).includes('129.05,35.14,129.09,35.18'));
assert.ok(rasterURL(item('2025-06-05',0),other).includes('assets=qa_pixel'));
assert.ok(rasterURL(item('2025-06-05',0),other).includes('dst_crs=EPSG%3A3857'));
// Empty remote search stays empty, with a viewport-specific request, never a local fallback.
const originalFetch=globalThis.fetch;let requestURL;
globalThis.fetch=async url=>{requestURL=url;return {ok:true,json:async()=>({features:[]})};};
try{const empty=await loadViewport(other,'2025-06-05',new AbortController().signal);assert.ok(empty.values.every(v=>v===null));assert.equal(empty.sources.length,0);assert.ok(decodeURIComponent(requestURL).includes(other.bbox.join(',')));}finally{globalThis.fetch=originalFetch;}
// Grid follows the ground extent: a ~300 m view stops at the minimum, a city view hits the cap.
const tiny=frameFor([126.700,37.447,126.7034,37.4497]);
assert.equal(Math.max(tiny.width,tiny.height),48);
assert.equal(Math.max(first.width,first.height),256);
assert.ok(Math.abs(other.metersPerPixel-30)<3,'mid-size views sample the 30 m product grid');
const padded=frameFor([126.70,37.44,126.72,37.46],{padding:0.2});
assert.deepEqual(padded.bbox.map(v=>+v.toFixed(3)),[126.696,37.436,126.724,37.464]);
assert.ok(containsBounds(padded.bbox,[126.70,37.44,126.72,37.46]));
assert.ok(!containsBounds([126.70,37.44,126.72,37.46],padded.bbox));
// QA: medium/high cloud confidence and high cirrus confidence are rejected; low confidence is kept.
assert.equal(clearPixel(64),true);
assert.equal(clearPixel(64|1<<8),true);
assert.equal(clearPixel(64|2<<8),false);
assert.equal(clearPixel(64|3<<8),false);
assert.equal(clearPixel(64|1<<14),true);
assert.equal(clearPixel(64|3<<14),false);
assert.equal(clearPixel(8),false);
// Cloud cover matters: a 79 % scene one day off loses to a 5 % scene four days off.
assert.equal(rankScenes([item('2025-06-04',79),item('2025-06-01',5)],'2025-06-05')[0].properties.datetime.slice(0,10),'2025-06-01');
assert.equal(sceneScore(item('2025-06-05',20),'2025-06-05'),2);
// Parallel download, rank-ordered merge: the better-ranked scene wins shared pixels even if it arrives last.
const npy=(dn,qa,mask)=>{
  const h="{'descr': '<u2', 'fortran_order': False, 'shape': (3, 1, 4), }\n",b=new ArrayBuffer(10+h.length+24),u=new Uint8Array(b),v=new DataView(b);
  u.set([147,78,85,77,80,89,1,0]);v.setUint16(8,h.length,true);u.set(new TextEncoder().encode(h),10);
  [...dn,...qa,...mask].forEach((x,i)=>v.setUint16(10+h.length+i*2,x,true));return b;
};
const small={bbox:[0,0,1,1],projection:'mercator',width:4,height:1};
const sceneA=item('2025-06-05',50),sceneB=item('2025-06-04',0); // B: 1 day + 0 → ranked first
sceneA.properties.platform=sceneB.properties.platform='landsat-9';
const reply=(buffer,delay)=>new Promise(r=>setTimeout(()=>r({ok:true,arrayBuffer:async()=>buffer}),delay));
try{
  globalThis.fetch=async url=>url.includes('/search?')?{ok:true,json:async()=>({features:[sceneA,sceneB]})}
    :url.includes(sceneB.id)?reply(npy([45540,45540,0,0],[64,64,64,64],[255,255,0,0]),30)
    :reply(npy([46000,46000,46000,46000],[64,64,64,64],[255,255,255,255]),0);
  const mosaic=await loadViewport(small,'2025-06-05',new AbortController().signal);
  assert.deepEqual(mosaic.sources.map(s=>s.id),[sceneB.id,sceneA.id]);
  assert.deepEqual(mosaic.origins,[0,0,1,1]);
  assert.equal(mosaic.values[0],31.51);
  assert.equal(mosaic.failedScenes,0);assert.equal(mosaic.candidateCount,2);
  // One failed scene is reported, not hidden; all failing is an error.
  globalThis.fetch=async url=>url.includes('/search?')?{ok:true,json:async()=>({features:[sceneA,sceneB]})}
    :url.includes(sceneB.id)?{ok:false,status:500}:reply(npy([46000,46000,46000,46000],[64,64,64,64],[255,255,255,255]),0);
  const partial=await loadViewport(small,'2025-06-05',new AbortController().signal);
  assert.equal(partial.failedScenes,1);assert.equal(partial.sources.length,1);
  globalThis.fetch=async url=>url.includes('/search?')?{ok:true,json:async()=>({features:[sceneA,sceneB],links:[{rel:'next'}]})}:{ok:false,status:503};
  await assert.rejects(()=>loadViewport(small,'2025-06-05',new AbortController().signal),/받지 못했/);
  // Once the view is fully covered, lower-ranked downloads are cancelled.
  let aborted=false;
  globalThis.fetch=async(url,{signal}={})=>{
    if(url.includes('/search?'))return {ok:true,json:async()=>({features:[sceneA,sceneB]})};
    if(url.includes(sceneB.id))return reply(npy([45540,45540,45540,45540],[64,64,64,64],[255,255,255,255]),0);
    return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);}));
  };
  const covered=await loadViewport(small,'2025-06-05',new AbortController().signal);
  assert.equal(covered.sources.length,1);assert.ok(aborted,'remaining download aborted');
}finally{globalThis.fetch=originalFetch;}
console.log('Viewport: adaptive grid, padding, QA confidence, cloud-aware ranking, parallel rank-ordered mosaics and failure reporting verified.');

// Complete second-scene values survive even where the first scene owns the mosaic pixel.
try {
  globalThis.fetch=async url=>url.includes('/search?')?{ok:true,json:async()=>({features:[sceneA,sceneB]})}
    :url.includes(sceneB.id)?reply(npy([45540,45540,0,0],[64,64,64,64],[255,255,0,0]),0)
    :reply(npy([46000,46000,46000,46000],[64,64,64,64],[255,255,255,255]),0);
  const data=await loadViewport(small,'2025-06-05',new AbortController().signal);
  const selected=selectSceneRaster(data,sceneA.id);
  assert.equal(data.scenes.length,2);
  assert.notEqual(selected.values[0],data.values[0]);
  assert.equal(selected.values[0],selected.values[3]);
  assert.deepEqual(selected.sources.map(s=>s.id),[sceneA.id]);
  assert.deepEqual(selected.origins,[0,0,0,0]);
  assert.equal(selected.singleScene,true);
  assert.equal(selectSceneRaster(data,'mosaic').singleScene,false);
  // Failed/fully cloudy first four acquisitions cannot hide a usable fifth one.
  const candidates=Array.from({length:7},(_,i)=>item(`2025-06-${String(5+i).padStart(2,'0')}`,0));
  let rasterRequests=0;
  globalThis.fetch=async url=> {
    if(url.includes('/search?'))return {ok:true,json:async()=>({features:candidates})};
    rasterRequests++;
    if(url.includes(candidates[0].id))return {ok:false,status:503};
    return reply(npy([45540,45540,45540,45540],[64,64,64,64],url.includes(candidates[4].id)?[255,255,255,255]:[0,0,0,0]),0);
  };
  const recovered=await loadViewport(small,'2025-06-05',new AbortController().signal);
  assert.ok(rasterRequests>4);assert.equal(recovered.failedScenes,1);
  assert.deepEqual(recovered.sources.map(s=>s.id),[candidates[4].id]);
  // Pagination is followed and bounded; foreign links are not fetched.
  let pages=0;
  globalThis.fetch=async()=>({ok:true,json:async()=>{pages++;return {features:[candidates[pages-1]],links:[{rel:'next',href:`${STAC}/search?page=${pages+1}`}]};}});
  const paged=await searchScenes(`${STAC}/search?page=1`,new AbortController().signal);
  assert.equal(pages,MAX_SEARCH_PAGES);assert.equal(paged.items.length,MAX_SEARCH_PAGES);assert.equal(paged.partialSearch,true);
  pages=0;
  globalThis.fetch=async()=>({ok:true,json:async()=>{pages++;return {features:[sceneA],links:[{rel:'next',href:'https://example.com/untrusted'}]};}});
  assert.equal((await searchScenes(`${STAC}/search`,new AbortController().signal)).partialSearch,true);assert.equal(pages,1);
}finally{globalThis.fetch=originalFetch;}
console.log('Scene integrity: complete scenes, fallback beyond four, bounded same-service pagination verified.');
