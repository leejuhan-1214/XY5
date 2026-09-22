import assert from 'node:assert/strict';
import {heightMeters,buildingQuery,convertBuildings,buildingBounds,fetchBuildings} from '../src/live-buildings.js';
const geom=points=>points.map(([lon,lat])=>({lon,lat}));
const ring=geom([[0,0],[4,0],[4,4],[0,4],[0,0]]);
const way=(id,tags,geometry=ring)=>({type:'way',id,tags,geometry});
const data=convertBuildings({elements:[way(1,{building:'yes',height:'20'}),way(2,{building:'yes','building:levels':'12'}),way(3,{building:'yes',height:'~40'}),way(4,{building:'yes',height:'20',min_height:'25'}),way(5,{building:'yes',height:'50 ft'}),way(6,{'building:part':'yes',height:'24',min_height:'6'})]});
assert.deepEqual(data.features.map(f=>f.properties.osmId),[1,5,6]);
assert.equal(data.features[2].properties.base,6);
assert.equal(heightMeters('50 ft'),15.24);assert.equal(heightMeters('20 m'),20);
for(const h of [null,undefined,'','0','3 levels','20;30','~20'])assert.equal(heightMeters(h),null);
assert.equal(convertBuildings({elements:[way(1,{building:'yes',height:'20'},geom([[0,0],[1,0],[1,1]]))]}).features.length,0);
const relation={type:'relation',id:10,tags:{type:'multipolygon',building:'yes',height:'40'},members:[{type:'way',role:'outer',geometry:geom([[0,0],[4,0],[4,4]])},{type:'way',role:'outer',geometry:geom([[0,0],[0,4],[4,4]])},{type:'way',role:'inner',geometry:geom([[1,1],[2,1],[2,2],[1,2],[1,1]])}]};
const converted=convertBuildings({elements:[relation]}).features[0];
assert.equal(converted.geometry.type,'MultiPolygon');assert.equal(converted.geometry.coordinates[0].length,2);
assert.equal(converted.properties.sourceURL,'https://www.openstreetmap.org/relation/10');
assert.match(buildingQuery([127,37,127.1,37.1]),/37\.000000,127\.000000,37\.100000,127\.100000/);
assert.match(buildingQuery([-74.01,40.70,-74,40.72]),/-74\.010000/);
assert.equal(buildingBounds([-180,-85,180,85]),null);
const originalFetch=globalThis.fetch;let requests=0;
try{
  globalThis.fetch=async()=>{requests++;return {status:429,ok:false};};
  await assert.rejects(()=>fetchBuildings([127,37,127.1,37.1],new AbortController().signal),/혼잡/);
  assert.equal(requests,1,'Do not switch servers to bypass a rate limit');
  requests=0;
  globalThis.fetch=async()=>++requests===1?{status:503,ok:false}:{status:200,ok:true,json:async()=>({elements:[]})};
  const fallback=await fetchBuildings([127,37,127.1,37.1],new AbortController().signal);
  assert.equal(requests,2);assert.equal(fallback.features.length,0);assert.match(fallback.source.url,/overpass-api\.de/);
}finally{globalThis.fetch=originalFetch;}
console.log('Live buildings: registered heights only, unit conversion, global bounds and courtyard relations verified.');
