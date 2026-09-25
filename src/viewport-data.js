import { statistics, mercatorY, inverseMercatorY } from './observed-data.js';

export const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
export const MAX_SCENES = 4;
export const SEARCH_DAYS = 32;
// Ranking trade-off: 10 percentage points of scene cloud cover cost as much as one day
// of distance from the reference date. A 79 %-cloud scene yesterday loses to a clear
// scene three days ago, but a 20 %-cloud scene on the day still beats a clear one four days off.
export const CLOUD_DAYS_PER_PERCENT = 0.1;
// Landsat C2 L2 surface temperature is delivered on a 30 m grid (resampled from ~100 m TIRS).
export const TARGET_METERS_PER_PIXEL = 30;
export const FRAME_PADDING = 0.2;
const METERS_PER_DEGREE = 111320;

export function frameFor(bounds, { padding = 0, minPixels = 48, maxPixels = 256 } = {}) {
  let [w, s, e, n] = bounds;
  if (padding > 0) {
    const dx = (e - w) * padding, dy = (n - s) * padding;
    [w, s, e, n] = [w - dx, s - dy, e + dx, n + dy];
  }
  const bbox = [Math.max(-180, w), Math.max(-85, s), Math.min(180, e), Math.min(85, n)];
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || bbox[2] - bbox[0] > 90) throw Error('현재 범위가 너무 넓습니다. 지도를 확대해 주세요.');
  const ratio = (bbox[2] - bbox[0]) * Math.PI / 180 / (mercatorY(bbox[3]) - mercatorY(bbox[1]));
  // Size the grid from the ground extent so zoomed-in views stop over-requesting and
  // zoomed-out views use the full budget.
  const midLat = (bbox[1] + bbox[3]) / 2 * Math.PI / 180;
  const groundWidth = (bbox[2] - bbox[0]) * METERS_PER_DEGREE * Math.cos(midLat);
  const groundHeight = (bbox[3] - bbox[1]) * METERS_PER_DEGREE;
  const longSide = Math.round(Math.min(maxPixels, Math.max(minPixels, Math.max(groundWidth, groundHeight) / TARGET_METERS_PER_PIXEL)));
  const width = Math.max(minPixels, Math.round(longSide * Math.min(1, ratio)));
  const height = Math.max(minPixels, Math.round(longSide * Math.min(1, 1 / ratio)));
  return { bbox, projection: 'mercator', width, height, metersPerPixel: groundWidth / width };
}

export function containsBounds(outer, inner) {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && outer[2] >= inner[2] && outer[3] >= inner[3];
}

export function pixelLocation(frame, x, y) {
  const [w, s, e, n] = frame.bbox;
  return [w + (x + 0.5) / frame.width * (e - w), inverseMercatorY(mercatorY(n) - (y + 0.5) / frame.height * (mercatorY(n) - mercatorY(s)))];
}

export function readNPY(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer);
  if (bytes[0] !== 147 || new TextDecoder().decode(bytes.slice(1, 6)) !== 'NUMPY') throw Error('위성 자료 형식 오류');
  const version = bytes[6], offset = version === 1 ? 10 : 12;
  const length = version === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const header = new TextDecoder().decode(bytes.slice(offset, offset + length));
  if (!header.includes("'fortran_order': False") || !header.includes("'descr': '<u2'")) throw Error('지원하지 않는 위성 자료 형식');
  const shape = header.match(/'shape':\s*\(([^)]+)\)/)?.[1].split(',').map(x => Number(x.trim())).filter(x => x > 0);
  if (shape?.length !== 3 || shape[0] !== 3) throw Error('위성 온도·QA·마스크 밴드 누락');
  const count = shape.reduce((a, b) => a * b, 1), start = offset + length;
  if (buffer.byteLength !== start + count * 2) throw Error('위성 자료 전송이 완료되지 않았습니다.');
  const values = new Uint16Array(count);
  for (let i = 0; i < count; i++) values[i] = view.getUint16(start + i * 2, true);
  return { shape, values };
}

// QA_PIXEL (Landsat 8/9 Collection 2):
//   bits 0–5  fill, dilated cloud, cirrus, cloud, cloud shadow, snow → any set = reject
//   bits 8–9  cloud confidence (0 none, 1 low, 2 medium, 3 high)    → medium or high = reject
//   bits 14–15 cirrus confidence                                     → high = reject
// Thin cloud that CFMask does not flag as "cloud" usually still carries medium confidence
// and would otherwise bias the surface temperature low.
export function clearPixel(qa) {
  return (qa & 63) === 0 && ((qa >> 8) & 3) < 2 && ((qa >> 14) & 3) < 3;
}

export function temperatures(raw) {
  const count = raw.shape[1] * raw.shape[2];
  return Array.from({ length: count }, (_, i) => {
    const dn = raw.values[i], qa = raw.values[count + i], mask = raw.values[count * 2 + i];
    return mask > 0 && dn >= 293 && clearPixel(qa) ? Math.round((dn * 0.00341802 + 149 - 273.15) * 100) / 100 : null;
  });
}

export function mergeObservations(target, values, sourceIndex) {
  let added = 0;
  for (let i = 0; i < values.length; i++) {
    if (target.values[i] === null && Number.isFinite(values[i])) { target.values[i] = values[i]; target.origins[i] = sourceIndex; added++; }
  }
  return added;
}

const dayOf = item => Date.parse(item.properties.datetime.slice(0, 10) + 'T00:00:00Z');

export function sceneScore(item, date) {
  const days = Math.abs(dayOf(item) - Date.parse(date + 'T00:00:00Z')) / 86400000;
  return days + (item.properties['eo:cloud_cover'] ?? 100) * CLOUD_DAYS_PER_PERCENT;
}

export function rankScenes(items, date) {
  const target = Date.parse(date + 'T00:00:00Z'), distance = x => Math.abs(dayOf(x) - target);
  return items
    .filter(x => x.assets?.lwir11 && x.assets?.qa_pixel && /^LC0[89]_L2SP_/.test(x.id))
    .sort((a, b) => sceneScore(a, date) - sceneScore(b, date) || distance(a) - distance(b));
}

export function rasterURL(item, frame) {
  const params = new URLSearchParams({ collection: 'landsat-c2-l2', item: item.id, asset_as_band: 'true', unscale: 'false', resampling: 'nearest', reproject: 'nearest', return_mask: 'true', dst_crs: 'EPSG:3857' });
  params.append('assets', 'lwir11'); params.append('assets', 'qa_pixel');
  return `https://planetarycomputer.microsoft.com/api/data/v1/item/bbox/${frame.bbox.join(',')}/${frame.width}x${frame.height}.npy?${params}`;
}

async function request(url, signal) {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  if (!response.ok) throw Error(`위성 자료 서버 응답 ${response.status}`);
  return response;
}

// Scenes are downloaded in parallel but merged strictly in rank order, so the result is
// identical to a sequential mosaic; once the view is covered the remaining downloads are cancelled.
export async function loadViewport(frame, date, signal, onProgress = () => {}) {
  const day = 86400000, target = Date.parse(date + 'T00:00:00Z');
  const interval = [new Date(target - SEARCH_DAYS * day).toISOString(), new Date(target + (SEARCH_DAYS + 1) * day - 1).toISOString()].join('/');
  const params = new URLSearchParams({ collections: 'landsat-c2-l2', bbox: frame.bbox.join(','), datetime: interval, limit: '100', query: JSON.stringify({ 'eo:cloud_cover': { lt: 80 } }) });
  onProgress('위성 촬영 장면 검색 중…');
  const search = await (await request(`${STAC}/search?${params}`, signal)).json();
  const candidates = rankScenes(search.features || [], date);
  const count = frame.width * frame.height;
  const result = {
    ...frame, date,
    values: Array(count).fill(null), origins: Array(count).fill(null), sources: [],
    candidateCount: candidates.length, attemptedScenes: 0, failedScenes: 0,
    partialSearch: search.links?.some(x => x.rel === 'next') || false,
  };
  const chosen = candidates.slice(0, MAX_SCENES);
  if (!chosen.length) return result;
  const rest = new AbortController(), combined = AbortSignal.any([signal, rest.signal]);
  let received = 0;
  onProgress(`장면 ${chosen.length}개 동시 수신 중…`);
  const downloads = chosen.map(item => request(rasterURL(item, frame), combined)
    .then(r => r.arrayBuffer())
    .then(buffer => { received++; onProgress(`장면 수신 ${received}/${chosen.length}`); return readNPY(buffer); }));
  downloads.forEach(p => p.catch(() => {}));
  try {
    for (let i = 0; i < chosen.length; i++) {
      const item = chosen[i];
      result.attemptedScenes++;
      try {
        const raw = await downloads[i];
        if (raw.shape[1] !== frame.height || raw.shape[2] !== frame.width) throw Error('화면 격자 불일치');
        const source = { id: item.id, datetime: item.properties.datetime, platform: item.properties.platform, cloudCover: item.properties['eo:cloud_cover'], url: `${STAC}/collections/landsat-c2-l2/items/${item.id}` };
        if (mergeObservations(result, temperatures(raw), result.sources.length)) result.sources.push(source);
        if (statistics(result.values).count / count >= 0.995) break;
      } catch (err) {
        if (signal.aborted) throw err;
        result.failedScenes++;
      }
    }
  } finally {
    rest.abort();
  }
  if (result.failedScenes === result.attemptedScenes) throw Error('위성 원자료를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}
