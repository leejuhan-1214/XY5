// Pure research calculations. Raster cells are row-major, north to south.
// A mask includes/excludes whole cells; it is not an exact polygon boundary clip.
// Geographic bboxes always contain WGS84 [west, south, east, north] in degrees.
import { inverseMercatorY, mercatorY } from './observed-data.js';

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const finite = Number.isFinite;
const included = (mask, i) => mask == null || Boolean(mask[i]);

function checkArray(values, name = 'values') {
  if (values == null || typeof values.length !== 'number') throw new TypeError(`${name} must be an array or typed array`);
}
function checkMask(mask, length) {
  if (mask != null && mask.length !== length) throw new RangeError('mask must match values.length');
}

/** Local azimuthal equidistant coordinates in metres, suitable for city-scale DBSCAN.
 * Distances between off-centre points are projected distances, not geodesics.
 * Cell areas use spherical geographic footprints, not square Mercator map units.
 */
export function gridMetrics({ width, height, bbox, projection = 'geographic' }) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) throw new RangeError('Raster dimensions must be positive integers');
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(finite)) throw new TypeError('bbox must contain four finite WGS84 coordinates');
  const [west, south, east, north] = bbox;
  if (!(east > west && north > south && west >= -180 && east <= 180 && south > -90 && north < 90)) throw new RangeError('Invalid bbox; antimeridian-spanning rasters are not supported');
  if (!['geographic', 'mercator'].includes(projection)) throw new RangeError('projection must be geographic or mercator');
  const count = width * height, dx = (east - west) / width;
  const northY = projection === 'mercator' ? mercatorY(north) : north;
  const southY = projection === 'mercator' ? mercatorY(south) : south;
  const latitude = y => projection === 'mercator' ? inverseMercatorY(y) : y;
  const rowEdges = Array.from({ length: height + 1 }, (_, row) => latitude(northY + (southY - northY) * row / height));
  const lon0 = (west + east) / 2 * RAD, lat0 = (south + north) / 2 * RAD;
  const sin0 = Math.sin(lat0), cos0 = Math.cos(lat0);
  const areas = new Float64Array(count), centers = new Array(count), projectedCenters = new Array(count);
  for (let row = 0; row < height; row++) {
    const lat = latitude(northY + (southY - northY) * (row + .5) / height);
    const phi = lat * RAD, sinPhi = Math.sin(phi), cosPhi = Math.cos(phi);
    const area = EARTH_RADIUS ** 2 * dx * RAD * (Math.sin(rowEdges[row] * RAD) - Math.sin(rowEdges[row + 1] * RAD));
    for (let col = 0; col < width; col++) {
      const i = row * width + col, lng = west + (col + .5) * dx;
      const dl = lng * RAD - lon0;
      const cosC = Math.max(-1, Math.min(1, sin0 * sinPhi + cos0 * cosPhi * Math.cos(dl)));
      const c = Math.acos(cosC), k = c < 1e-10 ? 1 : c / Math.sin(c);
      if (!finite(k) || c > Math.PI - 1e-6) throw new RangeError('Raster is too wide for a local metric projection');
      centers[i] = [lng, lat];
      projectedCenters[i] = [EARTH_RADIUS * k * cosPhi * Math.sin(dl), EARTH_RADIUS * k * (cos0 * sinPhi - sin0 * cosPhi * Math.cos(dl))];
      areas[i] = area;
    }
  }
  const bounds = i => {
    if (!Number.isInteger(i) || i < 0 || i >= count) throw new RangeError('Invalid raster index');
    const row = Math.floor(i / width), col = i % width;
    return [west + col * dx, rowEdges[row + 1], west + (col + 1) * dx, rowEdges[row]];
  };
  return { areas, centers, projectedCenters, bounds, projectionCenter: [lon0 / RAD, lat0 / RAD], distanceMethod: 'local-azimuthal-equidistant', areaMethod: 'spherical-cell-footprints' };
}

/** Population standard deviation; means are unweighted cell means.
 * Without a threshold, hotCount/hotAreaM2 are null. Without known areas,
 * hotAreaM2 stays null instead of assuming a square cell size.
 */
export function summarizeTemperatures({ values, mask = null, areas = null, threshold = null }) {
  checkArray(values); checkMask(mask, values.length);
  if (areas != null && areas.length !== values.length) throw new RangeError('areas must match values.length');
  if (threshold !== null && !finite(threshold)) throw new TypeError('threshold must be finite or null');
  let count = 0, mean = 0, sumSquares = 0, min = Infinity, max = -Infinity;
  let hotCount = threshold === null ? null : 0, hotArea = 0, knownHotArea = areas != null;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!included(mask, i) || !finite(value)) continue;
    count++;
    const delta = value - mean;
    mean += delta / count;
    sumSquares += delta * (value - mean);
    min = Math.min(min, value); max = Math.max(max, value);
    if (threshold !== null && value >= threshold) {
      hotCount++;
      if (areas != null && finite(areas[i]) && areas[i] >= 0) hotArea += areas[i];
      else knownHotArea = false;
    }
  }
  return { count, mean: count ? mean : null, min: count ? min : null, max: count ? max : null,
    stdDev: count ? Math.sqrt(Math.max(0, sumSquares / count)) : null,
    hotCount, hotAreaM2: threshold !== null && knownHotArea ? hotArea : null };
}

function quantileOf(sorted, q) {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q, low = Math.floor(position), high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

// Horizontal runs reduce GeoJSON size without bridging cold/missing gaps or holes.
// Every rectangle is exactly the union of its member raster cells.
function footprint(indices, width, bounds) {
  const coordinates = [];
  for (let p = 0; p < indices.length;) {
    const first = indices[p], row = Math.floor(first / width);
    let last = first;
    while (++p < indices.length && indices[p] === last + 1 && Math.floor(indices[p] / width) === row) last = indices[p];
    const [w, s, , n] = bounds(first), e = bounds(last)[2];
    coordinates.push([[[w, s], [e, s], [e, n], [w, n], [w, s]]]);
  }
  return { type: 'MultiPolygon', coordinates };
}

/** DBSCAN of thresholded finite cells using projected metres and spatial buckets.
 * minPoints includes the point itself. Labels are null (not a hot valid cell),
 * -1 (noise) or 1-based cluster IDs. Border ties use deterministic raster order.
 * threshold defaults to interpolated P90; >= includes ties, so hot fraction can
 * exceed 10%. All hot cells, including noise, contribute to hotAreaM2.
 */
export function analyzeClusters({ values, width, height, bbox, projection = 'geographic', mask = null, threshold = null, quantile = .9, epsMeters = 250, minPoints = 3 }) {
  checkArray(values); checkMask(mask, values.length);
  if (values.length !== width * height) throw new RangeError('values must match raster dimensions');
  if (!finite(quantile) || quantile < 0 || quantile > 1) throw new RangeError('quantile must be in [0, 1]');
  if (!finite(epsMeters) || epsMeters <= 0) throw new RangeError('epsMeters must be positive');
  if (!Number.isInteger(minPoints) || minPoints < 1) throw new RangeError('minPoints must be a positive integer');
  if (threshold !== null && !finite(threshold)) throw new TypeError('threshold must be finite or null');
  const grid = gridMetrics({ width, height, bbox, projection });
  const valid = [], labels = new Array(values.length).fill(null);
  let totalCount = 0, validAreaM2 = 0;
  for (let i = 0; i < values.length; i++) if (included(mask, i)) {
    totalCount++;
    if (finite(values[i])) { valid.push(values[i]); validAreaM2 += grid.areas[i]; }
  }
  const cutoff = threshold === null ? quantileOf(valid.sort((a, b) => a - b), quantile) : threshold;
  // A bucket's diagonal is smaller than eps: its core points form one component.
  // This avoids materializing O(n²) neighbours when an entire dense frame is hot.
  const bucketSize = epsMeters / 2;
  const hotIndices = [], buckets = new Map(), bucketCoordinates = new Array(values.length);
  let hotAreaM2 = 0;
  for (let i = 0; i < values.length; i++) if (included(mask, i) && finite(values[i]) && cutoff !== null && values[i] >= cutoff) {
    hotIndices.push(i); hotAreaM2 += grid.areas[i]; labels[i] = -1;
    const [x, y] = grid.projectedCenters[i], bx = Math.floor(x / bucketSize), by = Math.floor(y / bucketSize), key = `${bx},${by}`;
    bucketCoordinates[i] = [bx, by];
    if (!buckets.has(key)) buckets.set(key, { bx, by, id: buckets.size, points: [], core: [], minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    buckets.get(key).points.push(i);
  }
  const epsSquared = epsMeters ** 2;
  const visitNeighbors = (i, visit) => {
    const [bx, by] = bucketCoordinates[i], [x, y] = grid.projectedCenters[i];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const bucket = buckets.get(`${bx + dx},${by + dy}`);
      if (!bucket) continue;
      for (const j of bucket.points) {
        const [xx, yy] = grid.projectedCenters[j];
        if ((xx - x) ** 2 + (yy - y) ** 2 <= epsSquared && visit(j) === false) return;
      }
    }
  };
  const core = new Uint8Array(values.length), parent = new Int32Array(values.length).fill(-1);
  const find = i => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== i) { const next = parent[i]; parent[i] = root; i = next; }
    return root;
  };
  const join = (a, b) => {
    const aa = find(a), bb = find(b);
    if (aa !== bb) parent[Math.max(aa, bb)] = Math.min(aa, bb);
  };
  for (const bucket of buckets.values()) {
    for (const i of bucket.points) {
      let count = 0;
      if (bucket.points.length >= minPoints) count = minPoints;
      else visitNeighbors(i, () => { count++; return count < minPoints; });
      if (count < minPoints) continue;
      core[i] = 1; parent[i] = i; bucket.core.push(i);
      const [x, y] = grid.projectedCenters[i];
      bucket.minX = Math.min(bucket.minX, x); bucket.maxX = Math.max(bucket.maxX, x);
      bucket.minY = Math.min(bucket.minY, y); bucket.maxY = Math.max(bucket.maxY, y);
    }
    for (let p = 1; p < bucket.core.length; p++) join(bucket.core[0], bucket.core[p]);
  }
  for (const a of buckets.values()) {
    if (!a.core.length) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const b = buckets.get(`${a.bx + dx},${a.by + dy}`);
      if (!b?.core.length || b.id <= a.id || find(a.core[0]) === find(b.core[0])) continue;
      const gapX = Math.max(0, a.minX - b.maxX, b.minX - a.maxX), gapY = Math.max(0, a.minY - b.maxY, b.minY - a.maxY);
      if (gapX ** 2 + gapY ** 2 > epsSquared) continue;
      const spanX = Math.max(Math.abs(a.minX - b.maxX), Math.abs(a.maxX - b.minX));
      const spanY = Math.max(Math.abs(a.minY - b.maxY), Math.abs(a.maxY - b.minY));
      let connected = spanX ** 2 + spanY ** 2 <= epsSquared;
      if (!connected) outer: for (const i of a.core) {
        const [x, y] = grid.projectedCenters[i];
        for (const j of b.core) {
          const [xx, yy] = grid.projectedCenters[j];
          if ((xx - x) ** 2 + (yy - y) ** 2 <= epsSquared) { connected = true; break outer; }
        }
      }
      if (connected) join(a.core[0], b.core[0]);
    }
  }
  const componentIds = new Map();
  for (const i of hotIndices) if (core[i]) {
    const root = find(i);
    if (!componentIds.has(root)) componentIds.set(root, componentIds.size + 1);
    labels[i] = componentIds.get(root);
  }
  // Border points cannot connect two distinct core components. Resolve ambiguous
  // borders to the first core component in raster order, matching deterministic DBSCAN.
  for (const i of hotIndices) if (!core[i]) visitNeighbors(i, j => {
    if (core[j] && (labels[i] === -1 || labels[j] < labels[i])) labels[i] = labels[j];
  });
  const clusterId = componentIds.size;
  const clusters = Array.from({ length: clusterId }, (_, i) => ({ id: i + 1, indices: [] })), noiseIndices = [];
  for (const i of hotIndices) {
    if (labels[i] === -1) noiseIndices.push(i);
    else clusters[labels[i] - 1].indices.push(i);
  }
  for (const cluster of clusters) {
    let sum = 0, max = -Infinity, areaM2 = 0, longitudeSum = 0, latitudeSum = 0;
    for (const i of cluster.indices) {
      sum += values[i]; max = Math.max(max, values[i]); areaM2 += grid.areas[i];
      longitudeSum += grid.centers[i][0] * grid.areas[i]; latitudeSum += grid.centers[i][1] * grid.areas[i];
    }
    Object.assign(cluster, { count: cluster.indices.length, areaM2, mean: sum / cluster.indices.length, max,
      center: [longitudeSum / areaM2, latitudeSum / areaM2], geometry: footprint(cluster.indices, width, grid.bounds) });
  }
  return { threshold: cutoff, validCount: valid.length, totalCount, rasterCount: values.length,
    coverage: totalCount ? valid.length / totalCount : 0, validAreaM2, hotCount: hotIndices.length, hotAreaM2,
    hotFraction: valid.length ? hotIndices.length / valid.length : null, hotIndices,
    clusters, labels, noiseIndices, epsMeters, minPoints,
    distanceMethod: grid.distanceMethod, areaMethod: grid.areaMethod,
    features: { type: 'FeatureCollection', features: clusters.map(({ id, count, areaM2, mean, max, center, geometry }) => ({
      type: 'Feature', id, properties: { id, count, areaM2, mean, max, longitude: center[0], latitude: center[1] }, geometry,
    })) } };
}

/** B minus A, only for two finite values from the same exact scene ID. */
export function compareObservations(a, b) {
  const reject = (reason, reasonCode) => ({ comparable: false, delta: null, reason, reasonCode });
  if (!finite(a?.value) || !finite(b?.value)) return reject('두 지점 모두 유효한 관측값이 필요합니다.', 'missing-value');
  if (typeof a?.source?.id !== 'string' || !a.source.id.trim() || typeof b?.source?.id !== 'string' || !b.source.id.trim()) return reject('위성 촬영 장면의 출처를 확인할 수 없습니다.', 'missing-source');
  if (a.source.id !== b.source.id) return reject('서로 다른 촬영 장면이므로 온도 차이를 계산하지 않습니다.', 'different-source');
  if (a.source.datetime && b.source.datetime && Date.parse(a.source.datetime) !== Date.parse(b.source.datetime)) return reject('장면의 촬영 시각 정보가 일치하지 않습니다.', 'inconsistent-date');
  return { comparable: true, delta: b.value - a.value, reason: null, reasonCode: null };
}

/** Pairwise finite cells only. Pearson r is descriptive, not causal evidence;
 * no significance test assumes independent resampled or spatially adjacent cells.
 */
export function pairSummary(xValues, yValues, { mask = null } = {}) {
  checkArray(xValues, 'xValues'); checkArray(yValues, 'yValues');
  if (xValues.length !== yValues.length) throw new RangeError('Paired arrays must have equal lengths');
  checkMask(mask, xValues.length);
  let count = 0, meanX = 0, meanY = 0, xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < xValues.length; i++) {
    const x = xValues[i], y = yValues[i];
    if (!included(mask, i) || !finite(x) || !finite(y)) continue;
    count++;
    const dx = x - meanX, dy = y - meanY;
    meanX += dx / count; meanY += dy / count;
    xx += dx * (x - meanX); yy += dy * (y - meanY); xy += dx * (y - meanY);
  }
  const defined = count >= 2 && xx > 0 && yy > 0;
  const slope = count >= 2 && xx > 0 ? xy / xx : null;
  return { count, meanX: count ? meanX : null, meanY: count ? meanY : null,
    correlation: defined ? Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy))) : null,
    slope, intercept: slope === null ? null : meanY - slope * meanX,
    reason: count < 2 ? '유효한 자료 쌍이 2개 이상 필요합니다.' : !defined ? '변수의 분산이 0이므로 상관계수를 정의할 수 없습니다.' : null };
}

/** Convenience adapter for the archived Guwol dataset. Caller must display the
 * dataset's Landsat acquisition/source: these indices are not Sentinel-2 data.
 */
export function relationships(dataset) {
  const lst = dataset?.remoteSensing?.lstC;
  if (!lst) return [];
  const mask = dataset.surface?.insideBoundary ?? null;
  return [
    ['ndvi', 'NDVI', dataset.remoteSensing.ndvi, 'Landsat'],
    ['ndbi', 'NDBI', dataset.remoteSensing.ndbi, 'Landsat'],
    ['greenFraction', '녹지 면적 비율', dataset.surface?.greenFraction, 'OSM'],
    ['roadFraction', '도로 면적 비율', dataset.surface?.roadFraction, 'OSM'],
    ['buildingFraction', '건물 면적 비율', dataset.surface?.buildingFraction, 'OSM'],
  ].filter(([, , values]) => values?.length === lst.length).map(([key, label, values, source]) => ({
    key, label, source, ...pairSummary(values, lst, { mask }),
  }));
}
