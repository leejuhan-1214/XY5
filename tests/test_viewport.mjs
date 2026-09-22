import assert from 'node:assert/strict';
import {frameFor,readNPY,temperatures,mergeObservations,rankScenes,rasterURL,loadViewport,pixelLocation} from '../src/viewport-data.js';
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
console.log('Viewport: geographic bounds, raw QA, missing data, dated mosaics and empty search verified.');
