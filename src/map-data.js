import { GRID_W, GRID_H } from './engine.js';
import { colorAt } from './atlas-data.js';

export const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

export function cellBounds(index, bbox) {
  if (!Number.isInteger(index) || index < 0 || index >= GRID_W * GRID_H) throw new RangeError('Invalid analysis cell');
  const [west, south, east, north] = bbox;
  const dx = (east - west) / GRID_W, dy = (north - south) / GRID_H;
  const x = index % GRID_W, y = Math.floor(index / GRID_W);
  return [west + x * dx, north - (y + 1) * dy, west + (x + 1) * dx, north - y * dy];
}

export function cellCenter(index, bbox) {
  const [w, s, e, n] = cellBounds(index, bbox);
  return [(w + e) / 2, (s + n) / 2];
}

export function cellAt(lng, lat, bbox) {
  const [w, s, e, n] = bbox;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < w || lng > e || lat < s || lat > n) return null;
  const x = Math.min(GRID_W - 1, Math.floor((lng - w) / (e - w) * GRID_W));
  const y = Math.min(GRID_H - 1, Math.floor((n - lat) / (n - s) * GRID_H));
  return y * GRID_W + x;
}

export function boundsPolygon(bbox, properties = {}) {
  const [w, s, e, n] = bbox;
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] } };
}

export function heatFeatures(bbox, selection, mask) {
  const features = [];
  for (let i = 0; i < GRID_W * GRID_H; i++) {
    if (mask && !mask[i]) continue;
    const value = selection.values[i];
    if (!Number.isFinite(value)) continue;
    features.push(boundsPolygon(cellBounds(i, bbox), { cell: i, value, color: colorAt(value, selection.min, selection.max, selection.palette) }));
  }
  return { type: 'FeatureCollection', features };
}

export function hubFeatures(indices, bbox) {
  return { type: 'FeatureCollection', features: indices.map((index, i) => ({ type: 'Feature', properties: { cell: index, name: `냉각 후보 ${i + 1}` }, geometry: { type: 'Point', coordinates: cellCenter(index, bbox) } })) };
}

// Use a point inside the actual footprint, never the ground ray behind a pitched roof.
export function footprintPoint(geometry) {
  const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
  if (!polygons.length) return null;
  const area = ring => { const [ox,oy] = ring[0]; let sum = 0; for(let i=0;i<ring.length-1;i++) sum += (ring[i][0]-ox)*(ring[i+1][1]-oy)-(ring[i+1][0]-ox)*(ring[i][1]-oy); return Math.abs(sum); };
  const rings = [...polygons].sort((a,b)=>area(b[0])-area(a[0]))[0];
  if (!rings?.[0]?.length) return null;
  const ys = [...new Set(rings[0].map(point=>point[1]))].sort((a,b)=>a-b);
  const levels = [(ys[0]+ys.at(-1))/2, ...ys.slice(0,-1).map((y,i)=>(y+ys[i+1])/2)];
  for (const y of levels) {
    const intersections = [];
    for (const ring of rings) for(let i=0;i<ring.length-1;i++) {
      const [x1,y1]=ring[i],[x2,y2]=ring[i+1];
      if ((y1>y)!==(y2>y)) intersections.push(x1+(y-y1)*(x2-x1)/(y2-y1));
    }
    intersections.sort((a,b)=>a-b);
    let best = null, width = 0;
    for(let i=0;i+1<intersections.length;i+=2) if(intersections[i+1]-intersections[i]>width) { width=intersections[i+1]-intersections[i]; best=[(intersections[i+1]+intersections[i])/2,y]; }
    if(best)return best;
  }
  return [...rings[0][0]];
}
