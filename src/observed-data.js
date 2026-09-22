// Pure helpers shared by the map, data builder and regression tests.
export function parseHeight(raw) {
  if (typeof raw !== 'string' || !/^\d+(?:\.\d+)?(?:\s*m)?$/.test(raw.trim())) return null;
  const value = Number.parseFloat(raw);
  return value > 0 ? value : null;
}
export const mercatorY=lat=>Math.log(Math.tan(Math.PI/4+lat*Math.PI/360));
export const inverseMercatorY=y=>(2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;
export function observationAt(data, scene, lng, lat) {
  const [w,s,e,n] = data.bbox;
  if (![lng,lat].every(Number.isFinite) || lng<w || lng>e || lat<s || lat>n) return {index:null,value:null};
  const x=Math.min(data.width-1,Math.floor((lng-w)/(e-w)*data.width));
  const fraction=data.projection==='mercator'?(mercatorY(n)-mercatorY(lat))/(mercatorY(n)-mercatorY(s)):(n-lat)/(n-s);
  const y=Math.min(data.height-1,Math.floor(fraction*data.height));
  const index=y*data.width+x;
  return {index,value:Number.isFinite(scene.values[index])?scene.values[index]:null};
}
export function statistics(values) {
  const valid=values.filter(Number.isFinite);
  return {count:valid.length,total:values.length,mean:valid.length?valid.reduce((a,b)=>a+b,0)/valid.length:null,min:valid.length?Math.min(...valid):null,max:valid.length?Math.max(...valid):null};
}
export const temperatureColor = value => {
  const stops=[[24,[43,131,186]],[30,[128,205,193]],[36,[246,229,147]],[42,[239,145,84]],[50,[185,49,75]]];
  const v=Math.max(24,Math.min(50,value));
  for(let i=1;i<stops.length;i++) if(v<=stops[i][0]) {
    const [lo,a]=stops[i-1],[hi,b]=stops[i],t=(v-lo)/(hi-lo);
    return a.map((c,k)=>Math.round(c+(b[k]-c)*t));
  }
  return stops.at(-1)[1];
};
export function boundsPolygon([w,s,e,n]) {
  return {type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}};
}
