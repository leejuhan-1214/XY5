import { percentile, GRID_W, GRID_H } from './engine.js';
import { byId } from './materials.js';

export const METRICS = {
  temperature: {label:'모의 지표면온도',unit:'°C',kind:'simulation',description:'선택한 시각의 에너지수지 모형 결과입니다. 세 시나리오에 같은 색상 범위를 적용합니다.'},
  delta: {label:'현재 대비 온도 변화',unit:'°C',kind:'simulation',description:'선택한 시나리오에서 현재 도시의 온도를 뺀 값입니다. 음수는 냉각, 양수는 가열입니다.'},
  potential: {label:'열퍼텐셜',unit:'Φ',kind:'simulation',description:'온도·열저장·바람 정체·녹지·수분을 합친 비교 지수입니다. 물리적 에너지 단위가 아닙니다.'},
  frequency: {label:'반복 고온 빈도',unit:'%',key:'hotFrequencyPercent',description:'촬영일마다 분석 범위에서 가장 뜨거운 상위 20%에 포함된 빈도입니다. 관측값은 시나리오에 따라 바뀌지 않습니다.'},
  mean: {label:'다년 평균 LST',unit:'°C',key:'meanLstC',description:'2018–2025년의 유효 위성 장면에서 산출한 평균 지표면온도입니다. 대기온도와 다릅니다.'},
  p90: {label:'다년 고온 P90',unit:'°C',key:'p90LstC',description:'셀별 관측 온도의 90백분위수입니다. 위성 촬영일의 고온 정도를 보여줍니다.'},
  trend: {label:'상대 열추세',unit:'°C/년',key:'trendCPerYear',description:'장면별 지역 평균을 뺀 공간 편차의 변화입니다. 기상 보정된 장기 기후추세가 아닙니다.'},
  ndvi: {label:'중앙 NDVI',unit:'',key:'medianNdvi',description:'식생 지수의 중앙값입니다. 값이 클수록 식생 신호가 강한 경향이 있습니다.'},
  scene: {label:'개별 장면 LST',unit:'°C',description:'선택한 촬영일의 위성 지표면온도입니다. 시간 재생과 개입 시나리오는 관측값을 바꾸지 않습니다.'},
};
export const SCENARIOS = {baseline:'현재 구월동',material:'재료 물성 변경',optimized:'AI 재료·위치 최적화'};
export const scenarioKey = value => ({baseline:'base',material:'material',optimized:'opt'}[value] || 'base');
export function selectMetric({city,history,state,metricName,scenario='baseline',sceneIndex=0}) {
  const metric = METRICS[metricName] || METRICS.frequency, latest=state?.latest;
  const hour=state?.hour??15, key=scenarioKey(scenario);
  let values, all;
  if(metric.kind==='simulation' && latest) {
    if(metricName==='temperature') {values=latest[key].hourly[hour];all=['base','material','opt'].flatMap(s=>Array.from(latest[s].hourly[hour]));}
    if(metricName==='potential') {const field={base:'baseField',material:'materialField',opt:'optField'};values=latest[field[key]];all=Object.values(field).flatMap(f=>Array.from(latest[f]));}
    if(metricName==='delta') {const base=latest.base.hourly[hour];values=Float32Array.from(latest[key].hourly[hour],(v,i)=>v-base[i]);all=['material','opt'].flatMap(s=>Array.from(latest[s].hourly[hour],(v,i)=>v-base[i]));}
  } else if(metric.kind==='simulation') { values=city.observedLST; }
  else if(metricName==='scene') values=history.sceneMaps.lstC[Math.max(0,Math.min(history.sceneCount-1,Number(sceneIndex)||0))];
  else values=history.metrics[metric.key];
  all ||= Array.from(values);
  let min=percentile(all,.03),max=percentile(all,.97);
  if(metricName==='delta'||metricName==='trend'){max=Math.max(.1,Math.abs(min),Math.abs(max));min=-max;}
  if(metricName==='frequency'){min=0;max=100;}
  if(max===min)max=min+.1;
  const palette=metricName==='delta'||metricName==='trend'?['#58b8de','#bfded9','#f0ddb5','#fa755c']:metricName==='ndvi'?['#4c6573','#8ca6a2','#99cb84','#36b777']:['#528dc3','#64c7be','#f3d47c','#f47b59'];
  return {metric,values,min,max,palette,all,hour};
}
export function colorAt(value,min,max,palette) {
  const t=Math.max(0,Math.min(1,(value-min)/(max-min)))*(palette.length-1),i=Math.min(palette.length-2,Math.floor(t));
  const rgb=s=>[1,3,5].map(k=>parseInt(s.slice(k,k+2),16)),a=rgb(palette[i]),b=rgb(palette[i+1]);
  return '#'+a.map((v,k)=>Math.round(v+(b[k]-v)*(t-i)).toString(16).padStart(2,'0')).join('');
}
export function csvResults(city,state) {
  const header='cell,column,row,hour_kst,baseline_c,material_c,optimized_c,optimized_delta_c,baseline_material,optimized_material,height_m';
  const rows=[];
  for(let i=0;i<GRID_W*GRID_H;i++){if(city.insideBoundary&&!city.insideBoundary[i])continue;const h=state.hour,b=state.latest.base.hourly[h][i],m=state.latest.material.hourly[h][i],o=state.latest.opt.hourly[h][i];rows.push([i+1,i%GRID_W+1,Math.floor(i/GRID_W)+1,h,b.toFixed(3),m.toFixed(3),o.toFixed(3),(o-b).toFixed(3),byId(city.types[i]).name,byId(state.optimizedTypes[i]).name,city.heights[i].toFixed(1)].join(','));}
  return '\uFEFF'+[header,...rows].join('\r\n');
}
