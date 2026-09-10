import { byId } from './materials.js';
import { GRID_W, CELL_COUNT } from './engine.js';
import { selectMetric, SCENARIOS } from './atlas-data.js';
import { boundsPolygon, cellBounds, cellCenter, cellAt, heatFeatures, hubFeatures, emptyCollection, footprintPoint } from './map-data.js';

const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const BASE_HEIGHT = ['case', ['>', ['coalesce', ['get', 'render_height'], 0], 0], ['to-number', ['get', 'render_height']], 6];

export class CityScene3D {
  constructor(canvas, options) {
    Object.assign(this, options);
    this.canvas = canvas;
    this.bbox = this.city.dataset.bbox;
    this.selected = null;
    this.atmosphere = 'day';
    this.auto = false;
    this.flat = false;
    this.ready = false;
    this.disposed = false;
    this.layers = { buildings: true, heat: false, hubs: true };
    this.selection = () => selectMetric({ city: this.city, history: this.history, state: this.getState(), metricName: this.metricSelect.value, scenario: this.scenarioSelect.value, sceneIndex: this.sceneSelect.value });
    this.container = document.createElement('div');
    this.container.id = 'real-map';
    this.container.setAttribute('aria-label', '실제 구월동 도로·공원·건물 지도');
    canvas.hidden = true;
    canvas.parentElement.append(this.container);
    this.message = document.createElement('div');
    this.message.className = 'map-load-message';
    this.message.setAttribute('role', 'status');
    canvas.parentElement.append(this.message);
    for (const control of [this.metricSelect, this.scenarioSelect, this.sceneSelect, this.exaggerationInput]) control.addEventListener('input', () => this.render());
    this.metricSelect.addEventListener('input', () => {
      this.setLayerVisibility('heat', true);
      if ($('show-heat')) $('show-heat').checked = true;
    });
    this.loadMap();
  }

  async loadMap() {
    clearTimeout(this.loadTimer);
    this.ready = false;
    this.tileLoaded = false;
    this.message.hidden = false;
    this.message.textContent = '실제 도로와 건물 지도를 불러오고 있습니다…';
    try {
      await import('./vendor/maplibre-gl.js');
      if (this.disposed) return;
      const lib = globalThis.maplibregl;
      if (!lib?.Map) throw Error('Map library unavailable');
      this.map?.remove();
      this.container.replaceChildren();
      this.map = new lib.Map({
        container: this.container,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [this.city.dataset.center[1], this.city.dataset.center[0]],
        zoom: 15.7, pitch: 60, bearing: -24,
        minZoom: 11, maxZoom: 19.5, maxPitch: 75,
        attributionControl: false,
        maxBounds: [[126.64, 37.39], [126.79, 37.51]],
      });
      this.webglCanvas = this.map.getCanvas();
      this.webglCanvas.setAttribute('aria-label', '구월동 실제 3D 지도. 드래그 이동, 오른쪽 드래그 회전, 휠 확대. 지도나 건물을 클릭하여 열 분석 확인.');
      this.map.addControl(new lib.AttributionControl({ compact: true }), 'bottom-left');
      this.map.addControl(new lib.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-right');
      this.map.touchZoomRotate.enableRotation();
      this.map.on('load', () => {
        this.setupLayers();
        this.ready = true;
        this.render();
        this.select(this.selected, this.selectedCoordinate);
        this.resize();
        if ($('render-mode')) $('render-mode').textContent = '실제 지도 · 3D';
        document.dispatchEvent(new Event('atlas-renderer-ready'));
      });
      this.map.on('sourcedata', event => {
        if (event.sourceId === 'openmaptiles' && event.sourceDataType === 'content') {
          this.tileLoaded = true;
          this.message.hidden = true;
          clearTimeout(this.loadTimer);
        }
      });
      this.map.on('error', event => {
        this.lastError = event.error;
        if (!this.map.isStyleLoaded() && !this.ready && !event.sourceId) this.showLoadError();
      });
      this.map.on('click', event => {
        if (!this.ready) return;
        const features = this.layers.buildings ? this.map.queryRenderedFeatures(event.point, { layers: ['building-3d'] }) : [];
        this.selectedBuilding = features[0] || null;
        const coordinate = footprintPoint(this.selectedBuilding?.geometry) || [event.lngLat.lng, event.lngLat.lat];
        this.select(cellAt(...coordinate, this.bbox), coordinate);
      });
      this.map.on('dragstart', () => this.setAuto(false));
      this.map.on('zoomstart', event => { if (event.originalEvent) this.setAuto(false); });
      this.map.on('rotate', () => {
        const needle = document.querySelector('.map-coordinate');
        if (needle) needle.style.transform = `rotate(${-this.map.getBearing()}deg)`;
      });
      this.webglCanvas.addEventListener('keydown', event => {
        if (event.key === '[' || event.key === ']') {
          event.preventDefault();
          this.selectedBuilding = null;
          this.select(Math.max(0, Math.min(CELL_COUNT - 1, (this.selected ?? 217) + (event.key === '[' ? -1 : 1))));
        }
      });
      this.observer?.disconnect();
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.container);
      this.loadTimer = setTimeout(() => { if (!this.tileLoaded) this.showLoadError(); }, 20000);
    } catch {
      this.ready = false;
      this.webglCanvas = null;
      this.showLoadError(true);
    }
  }

  showLoadError(noWebGL = false) {
    this.message.hidden = false;
    this.message.replaceChildren();
    const text = document.createElement('p');
    text.textContent = noWebGL ? '3D 지도를 시작하지 못했습니다. WebGL 지원과 네트워크 연결을 확인하세요.' : '지도 데이터를 불러오지 못했습니다. 네트워크 연결을 확인하고 다시 시도하세요.';
    const retry = document.createElement('button');
    retry.textContent = '지도 다시 불러오기';
    retry.onclick = () => { this.setAuto(false); this.loadMap(); };
    const link = document.createElement('a');
    link.href = 'https://www.openstreetmap.org/#map=16/37.44739/126.70629';
    link.target = '_blank'; link.rel = 'noopener'; link.textContent = 'OpenStreetMap에서 보기 ↗';
    this.message.append(text, retry, link);
  }

  setupLayers() {
    const map = this.map;
    this.originalLayers = new Map(map.getStyle().layers.map(layer => [layer.id, JSON.parse(JSON.stringify(layer))]));
    for (const layer of map.getStyle().layers) {
      const field = layer.layout?.['text-field'];
      if (field && JSON.stringify(field).includes('name')) map.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:ko'], ['get', 'name'], ['get', 'name:en']]);
    }
    if (!map.getLayer('building-3d')) {
      const labels = map.getStyle().layers.find(layer => layer.type === 'symbol')?.id;
      map.addLayer({ id: 'building-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 14 }, labels);
    }
    map.setFilter('building-3d', ['!=', ['get', 'hide_3d'], true]);
    map.setPaintProperty('building-3d', 'fill-extrusion-opacity', .96);
    map.setPaintProperty('building-3d', 'fill-extrusion-vertical-gradient', true);
    map.addSource('analysis-heat', { type: 'geojson', data: emptyCollection() });
    map.addLayer({ id: 'analysis-heat', type: 'fill', source: 'analysis-heat', paint: { 'fill-color': ['get', 'color'], 'fill-opacity': .36 }, layout: { visibility: 'none' } }, 'building-3d');
    map.addSource('analysis-extent', { type: 'geojson', data: boundsPolygon(this.bbox) });
    map.addLayer({ id: 'analysis-extent', type: 'line', source: 'analysis-extent', paint: { 'line-color': '#b16c39', 'line-width': 1.4, 'line-dasharray': [4,4], 'line-opacity': .8 } });
    map.addSource('analysis-selected', { type: 'geojson', data: emptyCollection() });
    map.addLayer({ id: 'analysis-selected', type: 'line', source: 'analysis-selected', paint: { 'line-color': '#e16b21', 'line-width': 2.5 } });
    map.addSource('analysis-hubs', { type: 'geojson', data: emptyCollection() });
    map.addLayer({ id: 'analysis-hubs', type: 'circle', source: 'analysis-hubs', paint: { 'circle-radius': 7, 'circle-color': '#1e996c', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    this.applyAtmosphere();
  }

  metricValues() { return this.selection(); }

  render() {
    this.updateLegend();
    this.updateInspector();
    if (!this.ready) return;
    const data = this.selection(), state = this.getState();
    this.map.getSource('analysis-heat').setData(heatFeatures(this.bbox, data, this.city.insideBoundary));
    this.map.getSource('analysis-hubs').setData(hubFeatures(this.scenarioSelect.value === 'optimized' ? state.plan?.hubs || [] : [], this.bbox));
    const exag = +this.exaggerationInput.value;
    this.map.setPaintProperty('building-3d', 'fill-extrusion-height', ['*', BASE_HEIGHT, exag]);
    this.map.setPaintProperty('building-3d', 'fill-extrusion-base', ['*', ['coalesce', ['to-number', ['get', 'render_min_height']], 0], exag]);
    for (const name of ['buildings', 'heat', 'hubs']) this.setLayerVisibility(name, this.layers[name]);
  }

  updateLegend() {
    const d = this.selection(), el = $('atlas-legend');
    if (el) { el.hidden = !this.layers.heat; el.innerHTML = `<div><strong>${d.metric.label}</strong><span>${d.metric.kind === 'simulation' ? '모의 결과' : '위성 관측'}</span></div><div class="thermal-ramp" style="background:linear-gradient(90deg,${d.palette.join(',')})"></div><div><span>${d.min.toFixed(1)} ${d.metric.unit}</span><span>${d.max.toFixed(1)} ${d.metric.unit}</span></div>`; }
    if ($('metric-description')) $('metric-description').textContent = d.metric.description;
    this.sceneSelect.disabled = this.metricSelect.value !== 'scene';
  }

  select(index, coordinate) {
    this.selected = index;
    this.selectedCoordinate = coordinate || (index == null ? null : cellCenter(index, this.bbox));
    if (this.ready) this.map.getSource('analysis-selected').setData(index == null ? emptyCollection() : boundsPolygon(cellBounds(index, this.bbox)));
    this.updateInspector();
  }

  updateInspector() {
    const el = $('cell-inspector'), state = this.getState(), i = this.selected, building = this.selectedBuilding;
    const name = building ? building.properties?.['name:ko'] || building.properties?.name || '선택한 실제 건물' : '선택 위치';
    if (i == null) {
      this.detailElement.textContent = this.selectedCoordinate ? `${this.selectedCoordinate[1].toFixed(5)}° N · ${this.selectedCoordinate[0].toFixed(5)}° E · 분석 범위 밖: 열 자료 없음` : '실제 건물이나 지도를 클릭하면 해당 위치의 열 분석을 확인할 수 있습니다.';
      if (el) el.innerHTML = `<div class="inspector-top">실제 구월동 지도</div><h3 class="map-inspector-title">${this.selectedCoordinate ? escapeHtml(name) : '건물을 선택하세요'}</h3><p class="inspector-label">${this.selectedCoordinate ? '분석 범위 밖입니다. 이 위치의 열 결과는 제공하지 않습니다.' : '도로와 공원 사이에 놓인 실제 건물 윤곽을 3D로 탐색합니다.'}</p><p class="inspector-label">점선은 열 분석 범위입니다.<br>지도 클릭 · 드래그 이동<br>오른쪽 드래그 회전</p>`;
      return;
    }
    const types = this.scenarioSelect.value === 'optimized' ? state.optimizedTypes : this.scenarioSelect.value === 'material' ? state.materialTypes : this.city.types;
    const d = this.selection();
    this.detailElement.textContent = `${name} · 연결 분석 셀 ${i + 1} · ${SCENARIOS[this.scenarioSelect.value]} · ${byId(types[i]).name} · ${d.metric.label} ${d.values[i].toFixed(1)}${d.metric.unit} (약 108 × 167m 셀 값)`;
    if (!el || !state.latest) return;
    const h = state.hour, b = state.latest.base.hourly[h][i], m = state.latest.material.hourly[h][i], o = state.latest.opt.hourly[h][i];
    const height = Number(building?.properties?.render_height);
    el.innerHTML = `<div class="inspector-top">${escapeHtml(name)}<strong>${String(i + 1).padStart(3, '0')}</strong></div><div class="inspector-value">${d.values[i].toFixed(this.metricSelect.value === 'ndvi' || this.metricSelect.value === 'trend' ? 2 : 1)}<span>${d.metric.unit}</span></div><span class="inspector-label">${d.metric.label}<br>${d.metric.kind === 'simulation' ? `${SCENARIOS[this.scenarioSelect.value]} · ${h}시` : '위성 관측 · 시나리오 공통'}</span><dl><div><dt>${h}시 현재 모의온도</dt><dd>${b.toFixed(1)}°C</dd></div><div><dt>재료 변경 모의온도</dt><dd>${m.toFixed(1)}°C</dd></div><div><dt>AI − 현재 모의온도</dt><dd class="${o <= b ? 'cool-text' : 'warm-text'}">${o - b > 0 ? '+' : ''}${(o - b).toFixed(1)}°C</dd></div>${building ? `<div><dt>지도 건물 높이</dt><dd>${height > 0 ? `${height.toFixed(1)} m` : '추정 6 m'}</dd></div>` : ''}</dl><span class="inspector-label">건물별 측정값이 아닌<br>연결 분석 셀의 값입니다.</span>`;
  }

  setLayerVisibility(name, visible) {
    this.layers[name] = visible;
    if (this.ready) { const id = { buildings: 'building-3d', heat: 'analysis-heat', hubs: 'analysis-hubs' }[name]; if (id) this.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none'); }
    if (name === 'heat') this.updateLegend();
  }

  applyAtmosphere() {
    const night = this.atmosphere === 'night', sunset = this.atmosphere === 'sunset';
    for (const [id, layer] of this.originalLayers) {
      if (!this.map.getLayer(id) || id === 'building-3d') continue;
      if (layer.type === 'background') this.map.setPaintProperty(id, 'background-color', night ? '#142532' : sunset ? '#ede1d3' : layer.paint?.['background-color'] || '#f1f0eb');
      if (layer.type === 'fill' && layer.paint?.['fill-color']) {
        const source = layer['source-layer'];
        const color = source === 'water' ? '#1c4a62' : ['landcover','landuse','park'].includes(source) ? '#283f3b' : '#243744';
        this.map.setPaintProperty(id, 'fill-color', night ? color : layer.paint['fill-color']);
      }
      if (layer.type === 'line' && layer.paint?.['line-color']) this.map.setPaintProperty(id, 'line-color', night ? '#506276' : layer.paint['line-color']);
      if (layer.type === 'symbol' && layer.layout?.['text-field']) {
        this.map.setPaintProperty(id, 'text-color', night ? '#d2e4ed' : layer.paint?.['text-color'] || '#3b4b53');
        this.map.setPaintProperty(id, 'text-halo-color', night ? '#152937' : layer.paint?.['text-halo-color'] || '#ffffff');
      }
    }
    this.map.setPaintProperty('building-3d', 'fill-extrusion-color', night ? '#718c9e' : sunset ? '#d5b396' : '#c5cacc');
    this.map.setLight({ anchor: 'viewport', color: night ? '#83b6ff' : sunset ? '#ffb784' : '#ffffff', intensity: night ? .38 : .5, position: [1.5, 210, 35] });
  }

  setAtmosphere(mode) { if (!['day','sunset','night'].includes(mode)) return; this.atmosphere = mode; if (this.ready) this.applyAtmosphere(); }
  rotate(delta) { if (this.ready) { this.setAuto(false); this.map.easeTo({ bearing: this.map.getBearing() + delta * 180 / Math.PI, duration: this.duration() }); } }
  zoomBy(factor) { if (this.ready) this.map.easeTo({ zoom: Math.max(11, Math.min(19.5, this.map.getZoom() + Math.log2(factor))), duration: this.duration() }); }
  duration() { return matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 650; }
  reset() { if (!this.ready) return; this.setAuto(false); this.flat = false; this.map.easeTo({ center: [this.city.dataset.center[1], this.city.dataset.center[0]], zoom: 15.7, pitch: 60, bearing: -24, duration: this.duration() }); $('view-flat')?.setAttribute('aria-pressed', 'false'); }
  setFlat() { if (!this.ready) return; this.flat = !this.flat; this.setAuto(false); this.map.easeTo({ pitch: this.flat ? 0 : 60, duration: this.duration() }); $('view-flat')?.setAttribute('aria-pressed', String(this.flat)); }
  setAuto(on) {
    this.auto = on && this.ready && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    cancelAnimationFrame(this.frame);
    $('auto-tour')?.setAttribute('aria-pressed', String(this.auto));
    let previous = 0;
    const tick = time => { if (!this.auto || this.disposed) return; if (!document.hidden) this.map.jumpTo({ bearing: this.map.getBearing() + Math.min(50, previous ? time - previous : 0) * .003 }); previous = time; this.frame = requestAnimationFrame(tick); };
    if (this.auto) this.frame = requestAnimationFrame(tick);
  }
  focusHotspot() {
    const d = this.selection(); let index = 0;
    for (let i = 1; i < d.values.length; i++) if (d.values[i] > d.values[index]) index = i;
    this.selectedBuilding = null; this.select(index); this.setLayerVisibility('heat', true);
    if ($('show-heat')) $('show-heat').checked = true;
    if (this.ready) this.map.easeTo({ center: cellCenter(index, this.bbox), zoom: 16.7, pitch: 55, duration: this.duration() });
  }
  resize() { this.map?.resize(); }
  draw() { this.map?.triggerRepaint(); }
  dispose() { this.disposed = true; this.setAuto(false); clearTimeout(this.loadTimer); this.observer?.disconnect(); this.map?.remove(); }
}
