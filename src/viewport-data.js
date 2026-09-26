import { statistics, mercatorY, inverseMercatorY } from './observed-data.js';

export const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
export const MAX_SCENES = 12;
export const SCENE_BATCH_SIZE = 4;
export const MAX_SEARCH_PAGES = 3;
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

// Select an actual complete acquisition, never a subset of mosaic-owned pixels.
export function selectSceneRaster(mosaic, sceneId) {
  const selected = mosaic.scenes?.find(scene => scene.source.id === sceneId);
  if (!selected) return { ...mosaic, singleScene: false };
  return { ...mosaic, values: selected.values, sources: [selected.source], origins: selected.values.map(value => Number.isFinite(value) ? 0 : null), singleScene: true };
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

async function request(url, signal, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  if (!response.ok) throw Error(`위성 자료 서버 응답 ${response.status}`);
  return response;
}

// Follow bounded same-service STAC pagination. Never forward a supplied URL to another host.
export async function searchScenes(url, signal) {
  const items = [], seen = new Set();
  let next = { href: url }, pages = 0, previousURL = url;
  while (next && pages < MAX_SEARCH_PAGES) {
    const href = new URL(next.href, previousURL).href;
    previousURL = href;
    const pageKey = href + JSON.stringify(next.body || {});
    if (!href.startsWith(STAC + '/') || seen.has(pageKey)) break;
    seen.add(pageKey);
    const options = next.method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next.body || {}) } : {};
    const page = await (await request(href, signal, options)).json();
    items.push(...(page.features || []));
    pages++;
    next = page.links?.find(link => link.rel === 'next') || null;
    if (next && !next.href) break;
  }
  return { items: [...new Map(items.map(item => [item.id, item])).values()], partialSearch: Boolean(next), searchPages: pages };
}

// Download in bounded parallel batches and merge in rank order. Keep complete successful
// scene rasters: a mosaic's ownership mask cannot reconstruct an individual scene.
export async function loadViewport(frame, date, signal, onProgress = () => {}) {
  const day = 86400000, target = Date.parse(date + 'T00:00:00Z');
  const interval = [new Date(target - SEARCH_DAYS * day).toISOString(), new Date(target + (SEARCH_DAYS + 1) * day - 1).toISOString()].join('/');
  const params = new URLSearchParams({ collections: 'landsat-c2-l2', bbox: frame.bbox.join(','), datetime: interval, limit: '100', query: JSON.stringify({ 'eo:cloud_cover': { lt: 80 } }) });
  onProgress('위성 촬영 장면 검색 중…');
  const search = await searchScenes(`${STAC}/search?${params}`, signal);
  const candidates = rankScenes(search.items, date), count = frame.width * frame.height;
  const result = {
    ...frame, date,
    values: Array(count).fill(null), origins: Array(count).fill(null), sources: [], scenes: [],
    candidateCount: candidates.length, attemptedScenes: 0, failedScenes: 0,
    partialSearch: search.partialSearch, searchPages: search.searchPages,
  };
  const chosen = candidates.slice(0, MAX_SCENES);
  result.candidateLimitReached = candidates.length > chosen.length;
  if (!chosen.length) return result;
  const rest = new AbortController(), combined = AbortSignal.any([signal, rest.signal]);
  let covered = false;
  try {
    for (let start = 0; start < chosen.length && !covered; start += SCENE_BATCH_SIZE) {
      const batch = chosen.slice(start, start + SCENE_BATCH_SIZE);
      onProgress(`장면 ${start + 1}–${start + batch.length}/${chosen.length} 수신 중…`);
      const downloads = batch.map(item => request(rasterURL(item, frame), combined).then(r => r.arrayBuffer()).then(readNPY));
      downloads.forEach(promise => promise.catch(() => {}));
      for (let i = 0; i < batch.length; i++) {
        const item = batch[i];
        result.attemptedScenes++;
        try {
          const raw = await downloads[i];
          if (signal.aborted) throw signal.reason;
          if (raw.shape[1] !== frame.height || raw.shape[2] !== frame.width) throw Error('화면 격자 불일치');
          const source = { id: item.id, datetime: item.properties.datetime, platform: item.properties.platform || 'landsat', cloudCover: item.properties['eo:cloud_cover'], url: `${STAC}/collections/landsat-c2-l2/items/${item.id}` };
          const values = temperatures(raw), validCount = statistics(values).count;
          if (validCount) result.scenes.push({ source, values, validCount });
          if (mergeObservations(result, values, result.sources.length)) result.sources.push(source);
          if (statistics(result.values).count / count >= 0.995) { covered = true; break; }
        } catch (error) {
          if (signal.aborted) throw error;
          result.failedScenes++;
        }
      }
    }
  } finally {
    rest.abort();
  }
  if (result.failedScenes === result.attemptedScenes) throw Error('위성 원자료를 받지 못했습니다. 잠시 후 다시 시도해 주세요.');
  return result;
}
