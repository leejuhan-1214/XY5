import test from 'node:test';
import assert from 'node:assert/strict';
import { runResearchExperiment, simulateResearch, predictAtAcquisition, validationMetrics } from '../src/research-model.js';

const makeData = () => ({
  grid: { width: 4, height: 3 }, bbox: [126.700, 37.440, 126.712, 37.449],
  surface: { material: [0,2,0,5,1,2,0,6,0,2,1,0], insideBoundary: [1,1,1,1,1,1,1,1,1,1,0,1] },
  demand: { activityProxy: Array(12).fill(1), vulnerabilityProxy: Array(12).fill(1) },
  remoteSensing: { lstC: Array(12).fill(44), ndvi: Array(12).fill(0.4) },
  weather: {
    time: Array.from({length:24}, (_,i)=>`2024-08-29T${String(i).padStart(2,'0')}:00`),
    temperature_2m: Array.from({length:24}, (_,i)=>26 + 4*Math.sin((i-7)*Math.PI/12)),
    shortwave_radiation: Array.from({length:24}, (_,i)=>Math.max(0,750*Math.sin((i-6)*Math.PI/12))),
    relative_humidity_2m: Array(24).fill(65), wind_speed_10m: Array(24).fill(4),
    wind_direction_10m: Array(24).fill(90), soil_moisture_0_to_7cm: Array(24).fill(0.4),
  },
});

test('validation excludes null, nonfinite and masked samples without coercion', () => {
  const metrics = validationMetrics([2,null,3,8,Infinity],[1,2,5,6,1],[1,1,1,0,1]);
  assert.equal(metrics.count,2); assert.equal(metrics.mae,1.5);
  assert.equal(metrics.bias,-0.5); assert.equal(metrics.rmse,Math.sqrt(2.5));
  assert.equal(metrics.r2,0.375);
  assert.deepEqual(validationMetrics([null],[0]),{count:0,mae:null,rmse:null,bias:null,r2:null});
  assert.equal(validationMetrics([1,2],[3,3]).r2,null);
});

test('same LST cannot leak into model prediction; masks remain null', () => {
  const a=makeData(),b=makeData();
  b.remoteSensing={lstC:Array(12).fill(-99),ndvi:Array(12).fill(0.9)};
  const first=simulateResearch(a),second=simulateResearch(b);
  assert.deepEqual(first.hourly,second.hourly);
  assert.equal(first.hourly.length,25);
  assert.ok(first.hourly.every(frame=>frame[10]===null));
  assert.ok(first.hourly.every(frame=>frame.every(value=>value===null || Number.isFinite(value))));
  assert.ok(first.diagnostics.maxCFL<=0.45+1e-12);
  assert.ok(first.diagnostics.minTimeStepS>0);
});

test('zero resource budget means exact equality of all three scenario trajectories', () => {
  const result=runResearchExperiment(makeData(),{budgetPercent:0});
  assert.equal(result.plan.budgetCount,0);assert.equal(result.plan.costUnits,0);
  assert.deepEqual(result.models[0].hourly,result.models[1].hourly);
  assert.deepEqual(result.models[0].hourly,result.models[2].hourly);
  assert.ok(result.models.every(model=>model.changedCells.length===0));
  assert.ok(result.models.every(model=>model.hourlyStats.every(stat=>stat.threshold===result.threshold)));
});

test('GA is reproducible and obeys masks, placement type and identical material/cost inventory', () => {
  const data=makeData();
  const first=runResearchExperiment(data,{budgetPercent:50,seed:9}),second=runResearchExperiment(data,{budgetPercent:50,seed:9});
  assert.deepEqual(first.plan,second.plan);
  assert.deepEqual(first.models[2].hourly,second.models[2].hourly);
  const materialCounts=model=>model.changedCells.reduce((counts,index)=>{counts[model.types[index]]=(counts[model.types[index]]||0)+1;return counts;},{});
  assert.deepEqual(materialCounts(first.models[1]),materialCounts(first.models[2]));
  assert.deepEqual(materialCounts(first.models[1]),first.plan.inventory);
  for(const model of first.models.slice(1)) {
    assert.equal(model.changedCells.length,first.plan.budgetCount);
    assert.equal(model.types[10],data.surface.material[10]);
    assert.equal(model.types[3],5); assert.equal(model.types[7],6);
    for(const index of model.changedCells) {
      if(data.surface.material[index]===2)assert.ok([7,9].includes(model.types[index]));
      else assert.ok([3,4].includes(model.types[index]));
    }
  }
  assert.ok(first.plan.objectiveOptimized<=first.plan.objectiveFixed+1e-10);
  assert.ok(first.plan.evaluatedLayouts>1);
  assert.ok(first.models.every(model=>model.stats.threshold===first.threshold));
});

test('wind transports air, affects surface through sensible exchange, and can be isolated', () => {
  const data=makeData(), wind=simulateResearch(data), still=simulateResearch(data,{windEnabled:false});
  assert.notDeepEqual(wind.airHourly[12],still.airHourly[12]);
  assert.notDeepEqual(wind.hourly[12],still.hourly[12]);
  assert.ok(still.airFluxHourly[12].every(vector=>vector===null || vector.every(value=>value===0)));
  assert.ok(wind.airFluxHourly[12].some(vector=>vector && Math.abs(vector[0])>0));
});

test('acquisition comparison uses exact Korean local time and rejects wrong weather date', () => {
  const data=makeData();
  const predicted=predictAtAcquisition(data,{datetime:'2024-08-29T02:10:30Z'});
  assert.equal(predicted.hour,11.175);assert.equal(predicted.metadata.date,'2024-08-29');
  assert.deepEqual(predicted.values,simulateResearch(data,{endHour:11.175}).final);
  assert.notDeepEqual(predicted.values,simulateResearch(data,{endHour:11}).final);
  assert.throws(()=>predictAtAcquisition(data,{datetime:'2025-06-05T02:10:00Z'}),/기상 날짜/);
  data.weather.temperature_2m[10]=null;
  assert.throws(()=>simulateResearch(data),/결측/);
});

test('absent material cells are excluded and missing candidates return a finite empty plan', () => {
  const data=makeData();data.surface.material[2]=null;
  const result=runResearchExperiment(data,{budgetPercent:0});
  assert.equal(result.models[0].values[2],null);
  data.surface.insideBoundary.fill(0);
  const empty=runResearchExperiment(data);
  assert.equal(empty.threshold,null);assert.equal(empty.models[0].stats.count,0);
  assert.equal(empty.plan.budgetCount,0);assert.equal(empty.models[0].objective,null);
});


test('optimization never reads LST-derived legacy demand or observed LST', () => {
  const a=makeData(),b=makeData();
  b.remoteSensing.lstC=Array(12).fill(1000);
  b.demand.activityProxy=Array.from({length:12},(_,i)=>i*1e8);
  b.demand.vulnerabilityProxy=Array.from({length:12},(_,i)=>1e10-i*1e8);
  const first=runResearchExperiment(a,{budgetPercent:50,seed:27});
  const changed=runResearchExperiment(b,{budgetPercent:50,seed:27});
  assert.deepEqual(first.plan,changed.plan);
  assert.deepEqual(first.models.map(model=>model.types),changed.models.map(model=>model.types));
  assert.deepEqual(first.models.map(model=>model.hourly),changed.models.map(model=>model.hourly));
  assert.equal(first.metadata.observationLSTUsed,false);
  assert.equal(first.metadata.legacyDemandUsed,false);
  assert.match(first.plan.demandWeight,/동일 단위수요/);
});
