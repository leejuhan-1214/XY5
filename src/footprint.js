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
