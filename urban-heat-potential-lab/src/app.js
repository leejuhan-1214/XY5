import { MATERIALS, byId } from "./materials.js";
import { GRID_W, GRID_H, CELL_COUNT, createCity, simulate, potentialField, fluxField, optimize, percentile, mean, pedestrianValues, exposure, tracerResidence, windVectorAt } from "./engine.js";

const $ = id => document.getElementById(id);
const controls = { hour: $("hour"), air: $("air"), solar: $("solar"), moisture: $("moisture"), budget: $("budget"), wind: $("wind"), objective: $("objective"), layer: $("layer"), particles: $("particles"), basemap: $("basemap"), mapOpacity: $("map-opacity") };
const canvases = { base: $("baseline-map"), opt: $("optimized-map"), chart: $("profile-chart") };
const city = createCity();
const baselineTypes = city.types;
let optimizedTypes = Uint8Array.from(baselineTypes), latest = null, plan = null, animation = 0, particles = [], runTimer = 0, basemapImage = null, basemapUrl = "";

const WIND_NAMES = { 0: "서풍", 45: "북서풍", 90: "북풍", 135: "북동풍", 180: "동풍", 225: "남동풍", 270: "남풍", 315: "남서풍" };
function settings() { return { peakAir: +controls.air.value, solar: +controls.solar.value, moisture: +controls.moisture.value / 100, budget: +controls.budget.value, windDeg: +controls.wind.value, objective: controls.objective.value }; }
function updateOutputs() {
  $("hour-output").textContent = `${String(controls.hour.value).padStart(2, "0")}시`;
  $("air-output").textContent = `${controls.air.value}°C`; $("solar-output").textContent = `${controls.solar.value} W/m²`;
  $("moisture-output").textContent = `${controls.moisture.value}%`; $("budget-output").textContent = `${controls.budget.value}%`;
  $("wind-output").textContent = WIND_NAMES[controls.wind.value];
  $("opacity-output").textContent = `${controls.mapOpacity.value}%`;
}

function setupCanvas(canvas) {
  const rect = canvas.parentElement?.getBoundingClientRect?.() || canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1), width = Math.max(280, Math.floor(rect.width)), height = Math.max(220, Math.floor(rect.height));
  if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) { canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(height * dpr); }
  const context = canvas.getContext("2d"); context.setTransform(dpr, 0, 0, dpr, 0, 0); return { context, width, height };
}
const hexToRgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const mix = (a, b, t) => { const x = hexToRgb(a), y = hexToRgb(b), q = Math.max(0, Math.min(1, t)); return `rgb(${Math.round(x[0] + (y[0] - x[0]) * q)},${Math.round(x[1] + (y[1] - x[1]) * q)},${Math.round(x[2] + (y[2] - x[2]) * q)})`; };
const scalarColor = (value, min, max) => { const q = (value - min) / Math.max(.1, max - min); return q < .33 ? mix("#386fae", "#56d8dd", q * 3) : q < .66 ? mix("#56d8dd", "#ffc75b", (q - .33) * 3) : mix("#ffc75b", "#ff645f", (q - .66) * 2.94); };

function drawRoadTexture(ctx, width, height, cw, ch) {
  ctx.save(); ctx.strokeStyle = "rgba(255,255,255,.045)"; ctx.lineWidth = .7;
  for (let x = 0; x <= GRID_W; x += 1) { ctx.beginPath(); ctx.moveTo(x * cw, 0); ctx.lineTo(x * cw, height); ctx.stroke(); }
  for (let y = 0; y <= GRID_H; y += 1) { ctx.beginPath(); ctx.moveTo(0, y * ch); ctx.lineTo(width, y * ch); ctx.stroke(); }
  ctx.restore();
}

function drawContours(ctx, field, min, max, cw, ch) {
  const levels = Array.from({ length: 7 }, (_, i) => min + (i + 1) * (max - min) / 8);
  ctx.save(); ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,255,255,.46)";
  for (const level of levels) for (let y = 0; y < GRID_H - 1; y += 1) for (let x = 0; x < GRID_W - 1; x += 1) {
    const a = field[y * GRID_W + x] >= level, b = field[y * GRID_W + x + 1] >= level, c = field[(y + 1) * GRID_W + x + 1] >= level, d = field[(y + 1) * GRID_W + x] >= level;
    const points = [];
    if (a !== b) points.push([(x + .5) * cw, y * ch]); if (b !== c) points.push([(x + 1) * cw, (y + .5) * ch]);
    if (c !== d) points.push([(x + .5) * cw, (y + 1) * ch]); if (d !== a) points.push([x * cw, (y + .5) * ch]);
    if (points.length >= 2) { ctx.beginPath(); ctx.moveTo(...points[0]); ctx.lineTo(...points[1]); ctx.stroke(); }
  }
  ctx.restore();
}

function drawFlux(ctx, flux, cw, ch) {
  ctx.save(); ctx.strokeStyle = "rgba(240,252,255,.56)"; ctx.fillStyle = "rgba(240,252,255,.72)"; ctx.lineWidth = 1;
  for (let y = 1; y < GRID_H; y += 3) for (let x = 1; x < GRID_W; x += 3) {
    const i = y * GRID_W + x; if (city.buildings[i]) continue;
    const u = flux[i * 2], v = flux[i * 2 + 1], mag = Math.hypot(u, v); if (mag < .05) continue;
    const sx = (x + .5) * cw, sy = (y + .5) * ch, len = Math.min(cw * 1.2, 7 + mag * 3), ex = sx + u / mag * len, ey = sy + v / mag * len;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    ctx.beginPath(); ctx.arc(ex, ey, 1.5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function resetParticles() {
  const random = (() => { let s = 8132026; return () => ((s = Math.imul(1664525, s) + 1013904223 >>> 0) / 4294967296); })();
  particles = Array.from({ length: 95 }, () => ({ x: random() * GRID_W, y: random() * GRID_H, life: random() * 180, side: random() < .5 ? "base" : "opt" }));
}

function drawParticles(ctx, side, flux, cw, ch) {
  if (!controls.particles.checked || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.fillStyle = "rgba(255,199,91,.72)";
  for (const particle of particles) if (particle.side === side) {
    let x = Math.max(0, Math.min(GRID_W - .001, particle.x)), y = Math.max(0, Math.min(GRID_H - .001, particle.y)), i = Math.floor(y) * GRID_W + Math.floor(x);
    const u = flux[i * 2], v = flux[i * 2 + 1], mag = Math.hypot(u, v) || 1;
    particle.x += .025 * u / mag; particle.y += .025 * v / mag; particle.life += 1;
    if (particle.x < 0 || particle.x >= GRID_W || particle.y < 0 || particle.y >= GRID_H || particle.life > 220 || byId((side === "base" ? baselineTypes : optimizedTypes)[i]).green) { particle.x = Math.random() * GRID_W; particle.y = Math.random() * GRID_H; particle.life = 0; }
    ctx.beginPath(); ctx.arc(x * cw, y * ch, 1.55, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

function drawMap(canvas, side, types, result, field, flux) {
  const { context: ctx, width, height } = setupCanvas(canvas), cw = width / GRID_W, ch = height / GRID_H, hour = +controls.hour.value;
  const tempAll = pedestrianValues(latest.base.hourly[hour], city).concat(pedestrianValues(latest.opt.hourly[hour], city));
  const phiAll = pedestrianValues(latest.baseField, city).concat(pedestrianValues(latest.optField, city));
  const info = new Float32Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i += 1) { const m = byId(types[i]); info[i] = result.hourly[hour][i] + city.heights[i] / 8 + (1 - m.albedo) * 10 - m.evap * settings().moisture / 35; }
  const values = controls.layer.value === "potential" ? field : controls.layer.value === "temperature" ? result.hourly[hour] : info;
  const all = controls.layer.value === "potential" ? phiAll : controls.layer.value === "temperature" ? tempAll : pedestrianValues(values, city);
  const min = percentile(all, .03), max = percentile(all, .97);
  ctx.clearRect(0, 0, width, height);
  if (basemapImage) {
    ctx.drawImage(basemapImage, 0, 0, width, height);
    ctx.fillStyle = "rgba(4,16,24,.18)"; ctx.fillRect(0, 0, width, height);
  }
  ctx.save(); ctx.globalAlpha = basemapImage ? +controls.mapOpacity.value / 100 : 1;
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const x = i % GRID_W, y = Math.floor(i / GRID_W), material = byId(types[i]);
    ctx.fillStyle = controls.layer.value === "materials" ? material.color : scalarColor(values[i], min, max);
    ctx.fillRect(x * cw, y * ch, Math.ceil(cw) + .3, Math.ceil(ch) + .3);
    if (city.buildings[i]) { ctx.fillStyle = "rgba(0,0,0,.18)"; ctx.fillRect(x * cw + 1, y * ch + 1, cw - 2, ch - 2); ctx.strokeStyle = "rgba(255,255,255,.2)"; ctx.strokeRect(x * cw + .5, y * ch + .5, cw - 1, ch - 1); }
  }
  ctx.restore();
  drawRoadTexture(ctx, width, height, cw, ch);
  if (controls.layer.value === "potential") drawContours(ctx, field, min, max, cw, ch);
  drawFlux(ctx, flux, cw, ch);
  if (side === "opt" && plan) { ctx.save(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; for (const hub of plan.hubs) { const x = hub % GRID_W, y = Math.floor(hub / GRID_W); ctx.beginPath(); ctx.arc((x + .5) * cw, (y + .5) * ch, Math.max(3, Math.min(cw, ch) * .25), 0, Math.PI * 2); ctx.stroke(); } ctx.restore(); }
  drawParticles(ctx, side, flux, cw, ch);
}

function drawProfile() {
  const { context: ctx, width, height } = setupCanvas(canvases.chart), margin = { l: 46, r: 14, t: 12, b: 30 };
  const base = [], opt = [];
  for (let hour = 0; hour < 24; hour += 1) { base.push(percentile(pedestrianValues(potentialField(baselineTypes, latest.base, hour, latest.settings, city), city), .95)); opt.push(percentile(pedestrianValues(potentialField(optimizedTypes, latest.opt, hour, latest.settings, city), city), .95)); }
  const min = Math.min(...base, ...opt) - 2, max = Math.max(...base, ...opt) + 2, plotW = width - margin.l - margin.r, plotH = height - margin.t - margin.b;
  ctx.clearRect(0, 0, width, height); ctx.strokeStyle = "#274454"; ctx.fillStyle = "#a9c1ca"; ctx.font = "12px system-ui";
  for (let k = 0; k <= 4; k += 1) { const y = margin.t + plotH * k / 4, value = max - (max - min) * k / 4; ctx.beginPath(); ctx.moveTo(margin.l, y); ctx.lineTo(width - margin.r, y); ctx.stroke(); ctx.fillText(value.toFixed(0), 6, y + 4); }
  for (const hour of [0, 6, 12, 18, 23]) { const x = margin.l + plotW * hour / 23; ctx.fillText(`${hour}h`, x - 8, height - 8); }
  const line = (series, color) => { ctx.strokeStyle = color; ctx.lineWidth = 2.3; ctx.beginPath(); series.forEach((value, i) => { const x = margin.l + plotW * i / 23, y = margin.t + plotH * (max - value) / (max - min); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); };
  line(base, "#ff766f"); line(opt, "#56d8dd");
}

function updateLegend() {
  const hour = +controls.hour.value, layer = controls.layer.value;
  if (layer === "materials") $("legend").innerHTML = `<span>재료색</span><span>○ MCLP 거점</span><span>→ 순 열유속</span>`;
  else { const values = layer === "temperature" ? pedestrianValues(latest.base.hourly[hour], city).concat(pedestrianValues(latest.opt.hourly[hour], city)) : pedestrianValues(latest.baseField, city).concat(pedestrianValues(latest.optField, city)); $("legend").innerHTML = `<span>${percentile(values, .03).toFixed(0)}</span><span class="gradient"></span><span>${percentile(values, .97).toFixed(0)}${layer === "temperature" ? "°C" : " Φ"}</span><span>○ 냉각거점</span><span>→ 열유속</span>`; }
}

function metrics() {
  const basePhi = mean(pedestrianValues(latest.baseField, city)), optPhi = mean(pedestrianValues(latest.optField, city));
  const baseResidence = tracerResidence(baselineTypes, latest.baseField, latest.baseFlux, city, latest.baseField), optResidence = tracerResidence(optimizedTypes, latest.optField, latest.optFlux, city, latest.baseField);
  const baseNight = mean(latest.base.sensible.slice(20, 24)), optNight = mean(latest.opt.sensible.slice(20, 24));
  const threshold = percentile(pedestrianValues(latest.base.hourly[15], city), .8), baseExposure = exposure(latest.base, threshold, city), optExposure = exposure(latest.opt, threshold, city);
  const signed = (value, unit, digits = 1) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}${unit}`;
  $("metric-potential").textContent = optPhi.toFixed(1); $("metric-potential-delta").textContent = `기준 ${basePhi.toFixed(1)} · ${signed(optPhi - basePhi, " Φ")}`;
  $("metric-residence").textContent = `${optResidence.toFixed(1)}분`; $("metric-residence-delta").textContent = `기준 ${baseResidence.toFixed(1)}분 · ${signed((optResidence - baseResidence) / baseResidence * 100, "%", 0)}`;
  $("metric-night").textContent = `${optNight.toFixed(0)} W/m²`; $("metric-night-delta").textContent = `기준 ${baseNight.toFixed(0)} W/m² · ${signed((optNight - baseNight) / baseNight * 100, "%", 0)}`;
  $("metric-exposure").textContent = `${optExposure.toFixed(1)}%`; $("metric-exposure-delta").textContent = `기준 ${baseExposure.toFixed(1)}% · ${signed(optExposure - baseExposure, "%p")}`;
}

function render() {
  if (!latest) return;
  const hour = +controls.hour.value;
  latest.baseField = potentialField(baselineTypes, latest.base, hour, latest.settings, city); latest.optField = potentialField(optimizedTypes, latest.opt, hour, latest.settings, city);
  latest.baseFlux = fluxField(latest.baseField, latest.settings, city); latest.optFlux = fluxField(latest.optField, latest.settings, city);
  drawMap(canvases.base, "base", baselineTypes, latest.base, latest.baseField, latest.baseFlux); drawMap(canvases.opt, "opt", optimizedTypes, latest.opt, latest.optField, latest.optFlux); drawProfile(); updateLegend();
}

function animate() { if (latest && controls.particles.checked) { drawMap(canvases.base, "base", baselineTypes, latest.base, latest.baseField, latest.baseFlux); drawMap(canvases.opt, "opt", optimizedTypes, latest.opt, latest.optField, latest.optFlux); } animation = requestAnimationFrame(animate); }

function run() {
  clearTimeout(runTimer); updateOutputs(); $("status").textContent = "텐서 CA 계산 중"; $("run-button").disabled = true;
  requestAnimationFrame(() => {
    const modelSettings = settings(), base = simulate(baselineTypes, modelSettings, city); plan = optimize(baselineTypes, base, modelSettings, city); optimizedTypes = plan.types;
    const opt = simulate(optimizedTypes, modelSettings, city); latest = { settings: modelSettings, base, opt };
    resetParticles(); render(); metrics();
    $("pipe-dbscan").textContent = `${plan.clusterCount}개 고온 군집 탐지`; $("pipe-mclp").textContent = `${plan.hubs.length}개 냉각 거점 선정`; $("pipe-ga").textContent = `${plan.generations}세대 · ${plan.budgetCount}셀 재배치`; $("pipe-ca").textContent = `[24, 7, ${GRID_H}, ${GRID_W}] 정보텐서 · 144 스텝`;
    $("status").textContent = "계산 완료 · 시드 고정"; $("run-button").disabled = false;
  });
}

function scheduleRun() { clearTimeout(runTimer); runTimer = setTimeout(run, 150); }
function hover(canvas, side) {
  canvas.addEventListener("pointermove", event => {
    if (!latest) return;
    const rect = canvas.getBoundingClientRect(), x = Math.floor((event.clientX - rect.left) / rect.width * GRID_W), y = Math.floor((event.clientY - rect.top) / rect.height * GRID_H), i = y * GRID_W + x;
    const types = side === "base" ? baselineTypes : optimizedTypes, result = side === "base" ? latest.base : latest.opt, field = side === "base" ? latest.baseField : latest.optField, material = byId(types[i]), [u, v] = windVectorAt(i, latest.settings, city);
    $("cell-detail").textContent = `${side === "base" ? "기준" : "AI"} (${x + 1}, ${y + 1}) · ${material.name} · T ${result.hourly[+controls.hour.value][i].toFixed(1)}°C · α ${material.albedo.toFixed(2)} · H ${city.heights[i].toFixed(0)}m · W ${(latest.settings.moisture * 100).toFixed(0)}% · v (${u.toFixed(2)}, ${v.toFixed(2)}) · Φ ${field[i].toFixed(1)}`;
  });
  canvas.addEventListener("pointerleave", () => { $("cell-detail").textContent = "지도를 가리키면 셀의 정보행렬 Sᵢⱼ = (T, M, u, v, H, W, α)을 확인할 수 있습니다."; });
}

$("material-table").innerHTML = MATERIALS.map(m => `<tr><td>${m.name}</td><td>${m.albedo.toFixed(2)}</td><td>${m.emissivity.toFixed(2)}</td><td>${m.storage}</td><td>${m.permeability}</td><td>${m.source}</td></tr>`).join("");
hover(canvases.base, "base"); hover(canvases.opt, "opt");
[controls.air, controls.solar, controls.moisture, controls.budget, controls.wind, controls.objective].forEach(control => control.addEventListener("input", scheduleRun));
[controls.hour, controls.layer].forEach(control => control.addEventListener("input", () => { updateOutputs(); render(); }));
controls.particles.addEventListener("change", render); $("run-button").addEventListener("click", run);
controls.mapOpacity.addEventListener("input", () => { updateOutputs(); render(); });
controls.basemap.addEventListener("change", () => {
  const file = controls.basemap.files?.[0];
  if (!file) return;
  if (basemapUrl) URL.revokeObjectURL(basemapUrl);
  basemapUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => { basemapImage = image; $("status").textContent = "배경 영상 적용 · 격자 정합 확인 필요"; render(); };
  image.src = basemapUrl;
});
new ResizeObserver(render).observe(document.querySelector("main"));
updateOutputs(); run(); animation = requestAnimationFrame(animate);
window.addEventListener("beforeunload", () => { cancelAnimationFrame(animation); if (basemapUrl) URL.revokeObjectURL(basemapUrl); });
