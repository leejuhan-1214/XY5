import { observationAt, statistics, temperatureColor, stretchScale, histogram, mercatorY, FIXED_SCALE, TEMPERATURE_RAMP } from './observed-data.js';
import { footprintPoint } from './footprint.js';
import { frameFor, loadViewport, containsBounds, FRAME_PADDING, SEARCH_DAYS } from './viewport-data.js';
import { setupFullscreen } from './fullscreen.js';
import { emptyBuildings, buildingBounds, fetchBuildings } from './live-buildings.js';
import { MATERIAL } from './materials.js';
import { MATERIAL_CHOICES, ASSUMED_CONDITIONS, materialEnergy, materialTemperature, circleAt } from './material-scenario.js';
import { fetchWeather } from './weather.js';

const $ = id => document.getElementById(id);
const HOME = { center: [126.7065, 37.4479], zoom: 15.35, pitch: 55, bearing: -24 };
const MIN_ANALYSIS_ZOOM = 8;
const MIN_BUILDING_ZOOM = 13;
const HISTOGRAM_BINS = 26;
const mobile = window.matchMedia('(max-width: 760px)');

const number = (v, digits = 1) => v.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const celsius = (v, digits = 1) => Number.isFinite(v) ? `${number(v, digits)}°C` : '자료 없음';
const signed = (v, unit, digits = 1) => Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : '±'}${number(Math.abs(v), digits)}${unit}` : '—';
const dayOf = source => source.datetime.slice(0, 10);
const daysBetween = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86400000);

const state = {
  map: null,
  ready: false,
  data: null, // the mosaic on screen; it may extend beyond the view (padded request)
  visible: { values: [], stats: statistics([]) },
  scale: { ...FIXED_SCALE, mode: 'stretch' },
  scaleMode: 'stretch', // relative pattern within the view; 'fixed' keeps 24–50 °C for comparing places
  opacity: 0.65,
  selected: null,
  marker: null,
  buildings: emptyBuildings(),
  buildingState: 'idle',
  materialMode: false,
  materialTarget: null,
  materialKind: 'ground',
  materialCleared: false,
  weather: null,
  weatherKey: null,
};
// `?debug` exposes the live state for inspection in the browser console.
if (new URLSearchParams(location.search).has('debug')) globalThis.xy5 = state;

/* ───────────── Status and panel ───────────── */

function setStatus(message, tone = 'info', retry = null) {
  const el = $('map-status');
  el.hidden = !message;
  el.dataset.tone = tone;
  el.replaceChildren();
  if (!message) return;
  if (tone === 'loading') el.append(Object.assign(document.createElement('span'), { className: 'spinner', ariaHidden: 'true' }));
  el.append(document.createTextNode(message));
  if (retry) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: '다시 시도' });
    button.onclick = retry;
    el.append(button);
  }
}

function setPanel(open) {
  document.body.classList.toggle('panel-collapsed', !open);
  $('panel-toggle').setAttribute('aria-expanded', String(open));
  $('panel-toggle').setAttribute('aria-label', open ? '패널 접기' : '패널 펼치기');
}

function setMaterialMode(active) {
  state.materialMode = active;
  document.body.classList.toggle('materials-mode', active);
  $('material-toggle').setAttribute('aria-pressed', String(active));
  $('mode-observe').setAttribute('aria-pressed', String(!active));
  if (active && state.selected && !state.materialCleared) placeMaterial(state.selected);
  if (state.ready) for (const id of ['material-ground', 'material-roof', 'material-boundary']) state.map.setLayoutProperty(id, 'visibility', active ? 'visible' : 'none');
  setPanel(true);
}

/* ───────────── Colour scale, overlay, histogram, legend ───────────── */

// Values beyond either end are clamped into the end colours and bins in both modes.
function scaleLabels(scale) {
  return { min: `≤${number(scale.min, scale.min % 1 ? 1 : 0)}`, max: `≥${number(scale.max, scale.max % 1 ? 1 : 0)}` };
}

function renderOverlay() {
  const data = state.data;
  if (!state.ready || !data) return;
  const canvas = document.createElement('canvas');
  canvas.width = data.width; canvas.height = data.height;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(data.width, data.height);
  data.values.forEach((v, i) => { if (Number.isFinite(v)) pixels.data.set([...temperatureColor(v, state.scale), 255], i * 4); });
  ctx.putImageData(pixels, 0, 0);
  const [w, s, e, n] = data.bbox;
  state.map.getSource('observed-temperature').updateImage({ url: canvas.toDataURL(), coordinates: [[w, n], [e, n], [e, s], [w, s]] });
  applyOpacity();
}

function applyOpacity() {
  if (!state.ready) return;
  const on = $('thermal').checked && state.data;
  state.map.setPaintProperty('temperature', 'raster-opacity', on ? state.opacity : 0);
  document.body.classList.toggle('thermal-off', !$('thermal').checked);
}

const rampColor = t => `rgb(${temperatureColor(state.scale.min + t * (state.scale.max - state.scale.min), state.scale).join(',')})`;
const scalePosition = v => Math.min(100, Math.max(0, (v - state.scale.min) / (state.scale.max - state.scale.min) * 100));

function renderHistogram() {
  const root = $('histogram'), { values, stats } = state.visible;
  const bins = histogram(values, state.scale, HISTOGRAM_BINS), peak = Math.max(1, ...bins.map(b => b.count));
  root.replaceChildren(...bins.map((bin, i) => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.setProperty('--h', `${bin.count ? Math.max(3, bin.count / peak * 100) : 0}%`);
    bar.style.setProperty('--c', rampColor((i + 0.5) / bins.length));
    const first = i === 0, last = i === bins.length - 1;
    const range = first ? `${number(bin.to)}°C 미만` : last ? `${number(bin.from)}°C 이상` : `${number(bin.from)}–${number(bin.to)}°C`;
    const share = stats.count ? bin.count / stats.count * 100 : 0;
    bar.dataset.tip = `${range} · ${bin.count.toLocaleString('ko-KR')}화소 (${number(share)}%)`;
    return bar;
  }));
  const markers = [];
  if (Number.isFinite(stats.mean)) markers.push(['mean', stats.mean, `평균 ${celsius(stats.mean)}`]);
  const picked = selectedObservation();
  if (Number.isFinite(picked.value)) markers.push(['picked', picked.value, `선택 ${celsius(picked.value)}`]);
  root.append(...markers.map(([kind, value, label]) => {
    const marker = document.createElement('div');
    marker.className = `marker ${kind}`;
    marker.style.left = `${scalePosition(value)}%`;
    marker.dataset.label = label;
    return marker;
  }));
  root.setAttribute('aria-label', stats.count
    ? `현재 화면 지표면 온도 분포. 평균 ${celsius(stats.mean)}, 최저 ${celsius(stats.min)}, 최고 ${celsius(stats.max)}.`
    : '현재 화면에 유효한 관측이 없습니다.');
  const labels = scaleLabels(state.scale);
  $('axis-min').textContent = labels.min;
  $('axis-max').textContent = `${labels.max}°C`;
  $('axis-mid').textContent = number((state.scale.min + state.scale.max) / 2, 0);
}

function renderLegend() {
  const gradient = `linear-gradient(90deg, ${TEMPERATURE_RAMP.join(', ')})`;
  for (const el of document.querySelectorAll('.ramp')) el.style.background = gradient;
  const labels = scaleLabels(state.scale);
  $('legend-min').textContent = labels.min;
  $('legend-max').textContent = `${labels.max}°C`;
  $('legend-mode').textContent = state.scale.mode === 'fixed' ? '고정 범위' : '화면 맞춤';
  const mean = state.visible.stats.mean, marker = $('legend-mean');
  marker.hidden = !Number.isFinite(mean);
  if (Number.isFinite(mean)) { marker.style.left = `${scalePosition(mean)}%`; marker.title = `현재 화면 평균 ${celsius(mean)}`; }
}

function setScaleMode(mode) {
  state.scaleMode = mode;
  $('scale-fixed').setAttribute('aria-pressed', String(mode === 'fixed'));
  $('scale-stretch').setAttribute('aria-pressed', String(mode === 'stretch'));
  updateScale();
}

// Returns true when the colour scale changed (the overlay must then be recoloured).
function computeScale() {
  const next = state.scaleMode === 'stretch' ? { ...stretchScale(state.visible.values), mode: 'stretch' } : { ...FIXED_SCALE };
  const changed = next.min !== state.scale.min || next.max !== state.scale.max || next.mode !== state.scale.mode;
  state.scale = next;
  return changed;
}

function updateScale(dataChanged = false) {
  if (computeScale() || dataChanged) renderOverlay();
  renderHistogram();
  renderLegend();
}

/* ───────────── Visible statistics ───────────── */

// Pixels whose centres fall inside the on-screen footprint (a trapezoid when the map is tilted).
function computeVisible() {
  const data = state.data;
  if (!data || !state.ready) { state.visible = { values: [], stats: statistics([]) }; return; }
  const { clientWidth: width, clientHeight: height } = state.map.getContainer();
  const quad = [[0, 0], [width, 0], [width, height], [0, height]].map(p => {
    const { lng, lat } = state.map.unproject(p);
    return [lng, mercatorY(Math.max(-85, Math.min(85, lat)))];
  });
  const [w, s, e, n] = data.bbox, top = mercatorY(n), bottom = mercatorY(s), values = [];
  for (let y = 0; y < data.height; y++) {
    const py = top - (y + 0.5) / data.height * (top - bottom);
    for (let x = 0; x < data.width; x++) {
      const px = w + (x + 0.5) / data.width * (e - w);
      let inside = false;
      for (let i = 0, j = 3; i < 4; j = i++) {
        const [xi, yi] = quad[i], [xj, yj] = quad[j];
        if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) values.push(data.values[y * data.width + x]);
    }
  }
  state.visible = { values, stats: statistics(values) };
}

function renderStats() {
  const { stats } = state.visible;
  const has = stats.count > 0;
  $('mean').textContent = has ? celsius(stats.mean) : '—';
  $('compact-mean').textContent = $('mean').textContent;
  $('min').textContent = has ? celsius(stats.min) : '—';
  $('max').textContent = has ? celsius(stats.max) : '—';
  document.body.classList.remove('stats-stale');
}

/* ───────────── Observation loading ───────────── */

const mosaics = []; // good results only (some scenes, no failures), newest last
let controller = null, timer = null, revision = 0;

function viewBounds() {
  const b = state.map.getBounds();
  return [Math.max(-180, b.getWest()), Math.max(-85, b.getSouth()), Math.min(180, b.getEast()), Math.min(85, b.getNorth())];
}

// Re-use a mosaic that already covers the whole view at an adequate resolution, so small
// pans, zooming in, panel toggles and resizes need no network request.
function reusableMosaic(bounds, date) {
  const wanted = frameFor(bounds).metersPerPixel;
  return mosaics
    .filter(m => m.date === date && containsBounds(m.bbox, bounds) && m.metersPerPixel <= Math.max(wanted * 1.6, 45))
    .sort((a, b) => a.metersPerPixel - b.metersPerPixel)[0] || null;
}

function remember(mosaic) {
  const index = mosaics.indexOf(mosaic);
  if (index >= 0) mosaics.splice(index, 1);
  mosaics.push(mosaic);
  if (mosaics.length > 6) mosaics.shift();
}

function showMosaic(mosaic) {
  const changed = state.data !== mosaic;
  state.data = mosaic;
  computeVisible();
  renderStats();
  updateScale(changed);
  renderSources();
  renderQuality();
  updateSelection();
  if (state.materialTarget) updateMaterial();
}

function clearMosaic() {
  revision++; controller?.abort(); clearTimeout(timer);
  state.data = null;
  state.visible = { values: [], stats: statistics([]) };
  applyOpacity();
  renderStats();
  updateScale();
  renderSources();
  renderQuality();
  updateSelection();
}

function schedule(delay = 450) { clearTimeout(timer); timer = setTimeout(refresh, delay); }

async function refresh() {
  if (!state.ready || state.map.isMoving()) return;
  const current = ++revision;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  if (state.map.getZoom() < MIN_ANALYSIS_ZOOM) {
    computeVisible(); renderStats(); updateScale();
    setStatus('지역을 확대하면 현재 화면을 자동으로 분석합니다.');
    return;
  }
  const date = $('scene').value, bounds = viewBounds();
  let reuse;
  try { reuse = reusableMosaic(bounds, date); } catch (error) { setStatus(error.message, 'warn'); return; }
  if (reuse) {
    remember(reuse);
    showMosaic(reuse);
    setStatus(state.visible.stats.count ? '' : '이 화면에서는 유효한 관측이 없습니다. 기준일을 바꾸거나 지도를 옮겨 보세요.', 'warn');
    return;
  }
  setStatus('현재 화면 위성 자료를 불러오는 중…', 'loading');
  try {
    const frame = frameFor(bounds, { padding: FRAME_PADDING });
    const mosaic = await loadViewport(frame, date, signal, message => { if (current === revision) setStatus(message, 'loading'); });
    if (signal.aborted || current !== revision) return;
    if (mosaic.sources.length && !mosaic.failedScenes) remember(mosaic);
    showMosaic(mosaic);
    setStatus(state.visible.stats.count ? '' : '이 화면에서는 유효한 관측이 없습니다. 기준일을 바꾸거나 지도를 옮겨 보세요.', 'warn');
  } catch (error) {
    if (signal.aborted || current !== revision) return;
    console.error(error);
    // Keep the previous mosaic, but describe only the part of it that is still on screen.
    computeVisible(); renderStats(); updateScale(); renderQuality();
    setStatus(error.message || '위성 자료 연결 실패', 'error', () => refresh());
  }
}

function renderSources() {
  const data = state.data, sources = data?.sources || [];
  const dates = [...new Set(sources.map(dayOf))].sort();
  const text = !data ? '촬영 자료 검색 대기' : dates.length === 1 ? `실제 촬영 ${dates[0]}` : dates.length ? `촬영 ${dates[0]} ~ ${dates.at(-1)}` : '유효한 촬영 자료 없음';
  $('acquisition').textContent = text;
  $('compact-date').textContent = text;
  $('used-scenes').replaceChildren(...sources.map(source => {
    const a = Object.assign(document.createElement('a'), { href: source.url, target: '_blank', rel: 'noopener' });
    a.textContent = `${dayOf(source)} · ${source.platform.replace('landsat-', 'Landsat ')} · 장면 구름 ${Math.round(source.cloudCover ?? 0)}% ↗`;
    return a;
  }));
}

function renderQuality() {
  const data = state.data, { stats } = state.visible, notes = [];
  if (!data) {
    $('coverage').textContent = '—';
    $('scene-count').textContent = '—';
  } else {
    const percent = stats.total ? Math.floor(stats.count / stats.total * 1000) / 10 : 0;
    $('coverage').textContent = `${number(percent)}%`;
    $('coverage').title = `현재 화면 ${stats.total.toLocaleString('ko-KR')}화소 중 ${stats.count.toLocaleString('ko-KR')}화소 유효`;
    const dates = [...new Set(data.sources.map(dayOf))].sort();
    $('scene-count').textContent = data.sources.length ? `${data.sources.length}개 장면` : '없음';
    if (!data.candidateCount) notes.push(['warn', `기준일 ±${SEARCH_DAYS}일 안에 구름 80% 미만 장면이 없습니다.`]);
    if (dates.length > 1) notes.push(['info', `서로 ${daysBetween(dates[0], dates.at(-1))}일 떨어진 장면을 합쳤습니다. 화소마다 촬영일이 다릅니다.`]);
    const offset = dates.length ? Math.max(...dates.map(d => daysBetween(d, data.date))) : 0;
    if (offset > 7) notes.push(['info', `기준일과 실제 촬영일이 최대 ${offset}일 차이 납니다.`]);
    if (data.failedScenes) notes.push(['warn', `장면 ${data.failedScenes}개를 받지 못해 제외했습니다.`]);
    if (data.partialSearch) notes.push(['warn', '검색된 장면이 100개를 넘어 일부만 비교했습니다.']);
    if (stats.total && stats.count / stats.total < 0.6) notes.push(['warn', '구름·품질 마스크로 화면의 40% 이상이 비어 있습니다.']);
  }
  $('quality-notes').replaceChildren(...notes.map(([tone, text]) => Object.assign(document.createElement('li'), { className: tone, textContent: text })));
  renderBuildingCoverage();
}

/* ───────────── Selection ───────────── */

function selectedObservation(point = state.selected) {
  if (!point || !state.data) return { value: null, index: null, source: null };
  const hit = observationAt(state.data, state.data, point.lng, point.lat);
  return { ...hit, source: hit.index !== null ? state.data.sources[state.data.origins[hit.index]] || null : null };
}

function updateSelection() {
  const point = state.selected;
  if (!point) { renderHistogram(); materialObservation(); return; }
  const { building } = point, hit = selectedObservation();
  $('place').textContent = building?.name || (building ? '선택한 건물' : '선택한 지점');
  $('temperature').textContent = state.data ? celsius(hit.value) : '—';
  $('value-label').textContent = !state.data ? '위성 자료 대기 중' : hit.source ? `위성 지표면 온도 · 촬영 ${dayOf(hit.source)}` : hit.index === null ? '현재 분석 범위 밖' : '이 화소는 구름·결측';
  $('compact-place').textContent = $('place').textContent;
  $('compact-temperature').textContent = $('temperature').textContent;
  $('height').textContent = building ? (Number.isFinite(building.height) ? `${number(building.height, building.height % 1 ? 1 : 0)} m` : '높이 미등록') : '건물 아님';
  $('coordinates').textContent = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  $('building-source').hidden = !building;
  if (building) $('building-source').href = building.sourceURL;
  document.body.classList.add('has-selection');
  renderHistogram();
  materialObservation();
}

/* ───────────── Buildings ───────────── */

const buildingCache = new Map();
let buildingController, buildingTimer, buildingRevision = 0, lastBuildingRequest = 0;

function buildingStatus(text, retry = false) {
  const el = $('building-status');
  el.replaceChildren(document.createTextNode(text));
  el.hidden = !text;
  if (retry) {
    const button = Object.assign(document.createElement('button'), { type: 'button', textContent: '재시도' });
    button.onclick = scheduleBuildings;
    el.append(button);
  }
}

function renderBuildingCoverage() {
  const el = $('building-coverage'), { total, withHeight } = state.buildings.coverage || {};
  if (state.buildingState === 'zoom') el.textContent = `줌 ${MIN_BUILDING_ZOOM} 이상에서 조회`;
  else if (state.buildingState === 'loading') el.textContent = '조회 중…';
  else if (state.buildingState === 'error') el.textContent = '조회 실패';
  else if (Number.isFinite(total)) el.textContent = `${withHeight.toLocaleString('ko-KR')} / ${total.toLocaleString('ko-KR')}채 (${total ? number(withHeight / total * 100, 0) : 0}%)`;
  else el.textContent = '—';
}

function cancelBuildings() { buildingRevision++; buildingController?.abort(); clearTimeout(buildingTimer); }

function scheduleBuildings() {
  cancelBuildings();
  buildingTimer = setTimeout(refreshBuildings, Math.max(900, 4500 - (Date.now() - lastBuildingRequest)));
}

async function refreshBuildings() {
  if (!state.ready || state.map.isMoving()) return;
  const current = buildingRevision, bounds = buildingBounds(viewBounds());
  if (state.map.getZoom() < MIN_BUILDING_ZOOM || !bounds) {
    state.buildingState = 'zoom';
    buildingStatus('3D 건물은 더 확대하면 표시됩니다');
    renderBuildingCoverage();
    return;
  }
  buildingController = new AbortController();
  const signal = buildingController.signal, key = bounds.map(x => x.toFixed(5)).join(',');
  state.buildingState = 'loading';
  buildingStatus('등록된 건물 높이 불러오는 중…');
  renderBuildingCoverage();
  try {
    let result = buildingCache.get(key);
    if (!result) { lastBuildingRequest = Date.now(); result = await fetchBuildings(bounds, signal); }
    if (signal.aborted || current !== buildingRevision) return;
    state.buildings = result;
    state.buildingState = 'ready';
    buildingCache.set(key, result);
    if (buildingCache.size > 8) buildingCache.delete(buildingCache.keys().next().value);
    state.map.getSource('recorded-buildings').setData(result);
    const { total, withHeight } = result.coverage;
    buildingStatus(result.features.length
      ? `3D 건물 ${withHeight.toLocaleString('ko-KR')}${Number.isFinite(total) ? ` / ${total.toLocaleString('ko-KR')}채` : '채'}`
      : '이 화면에는 높이가 등록된 건물이 없습니다');
    $('building-provenance').textContent = `현재 화면의 OSM 건물 ${Number.isFinite(total) ? `${total.toLocaleString('ko-KR')}채 중 ` : ''}height 태그가 있는 ${withHeight.toLocaleString('ko-KR')}채(건물 부분 포함 3D 형상 ${result.features.length.toLocaleString('ko-KR')}개)를 표시합니다. 원자료 기준 ${result.source.timestamp?.slice(0, 10) || '확인 불가'} · ${new URL(result.source.url).host}.`;
    renderBuildingCoverage();
  } catch (error) {
    if (signal.aborted || current !== buildingRevision) return;
    console.error(error);
    state.buildingState = 'error';
    buildingStatus(error.rateLimited ? '건물 서버 혼잡' : '건물 자료 연결 실패', true);
    $('building-provenance').textContent = '현재 화면의 건물 조회가 실패했습니다. 지도에 이미 표시된 건물은 앞서 조회한 실제 자료입니다.';
    renderBuildingCoverage();
  }
}

/* ───────────── Material experiment ───────────── */

function setMaterialChoices(kind) {
  if (state.materialKind === kind && $('material-base').options.length) return;
  state.materialKind = kind;
  for (const id of ['material-base', 'material-next']) $(id).replaceChildren(...MATERIAL_CHOICES[kind].map(m => new Option(m.name, m.key)));
  $('material-base').value = kind === 'roof' ? 'blackRoof' : 'asphalt';
  $('material-next').value = kind === 'roof' ? 'whitePaint' : 'coolPave';
  $('material-radius').closest('.material-radius').hidden = kind === 'roof';
}

function materialConditions() {
  return state.weather?.values || ASSUMED_CONDITIONS;
}

function renderConditions() {
  const c = materialConditions(), weather = state.weather;
  $('conditions-source').textContent = weather?.values ? `${weather.values.label} · ${weather.values.time.slice(0, 16).replace('T', ' ')} UTC`
    : weather?.loading ? '촬영 시각 기상 불러오는 중… (임시로 가정값 사용)'
    : weather?.failed ? '기상 자료 없음 · 가정값 사용'
    : '가정값 (선택 지점에 위성 관측이 없을 때)';
  $('cond-sun').textContent = `${number(c.sunlight, 0)} W/m²`;
  $('cond-air').textContent = celsius(c.airTemperature);
  $('cond-humidity').textContent = `${number(c.humidity, 0)}%`;
  $('cond-wind').textContent = `${number(c.wind)} m/s`;
  $('cond-moisture').textContent = `${number((c.moisture ?? ASSUMED_CONDITIONS.moisture) * 100, 0)}% (가정)`;
}

async function loadWeather() {
  const hit = selectedObservation(state.materialTarget), target = state.materialTarget;
  if (!target || !hit.source) { state.weather = null; state.weatherKey = null; return; }
  const key = `${target.lat.toFixed(2)},${target.lng.toFixed(2)},${hit.source.datetime}`;
  if (state.weatherKey === key) return;
  state.weatherKey = key;
  state.weather = { loading: true };
  try {
    const values = await fetchWeather(target.lng, target.lat, hit.source.datetime, AbortSignal.timeout(20000));
    if (state.weatherKey !== key) return;
    state.weather = values ? { values: { ...values, moisture: ASSUMED_CONDITIONS.moisture } } : { failed: true };
  } catch {
    if (state.weatherKey === key) state.weather = { failed: true };
  }
  updateMaterial(false);
}

function materialObservation() {
  const target = state.materialTarget;
  if (!target) { $('material-observed').textContent = '위치를 선택해 주세요'; return; }
  const hit = selectedObservation(target);
  $('material-observed').textContent = Number.isFinite(hit.value) ? `${celsius(hit.value)} · ${hit.source ? dayOf(hit.source) : '촬영일 확인 중'}` : '자료 없음';
}

function materialPatch() {
  const source = state.ready && state.map.getSource('material-placement');
  if (!source) return;
  const material = MATERIAL[$('material-next').value], target = state.materialTarget;
  const geometry = target?.feature?.geometry || (target ? circleAt([target.lng, target.lat], +$('material-radius').value) : null);
  const roofHeight = target?.building?.height || 0;
  source.setData({ type: 'FeatureCollection', features: geometry ? [{ type: 'Feature', properties: { surface: state.materialKind, color: material.color, height: roofHeight + 0.4, base: roofHeight }, geometry }] : [] });
}

function updateMaterial(fetchConditions = true) {
  const base = MATERIAL[$('material-base').value], next = MATERIAL[$('material-next').value], target = state.materialTarget;
  document.body.classList.toggle('has-material-target', Boolean(target));
  if (!target || !base || !next) {
    for (const id of ['material-change', 'material-before', 'material-after', 'model-before', 'model-after', 'model-change', 'model-residual', 'model-at-observation']) $(id).textContent = '—';
    $('model-change').className = '';
  } else {
    if (fetchConditions) loadWeather();
    const c = materialConditions();
    const energy = materialEnergy(base, next, c.sunlight, c.moisture);
    const temperature = materialTemperature(base, next, c);
    $('material-change').textContent = signed(energy.change, ' W/m²', 0);
    $('material-before').textContent = `${number(energy.before, 0)} W/m²`;
    $('material-after').textContent = `${number(energy.after, 0)} W/m²`;
    $('model-before').textContent = celsius(temperature.before);
    $('model-after').textContent = celsius(temperature.after);
    $('model-change').textContent = signed(temperature.change, '°C');
    $('model-change').className = temperature.change < -0.05 ? 'cooler' : temperature.change > 0.05 ? 'warmer' : '';
    const hit = selectedObservation(target), comparable = Number.isFinite(hit.value) && state.weather?.values;
    $('model-at-observation').textContent = comparable ? celsius(temperature.before) : '—';
    $('model-residual').textContent = comparable ? signed(temperature.before - hit.value, '°C') : state.weather?.loading ? '기상 자료 대기' : '비교 불가';
  }
  renderConditions();
  materialObservation();
  materialPatch();
}

function placeMaterial(point) {
  state.materialTarget = point;
  state.materialCleared = false;
  setMaterialChoices(point.building ? 'roof' : 'ground');
  $('material-place').textContent = point.building?.name || (point.building ? '선택한 건물 지붕' : '선택한 지면');
  $('material-kind').textContent = point.building ? '높이 등록 건물의 지붕 형상에 적용' : '선택 위치 주위 원형 면적에 적용';
  updateMaterial();
}

/* ───────────── Wiring ───────────── */

function wireControls() {
  const dialog = $('sources');
  $('sources-open').onclick = () => dialog.showModal();
  $('sources-close').onclick = () => dialog.close();
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  $('panel-toggle').onclick = () => setPanel(document.body.classList.contains('panel-collapsed'));
  $('compact-open').onclick = () => setPanel(true);
  $('mode-observe').onclick = () => setMaterialMode(false);
  $('material-toggle').onclick = () => setMaterialMode(!state.materialMode);
  $('material-from-observation').onclick = () => setMaterialMode(true);
  $('scale-fixed').onclick = () => setScaleMode('fixed');
  $('scale-stretch').onclick = () => setScaleMode('stretch');
  $('thermal').onchange = applyOpacity;
  $('opacity').oninput = () => {
    state.opacity = $('opacity').value / 100;
    $('opacity-value').textContent = `${$('opacity').value}%`;
    applyOpacity();
  };
  $('material-base').onchange = () => updateMaterial(false);
  $('material-next').onchange = () => updateMaterial(false);
  $('material-radius').oninput = () => { $('material-radius-value').textContent = `${$('material-radius').value} m`; materialPatch(); };
  $('material-reset').onclick = () => {
    state.materialTarget = null; state.materialCleared = true; state.weather = null; state.weatherKey = null;
    $('material-place').textContent = '지도를 눌러 위치 선택';
    $('material-kind').textContent = '한 번에 한 위치 · 다시 누르면 변경';
    updateMaterial(false);
  };
  // Histogram hover: one tooltip, positioned over the hovered bar.
  const tip = $('histogram-tip');
  $('histogram').addEventListener('pointermove', event => {
    const bar = event.target.closest('.bar');
    if (!bar) { tip.hidden = true; return; }
    const root = $('histogram').getBoundingClientRect(), r = bar.getBoundingClientRect();
    tip.textContent = bar.dataset.tip;
    tip.hidden = false;
    tip.style.left = `${Math.min(root.width - tip.offsetWidth / 2, Math.max(tip.offsetWidth / 2, r.left - root.left + r.width / 2))}px`;
  });
  $('histogram').addEventListener('pointerleave', () => { tip.hidden = true; });
  setMaterialChoices('ground');
  updateMaterial(false);
  renderLegend();
  renderHistogram();
}

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function readJSON(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) throw Error(`${url}: ${response.status}`);
  return response.json();
}

function addLayers(map) {
  const firstLabel = map.getStyle().layers.find(x => x.type === 'symbol')?.id;
  map.addSource('observed-temperature', { type: 'image', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
  map.addLayer({ id: 'temperature', type: 'raster', source: 'observed-temperature', paint: { 'raster-opacity': 0, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 } }, firstLabel);
  map.addSource('recorded-buildings', { type: 'geojson', data: state.buildings });
  map.addLayer({ id: 'building-footprints', type: 'fill', source: 'recorded-buildings', paint: { 'fill-color': '#8fa39a', 'fill-opacity': 0.22, 'fill-outline-color': '#6f857b' } }, firstLabel);
  map.addLayer({ id: 'recorded-heights', type: 'fill-extrusion', source: 'recorded-buildings', minzoom: MIN_BUILDING_ZOOM, filter: ['>', ['coalesce', ['get', 'height'], 0], 0], paint: { 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-color': '#e9e4da', 'fill-extrusion-opacity': 0.9, 'fill-extrusion-vertical-gradient': true } }, firstLabel);
  map.addSource('material-placement', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'material-ground', type: 'fill', source: 'material-placement', filter: ['==', ['get', 'surface'], 'ground'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.8 } }, firstLabel);
  map.addLayer({ id: 'material-roof', type: 'fill-extrusion', source: 'material-placement', filter: ['==', ['get', 'surface'], 'roof'], paint: { 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-color': ['get', 'color'], 'fill-extrusion-opacity': 0.95 } }, firstLabel);
  map.addLayer({ id: 'material-boundary', type: 'line', source: 'material-placement', filter: ['==', ['get', 'surface'], 'ground'], paint: { 'line-color': '#1d5c4d', 'line-width': 2.5, 'line-dasharray': [2, 1] } }, firstLabel);
  for (const id of ['material-ground', 'material-roof', 'material-boundary']) map.setLayoutProperty(id, 'visibility', state.materialMode ? 'visible' : 'none');
  map.setLight({ anchor: 'viewport', position: [1.5, 210, 40], color: '#fff8ec', intensity: 0.35 });
}

function onMapClick(event) {
  const map = state.map;
  const hit = map.queryRenderedFeatures(event.point, { layers: ['recorded-heights', 'building-footprints'] })[0];
  const original = hit && state.buildings.features.find(f => f.properties.osmId === hit.properties.osmId && f.properties.osmType === hit.properties.osmType);
  const point = original ? footprintPoint(original.geometry) : [event.lngLat.lng, event.lngLat.lat];
  state.selected = { lng: point[0], lat: point[1], building: original?.properties, feature: original };
  state.materialCleared = false;
  state.marker?.remove();
  state.marker = new globalThis.maplibregl.Marker({ color: '#1d3b33', scale: 0.62 }).setLngLat(point).addTo(map);
  updateSelection();
  if (state.materialMode) placeMaterial(state.selected);
}

async function init() {
  wireControls();
  if (mobile.matches) setPanel(false);
  mobile.addEventListener('change', event => setPanel(!event.matches));
  const [style] = await Promise.all([readJSON('https://tiles.openfreemap.org/styles/positron'), import('./vendor/maplibre-gl.js')]);
  const day = today();
  $('scene').max = day; $('scene').value = day; $('scene').disabled = false;
  $('scene').onchange = () => {
    if (!$('scene').value || $('scene').value > day) $('scene').value = day;
    clearMosaic();
    schedule(0);
  };
  style.layers = style.layers.filter(layer => layer.type !== 'fill-extrusion');
  for (const layer of style.layers) {
    if (layer.type === 'symbol' && JSON.stringify(layer.layout?.['text-field'] || '').includes('"name')) layer.layout['text-field'] = ['coalesce', ['get', 'name:ko'], ['get', 'name'], ['get', 'name_en']];
  }
  const map = state.map = new globalThis.maplibregl.Map({
    container: 'map', style, hash: true, ...HOME, maxPitch: 65, maxZoom: 19, minZoom: 3, renderWorldCopies: false, attributionControl: false,
    locale: { 'NavigationControl.ZoomIn': '확대', 'NavigationControl.ZoomOut': '축소', 'NavigationControl.ResetBearing': '북쪽으로 회전', 'AttributionControl.ToggleAttribution': '지도 출처' },
  });
  map.addControl(new globalThis.maplibregl.AttributionControl({ compact: true }), 'bottom-right');
  map.addControl(new globalThis.maplibregl.ScaleControl({ maxWidth: 90, unit: 'metric' }), 'bottom-right');
  new ResizeObserver(() => map.resize()).observe($('map'));
  setupFullscreen($('fullscreen'), () => map.resize());
  map.getCanvas().setAttribute('aria-label', '위성 지표면 온도 지도. 방향키로 이동하고 +, - 키로 확대 또는 축소할 수 있습니다.');
  const syncView = () => {
    const tilted = map.getPitch() > 5;
    $('view3d').setAttribute('aria-pressed', String(tilted));
    $('view2d').setAttribute('aria-pressed', String(!tilted));
  };
  $('view3d').onclick = () => map.easeTo({ pitch: 55, bearing: -24, duration: 650 });
  $('view2d').onclick = () => map.easeTo({ pitch: 0, bearing: 0, duration: 650 });
  $('zoom-in').onclick = () => map.zoomIn({ duration: 350 });
  $('zoom-out').onclick = () => map.zoomOut({ duration: 350 });
  $('home').onclick = () => map.flyTo({ ...HOME, duration: 900 });
  map.on('pitchend', syncView);
  syncView();
  const dismissHint = () => document.body.classList.add('hint-dismissed');
  for (const type of ['mousedown', 'touchstart', 'wheel']) map.getCanvasContainer().addEventListener(type, dismissHint, { once: true, passive: true });
  map.once('load', () => {
    addLayers(map);
    state.ready = true;
    materialPatch();
    // Keep the current raster on screen while moving: it is georeferenced, so it stays correct.
    map.on('movestart', () => { clearTimeout(timer); controller?.abort(); document.body.classList.add('stats-stale'); cancelBuildings(); });
    map.on('moveend', () => { schedule(); scheduleBuildings(); });
    map.on('click', onMapClick);
    map.on('mousemove', event => {
      map.getCanvas().style.cursor = map.queryRenderedFeatures(event.point, { layers: ['recorded-heights', 'building-footprints'] }).length ? 'pointer' : '';
    });
    refresh();
    scheduleBuildings();
  });
}

init().catch(error => {
  console.error(error);
  setStatus('지도를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.', 'error', () => location.reload());
});
