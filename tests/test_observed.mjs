import assert from 'node:assert/strict';
import fs from 'node:fs';
import {observationAt,statistics,parseHeight} from '../src/observed-data.js';
import {footprintPoint} from '../src/footprint.js';
const data=JSON.parse(fs.readFileSync(new URL('../data/observations.json',import.meta.url),'utf8'));
const buildings=JSON.parse(fs.readFileSync(new URL('../data/buildings.geojson',import.meta.url),'utf8'));
assert.equal(data.resampling,'nearest');
assert.deepEqual(data.qaRejectedBits,[0,1,2,3,4,5]);
assert.equal(data.missingValue,null);
for(const scene of data.scenes){
  assert.equal(scene.values.length,data.width*data.height);
  assert.match(scene.source,new RegExp(scene.id+'$'));
  for(const asset of ['lwir11','qa_pixel'])assert.match(scene.assets[asset].sha256,/^[a-f0-9]{64}$/);
  assert.ok(scene.values.every(v=>v===null||Number.isFinite(v)));
}
// Missing cells must stay missing, including averages and points outside the AOI.
const sample={bbox:[1,2,3,4],width:2,height:2},scene={values:[null,32,40,null]};
assert.deepEqual(observationAt(sample,scene,1.25,3.75),{index:0,value:null});
assert.equal(observationAt(sample,scene,2.75,3.75).value,32);
assert.equal(observationAt(sample,scene,1.25,2.25).value,40);
assert.equal(observationAt(sample,scene,4,3).index,null);
assert.equal(observationAt(sample,scene,NaN,3).value,null);
assert.equal(statistics(scene.values).mean,36);
assert.equal(statistics([null,null]).mean,null);
assert.equal(parseHeight('59'),59);assert.equal(parseHeight('59 m'),59);
for(const unknown of [undefined,null,'','3 storeys','~20','10;12','0'])assert.equal(parseHeight(unknown),null);
assert.equal(buildings.features.length,buildings.source.total);
assert.equal(buildings.features.filter(x=>x.properties.height!==null).length,buildings.source.withHeight);
for(const b of buildings.features)assert.equal(b.properties.height,parseHeight(b.properties.heightTag));
const clicked=buildings.features.find(x=>x.properties.osmId===443317681);
assert.equal(clicked.properties.height,67);
// Independently checked against the downloaded TIFF: row 40, col 44, DN 45540.
assert.equal(observationAt(data,data.scenes[0],...footprintPoint(clicked.geometry)).value,31.51);
// The public entry point must never load the legacy simulation graph.
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
assert.match(html,/src="\.\/src\/observed-app.js"/);
assert.doesNotMatch(html,/src="\.\/src\/(?:app|atlas-ui|engine)\.js"/);
console.log('Observed data: provenance, nulls, coordinates, explicit heights and selected building verified.');
