import assert from 'node:assert/strict';
import fs from 'node:fs';
import {observationAt,statistics,parseHeight,heightMeters,temperatureColor,stretchScale,histogram,percentile,FIXED_SCALE,TEMPERATURE_RAMP} from '../src/observed-data.js';
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
assert.equal(parseHeight,heightMeters,'one height parser for the whole app');
// Statistics must survive a full 256×256 frame (no spread-argument limits).
const frame=Array.from({length:65536},(_,i)=>i%7===0?null:20+i%30);
const big=statistics(frame);assert.equal(big.min,20);assert.equal(big.max,49);assert.equal(big.total,65536);
// Sequential ramp: relative luminance strictly decreases from cool to hot, and values clamp at both ends.
const luminance=([r,g,b])=>[r,g,b].map(c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}).reduce((a,c,i)=>a+c*[0.2126,0.7152,0.0722][i],0);
const steps=Array.from({length:27},(_,i)=>luminance(temperatureColor(24+i)));
assert.ok(steps.every((v,i)=>i===0||v<steps[i-1]),'lightness is monotonic');
assert.deepEqual(temperatureColor(10),temperatureColor(24));assert.deepEqual(temperatureColor(80),temperatureColor(50));
assert.equal(TEMPERATURE_RAMP.length,8);assert.deepEqual(FIXED_SCALE,{min:24,max:50,mode:'fixed'});
// Fit-to-view uses the 2nd–98th percentiles, so one hot outlier cannot flatten the contrast.
const view=[...Array.from({length:200},(_,i)=>30+i/20),120];
const fit=stretchScale(view);assert.equal(fit.mode,'stretch');assert.ok(fit.max<41&&fit.min>=30);
assert.deepEqual(stretchScale([null,null]),{...FIXED_SCALE});
assert.equal(percentile([1,2,3,4,5],0.5),3);assert.equal(percentile([],0.5),null);
const bins=histogram([10,24,30,49.9,70,null],FIXED_SCALE,26);
assert.equal(bins.length,26);assert.equal(bins[0].count,2);assert.equal(bins.at(-1).count,2);assert.equal(bins.reduce((a,b)=>a+b.count,0),5);
console.log('Observed data: provenance, nulls, coordinates, explicit heights, selected building, colour ramp, stretch scale and histogram verified.');
