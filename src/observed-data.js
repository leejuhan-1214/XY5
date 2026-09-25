// Pure helpers shared by the map, data builders and regression tests.

// OSM `height` tag → metres. Only explicit metre/feet values are accepted;
// storeys, ranges and approximate values stay unknown (null).
export function heightMeters(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|ft)?$/);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === 'ft' ? 0.3048 : 1);
  return Number.isFinite(value) && value > 0 ? value : null;
}
/** @deprecated Kept for the legacy Guwol build script; same rules as heightMeters. */
export const parseHeight = heightMeters;

export const mercatorY = lat => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
export const inverseMercatorY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI;

export function observationAt(data, scene, lng, lat) {
  const [w, s, e, n] = data.bbox;
  if (![lng, lat].every(Number.isFinite) || lng < w || lng > e || lat < s || lat > n) return { index: null, value: null };
  const x = Math.min(data.width - 1, Math.floor((lng - w) / (e - w) * data.width));
  const fraction = data.projection === 'mercator'
    ? (mercatorY(n) - mercatorY(lat)) / (mercatorY(n) - mercatorY(s))
    : (n - lat) / (n - s);
  const y = Math.min(data.height - 1, Math.floor(fraction * data.height));
  const index = y * data.width + x;
  return { index, value: Number.isFinite(scene.values[index]) ? scene.values[index] : null };
}

// Loops instead of Math.min(...values): a 256×256 frame is too many spread arguments for some engines.
export function statistics(values) {
  let count = 0, sum = 0, min = Infinity, max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    count++; sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count, total: values.length, mean: count ? sum / count : null, min: count ? min : null, max: count ? max : null };
}

// Linear-interpolated percentile of the finite values (p in 0..1).
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = Math.min(1, Math.max(0, p)) * (sorted.length - 1), low = Math.floor(position);
  return sorted[low] + (sorted[Math.min(sorted.length - 1, low + 1)] - sorted[low]) * (position - low);
}

// Single-hue sequential ramp (OKLCH hue ≈ 45°, lightness 0.93 → 0.37): cooler surfaces recede
// toward the light basemap and hot surfaces read darkest. Monotonic lightness keeps it
// readable for colour-vision deficiencies, unlike the previous blue→red rainbow.
export const TEMPERATURE_RAMP = ['#fde1d5', '#febda0', '#f6996f', '#e87841', '#d05b17', '#af4803', '#8b3906', '#6b2801'];
export const FIXED_SCALE = Object.freeze({ min: 24, max: 50, mode: 'fixed' });
const RAMP_RGB = TEMPERATURE_RAMP.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));

export function temperatureColor(value, scale = FIXED_SCALE) {
  const span = scale.max - scale.min;
  const t = span > 0 ? Math.min(1, Math.max(0, (value - scale.min) / span)) : 0.5;
  const position = t * (RAMP_RGB.length - 1), i = Math.min(RAMP_RGB.length - 2, Math.floor(position)), f = position - i;
  return RAMP_RGB[i].map((c, k) => Math.round(c + (RAMP_RGB[i + 1][k] - c) * f));
}

// "Fit to view": 2nd–98th percentile so a few extreme pixels cannot flatten the contrast.
export function stretchScale(values) {
  const low = percentile(values, 0.02), high = percentile(values, 0.98);
  if (low === null) return { ...FIXED_SCALE };
  let min = Math.floor(low * 2) / 2, max = Math.ceil(high * 2) / 2;
  if (max - min < 2) { const mid = (min + max) / 2; min = mid - 1; max = mid + 1; }
  return { min, max, mode: 'stretch' };
}

// Equal-width bins over the scale; out-of-range values fall into the end bins.
export function histogram(values, scale, bins = 24) {
  const counts = new Array(bins).fill(0), width = (scale.max - scale.min) / bins;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    counts[Math.min(bins - 1, Math.max(0, Math.floor((v - scale.min) / width)))]++;
  }
  return counts.map((count, i) => ({ count, from: scale.min + i * width, to: scale.min + (i + 1) * width }));
}

export function boundsPolygon([w, s, e, n]) {
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] } };
}
