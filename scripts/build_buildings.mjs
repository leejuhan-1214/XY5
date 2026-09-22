// Offline one-time OSM extract -> explicit height tags only. No levels conversion.
import fs from 'node:fs';
import {parseHeight} from '../src/observed-data.js';
const input=process.argv[2];
if(!input) throw Error('Usage: node scripts/build_buildings.mjs <osm-map.json>');
const raw=JSON.parse(fs.readFileSync(input,'utf8'));
const nodes=new Map(raw.elements.filter(x=>x.type==='node').map(x=>[x.id,[x.lon,x.lat]]));
const features=raw.elements.filter(x=>x.type==='way'&&x.tags?.building&&x.tags.building!=='no').flatMap(way=>{
  const ring=way.nodes.map(id=>nodes.get(id));
  if(ring.length<4||ring.some(x=>!x)||way.nodes[0]!==way.nodes.at(-1))return [];
  return [{type:'Feature',id:way.id,properties:{osmId:way.id,name:way.tags['name:ko']||way.tags.name||'',height:parseHeight(way.tags.height),heightTag:way.tags.height||null,building:way.tags.building,updatedAt:way.timestamp},geometry:{type:'Polygon',coordinates:[ring]}}];
});
const source={url:'https://api.openstreetmap.org/api/0.6/map.json?bbox=126.6925639,37.4340681,126.7218288,37.4610653',retrievedAt:new Date().toISOString(),license:'ODbL-1.0',scope:'Closed building ways in the downloaded map extent; not a complete building inventory',total:features.length,withHeight:features.filter(x=>x.properties.height!==null).length};
fs.writeFileSync(new URL('../data/buildings.geojson',import.meta.url),JSON.stringify({type:'FeatureCollection',source,features}));
console.log(source);
