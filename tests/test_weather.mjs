import assert from 'node:assert/strict';
import {interpolateHourly,weatherURL,fetchWeather} from '../src/weather.js';

const hourly={time:['2026-09-04T01:00','2026-09-04T02:00','2026-09-04T03:00'],temperature_2m:[25.4,26.6,27.5],relative_humidity_2m:[61,55,51],wind_speed_10m:[3.75,3.87,3.75],shortwave_radiation_instant:[659.5,787.6,857.3]};
// Exact hour and linear interpolation between hours (a Landsat overpass is never on the hour).
assert.deepEqual(interpolateHourly(hourly,'2026-09-04T02:00:00Z'),{sunlight:787.6,airTemperature:26.6,humidity:55,wind:3.87});
const mid=interpolateHourly(hourly,'2026-09-04T02:30:00Z');
assert.ok(Math.abs(mid.sunlight-822.45)<1e-9&&Math.abs(mid.airTemperature-27.05)<1e-9);
// Outside the returned hours or with a missing value: no fabricated weather.
assert.equal(interpolateHourly(hourly,'2026-09-04T00:30:00Z'),null);
assert.equal(interpolateHourly(hourly,'2026-09-04T04:00:00Z'),null);
assert.equal(interpolateHourly({...hourly,wind_speed_10m:[3.75,null,3.75]},'2026-09-04T02:30:00Z'),null);
assert.equal(interpolateHourly(undefined,'2026-09-04T02:30:00Z'),null);
// The request spans the acquisition day and the next (late-UTC overpasses need hour 24).
const url=new URL(weatherURL('https://archive-api.open-meteo.com/v1/archive',126.7065,37.4479,'2026-09-04T02:10:41Z'));
assert.equal(url.searchParams.get('start_date'),'2026-09-04');assert.equal(url.searchParams.get('end_date'),'2026-09-05');
assert.equal(url.searchParams.get('wind_speed_unit'),'ms');assert.equal(url.searchParams.get('timezone'),'GMT');
assert.match(url.searchParams.get('hourly'),/shortwave_radiation_instant/);
// Archive first for older scenes, recent-analysis fallback, null when neither answers.
const originalFetch=globalThis.fetch,calls=[];
try{
  globalThis.fetch=async url=>{calls.push(new URL(url).host);return calls.length===1?{ok:false,status:500}:{ok:true,json:async()=>({hourly})};};
  const weather=await fetchWeather(126.7,37.4,'2026-09-04T02:00:00Z',new AbortController().signal);
  assert.deepEqual(calls,['archive-api.open-meteo.com','api.open-meteo.com']);
  assert.equal(weather.airTemperature,26.6);assert.equal(weather.source,'weather');assert.match(weather.label,/Open-Meteo/);
  globalThis.fetch=async()=>({ok:false,status:503});
  assert.equal(await fetchWeather(126.7,37.4,'2026-09-04T02:00:00Z',new AbortController().signal),null);
}finally{globalThis.fetch=originalFetch;}
console.log('Weather: hourly interpolation, request window, archive/recent fallback and no fabricated values verified.');
