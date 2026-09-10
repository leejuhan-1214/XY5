import assert from 'node:assert/strict';
import { GUWOL_DATA as data } from '../data/guwol-data.js';
import { GUWOL_HISTORY as history } from '../data/guwol-history.js';
import { createCity, simulate, windVectorAt, airAt, mean, potentialField, optimize, GRID_W } from '../src/engine.js';
import { materialOnlyTypes } from '../src/materials.js';
import { selectMetric, csvResults } from '../src/atlas-data.js';
const city=createCity(data,history),weather=data.weather;
const settings={peakAir:Math.max(...weather.temperature_2m),solar:Math.max(...weather.shortwave_radiation),moisture:weather.soil_moisture_0_to_7cm[11],budget:18,windDeg:0,objective:'exposure',weather,observedHour:11};
const raw=simulate(city.types,{...settings,calibrateLST:false},city);
assert.equal(raw.hourly.length,24);
for(let i=0;i<city.types.length;i++)assert.ok(Math.abs(raw.hourly[0][i]-(airAt(0,settings)+(city.buildings[i]?1.2:2)))<1e-5,'index 0 is midnight initial state');
const base=simulate(city.types,settings,city);settings.calibrationBias=base.calibrationBias;
const warm=simulate(city.types,{...settings,weather:{...weather,temperature_2m:weather.temperature_2m.map(t=>t+5)}},city);
assert.ok(mean(warm.hourly[11])>mean(base.hourly[11])+1,'fixed calibration retains the warmer-weather response');
const ground=city.buildings.findIndex(b=>!b);
for(const [deg,expected] of [[0,[0,1]],[90,[-1,0]],[180,[0,-1]],[270,[1,0]]]){const [u,v]=windVectorAt(ground,{windDeg:deg},city),length=Math.hypot(u,v);assert.ok(Math.abs(u/length-expected[0])<1e-6);assert.ok(Math.abs(v/length-expected[1])<1e-6);}
for(let hour=0;hour<24;hour++){const flux=Array.from(base.hourly[hour]).filter((_,i)=>!city.buildings[i]&&city.insideBoundary[i]).map(t=>Math.max(0,10.2*(t-airAt(hour,settings))));assert.ok(Math.abs(mean(flux)-base.sensible[hour])<1e-6,'heat flux matches displayed calibrated temperature');}
const plan=optimize(city.types,base,settings,city),materialTypes=materialOnlyTypes(city.types,plan.budgetCount),opt=simulate(plan.types,settings,city),material=simulate(materialTypes,settings,city),hour=15;
const latest={base,material,opt,settings,baseField:potentialField(city.types,base,hour,settings,city),materialField:potentialField(materialTypes,material,hour,settings,city),optField:potentialField(plan.types,opt,hour,settings,city)};
const state={latest,hour,optimizedTypes:plan.types,materialTypes};
for(const metricName of ['temperature','potential','delta']){const selections=['baseline','material','optimized'].map(scenario=>selectMetric({city,history,state,metricName,scenario}));for(const d of selections){assert.equal(d.min,selections[0].min);assert.equal(d.max,selections[0].max);assert.ok(Array.from(d.values).every(Number.isFinite));}}
const delta=selectMetric({city,history,state,metricName:'delta',scenario:'baseline'});assert.ok(delta.values.every(v=>v===0));
const observedA=selectMetric({city,history,state,metricName:'mean',scenario:'baseline'}),observedB=selectMetric({city,history,state:{...state,hour:4},metricName:'mean',scenario:'optimized'});assert.deepEqual(observedA.values,observedB.values,'observations do not change with simulated hour or scenario');
const csv=csvResults(city,state).split('\r\n');assert.equal(csv.length,city.types.length+1);assert.ok(csv[0].includes('optimized_delta_c'));assert.equal(csv[1].split(',').length,csv[0].split(',').length);
console.log(JSON.stringify({atlasChecks:'passed',midnightIndex:0,warmWeatherDelta:+(mean(warm.hourly[11])-mean(base.hourly[11])).toFixed(2),commonColorScale:true,csvRows:csv.length-1,cardinalWinds:4}));
