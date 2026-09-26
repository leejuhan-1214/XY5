import { byId, MATERIAL } from './materials.js';

// A reduced, uncalibrated surface / substrate / air model. No LST enters the solver.
// All parameters below are declared assumptions, not fitted Guwol coefficients.
export const MODEL_ASSUMPTIONS = Object.freeze({
  maxTimeStepS: 30, airLayerDepthM: 30, airDensityKgM3: 1.2, airHeatCapacityJKgK: 1005,
  windReduction: 0.25, airDiffusivityM2S: 5, backgroundRelaxationS: 900,
  lateralConductivityDepthWK: 2, coverageRadiusM: 250,
  formulation: 'surface storage + substrate storage + sensible exchange + air upwind advection/diffusion',
});
const SIGMA = 5.670374419e-8;
const R = 6371008.8;
const rad = Math.PI / 180;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const q90 = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * 0.9, low = Math.floor(position);
  return sorted[low] + (sorted[Math.ceil(position)] - sorted[low]) * (position - low);
};
const seededRandom = seed => {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
};

function prepare(dataset) {
  const { width, height } = dataset.grid || {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('유효한 분석 격자가 필요합니다.');
  const count = width * height;
  if (dataset.surface?.material?.length !== count) throw new Error('재질 격자와 분석 격자의 크기가 다릅니다.');
  const [west, south, east, north] = dataset.bbox || [];
  if (![west, south, east, north].every(finite) || east <= west || north <= south) throw new Error('유효한 경위도 경계가 필요합니다.');
  const dx = R * Math.cos((south + north) / 2 * rad) * (east - west) * rad / width;
  const dy = R * (north - south) * rad / height;
  const areas = new Float64Array(count);
  const mask = new Uint8Array(count);
  const materialIds = Array.from(dataset.surface.material);
  for (let i = 0; i < count; i += 1) {
    const y = Math.floor(i / width), top = north - y * (north - south) / height, bottom = top - (north - south) / height;
    areas[i] = R ** 2 * (east - west) * rad / width * (Math.sin(top * rad) - Math.sin(bottom * rad));
    mask[i] = (!dataset.surface.insideBoundary || Boolean(dataset.surface.insideBoundary[i])) && Number.isInteger(materialIds[i]) && Boolean(byId(materialIds[i])) ? 1 : 0;
  }
  const neighbors = Array.from({ length: count }, (_, i) => {
    const x = i % width, y = Math.floor(i / width);
    return [x ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y ? i - width : -1, y + 1 < height ? i + width : -1].map(j => j >= 0 && mask[j] ? j : -1);
  });
  return { width, height, count, dx, dy, areas, mask, materialIds, neighbors };
}

function weatherValue(weather, key, hour, fallback) {
  const values = weather?.[key];
  if (!values?.length) return fallback;
  const a = Math.min(values.length - 1, Math.max(0, Math.floor(hour))), b = Math.min(values.length - 1, a + 1);
  // Missing measurements remain missing; optional parameters have explicit assumptions.
  if (!finite(values[a]) || !finite(values[b])) return fallback;
  return values[a] + (values[b] - values[a]) * (hour - Math.floor(hour));
}

function forcingAt(weather, hour, windEnabled) {
  const ambient = weatherValue(weather, 'temperature_2m', hour, null);
  const solarKey = weather?.shortwave_radiation_instant ? 'shortwave_radiation_instant' : 'shortwave_radiation';
  const solar = weatherValue(weather, solarKey, hour, null);
  if (!finite(ambient) || !finite(solar)) throw new Error('기온·일사 결측으로 모델을 계산할 수 없습니다.');
  const windSpeed = Math.max(0, weatherValue(weather, 'wind_speed_10m', hour, 0));
  // Interpolate direction as a vector, including the wrap at 360 degrees.
  const directions = weather?.wind_direction_10m;
  const low = Math.min(directions?.length - 1 || 0, Math.floor(hour)), high = Math.min(directions?.length - 1 || 0, low + 1);
  const d0 = finite(directions?.[low]) ? directions[low] * rad : 0, d1 = finite(directions?.[high]) ? directions[high] * rad : d0, f = hour - Math.floor(hour);
  const east = -((1 - f) * Math.sin(d0) + f * Math.sin(d1));
  const south = (1 - f) * Math.cos(d0) + f * Math.cos(d1);
  const scale = windEnabled ? MODEL_ASSUMPTIONS.windReduction * windSpeed / (Math.hypot(east, south) || 1) : 0;
  const humidity = clamp(weatherValue(weather, 'relative_humidity_2m', hour, 60), 0, 100);
  const vapourHpa = humidity / 100 * 6.112 * Math.exp(17.67 * ambient / (ambient + 243.5));
  const emissivitySky = clamp(1.24 * (vapourHpa / (ambient + 273.15)) ** (1 / 7), 0, 1);
  return {
    ambient, solar: Math.max(0, solar), u: east * scale, v: south * scale,
    // Convection still acts with wind disabled; this switch isolates horizontal transport.
    convection: 5.7 + 3.8 * windSpeed * MODEL_ASSUMPTIONS.windReduction,
    longwaveDown: emissivitySky * SIGMA * (ambient + 273.15) ** 4,
    moisture: clamp(weatherValue(weather, 'soil_moisture_0_to_7cm', hour, 0.4), 0, 0.6),
  };
}

function forcingSchedule(grid, weather, windEnabled, endHour) {
  const schedule = [];
  let time = 0, nextHour = 3600;
  const end = endHour * 3600;
  while (time < end - 1e-7) {
    const maxStep = Math.min(MODEL_ASSUMPTIONS.maxTimeStepS, end - time, nextHour - time);
    if (maxStep < 1e-8) { nextHour += 3600; continue; }
    const forcing = forcingAt(weather, (time + maxStep / 2) / 3600, windEnabled);
    const rate = Math.abs(forcing.u) / grid.dx + Math.abs(forcing.v) / grid.dy
      + 2 * MODEL_ASSUMPTIONS.airDiffusivityM2S * (1 / grid.dx ** 2 + 1 / grid.dy ** 2)
      + forcing.convection / (MODEL_ASSUMPTIONS.airDensityKgM3 * MODEL_ASSUMPTIONS.airHeatCapacityJKgK * MODEL_ASSUMPTIONS.airLayerDepthM)
      + 1 / MODEL_ASSUMPTIONS.backgroundRelaxationS;
    const dt = Math.min(maxStep, 0.45 / rate);
    if (dt < 1e-8) { nextHour += 3600; continue; }
    time += dt;
    const captureHour = Math.abs(time - nextHour) < 1e-6 ? nextHour / 3600 : null;
    schedule.push({ ...forcing, dt, cfl: rate * dt, captureHour });
    if (captureHour !== null) nextHour += 3600;
  }
  return schedule;
}

function solve(grid, dataset, types, weather, schedule, { capture = true } = {}) {
  const { count, mask, neighbors, dx, dy } = grid;
  const initial = forcingAt(weather, 0, true).ambient;
  const materials = Array.from(types, id => byId(id));
  let surface = new Float64Array(count).fill(initial), bulk = new Float64Array(count).fill(initial), air = new Float64Array(count).fill(initial);
  let nextSurface = new Float64Array(count), nextBulk = new Float64Array(count), nextAir = new Float64Array(count);
  const snapshot = values => Array.from(values, (value, i) => mask[i] ? value : null);
  const hourly = capture ? [snapshot(surface)] : [], airHourly = capture ? [snapshot(air)] : [], airFluxHourly = capture ? [Array.from(mask, valid => valid ? [0, 0] : null)] : [];
  const airCapacity = MODEL_ASSUMPTIONS.airDensityKgM3 * MODEL_ASSUMPTIONS.airHeatCapacityJKgK * MODEL_ASSUMPTIONS.airLayerDepthM;
  const invDx2 = 1 / dx ** 2, invDy2 = 1 / dy ** 2;
  const diagnostics = { maxCFL: 0, minTimeStepS: Infinity, steps: schedule.length, finite: true };
  for (const f of schedule) {
    const { dt } = f;
    diagnostics.maxCFL = Math.max(diagnostics.maxCFL, f.cfl);
    diagnostics.minTimeStepS = Math.min(diagnostics.minTimeStepS, dt);
    for (let i = 0; i < count; i += 1) {
      if (!mask[i]) continue;
      const m = materials[i];
      if (!m) throw new Error('알 수 없는 모델 재료입니다.');
      const [left, right, up, down] = neighbors[i];
      const t = surface[i], a = air[i], b = bulk[i];
      // Ground layers do not advect. Their lateral conduction uses actual meter spacing.
      const surfaceLaplacian = ((left >= 0 ? surface[left] - t : 0) + (right >= 0 ? surface[right] - t : 0)) * invDx2
        + ((up >= 0 ? surface[up] - t : 0) + (down >= 0 ? surface[down] - t : 0)) * invDy2;
      const incomingX = f.u >= 0 ? left : right, incomingY = f.v >= 0 ? up : down;
      const advection = Math.abs(f.u) * ((incomingX >= 0 ? air[incomingX] : f.ambient) - a) / dx
        + Math.abs(f.v) * ((incomingY >= 0 ? air[incomingY] : f.ambient) - a) / dy;
      const airLaplacian = ((left >= 0 ? air[left] - a : 0) + (right >= 0 ? air[right] - a : 0)) * invDx2
        + ((up >= 0 ? air[up] - a : 0) + (down >= 0 ? air[down] - a : 0)) * invDy2;
      // The tree class represents shaded ground; no detailed building shadow is inferred.
      const shade = m.tree ? 0.45 : 1;
      const absorbed = (1 - m.albedo) * f.solar * shade;
      const radiation = m.emissivity * (f.longwaveDown - SIGMA * (t + 273.15) ** 4);
      const sensible = f.convection * (t - a);
      const latent = m.evap * f.moisture * (0.25 + 0.75 * Math.min(1, f.solar / 800));
      const conduction = m.conductance * (t - b);
      const anthropogenic = m.building ? 12 : types[i] === MATERIAL.asphalt.id ? 5 : 1;
      nextSurface[i] = t + dt / m.surfaceCapacity * (absorbed + radiation - sensible - latent - conduction + anthropogenic + MODEL_ASSUMPTIONS.lateralConductivityDepthWK * surfaceLaplacian);
      nextBulk[i] = b + dt / m.bulkCapacity * (conduction - 1.2 * (b - initial));
      nextAir[i] = a + dt * (sensible / airCapacity + advection + MODEL_ASSUMPTIONS.airDiffusivityM2S * airLaplacian + (f.ambient - a) / MODEL_ASSUMPTIONS.backgroundRelaxationS);
      if (!finite(nextSurface[i]) || !finite(nextAir[i]) || nextSurface[i] < -100 || nextSurface[i] > 150) throw new Error('모델 수치가 안정성 범위를 벗어났습니다.');
    }
    [surface, nextSurface] = [nextSurface, surface];
    [bulk, nextBulk] = [nextBulk, bulk];
    [air, nextAir] = [nextAir, air];
    if (capture && f.captureHour !== null) {
      hourly[f.captureHour] = snapshot(surface);
      airHourly[f.captureHour] = snapshot(air);
      // Excess sensible heat carried by the assumed air layer, W per m transect.
      airFluxHourly[f.captureHour] = Array.from(air, (value, i) => mask[i] ? [airCapacity * (value - f.ambient) * f.u, airCapacity * (value - f.ambient) * f.v] : null);
    }
  }
  return { hourly, airHourly, airFluxHourly, final: snapshot(surface), finalAir: snapshot(air), diagnostics };
}

/** Independent model prediction. Observed LST and remote-sensing indices are never read. */
export function simulateResearch(dataset, { types = dataset.surface?.material, weather = dataset.weather, windEnabled = true, endHour = 24 } = {}) {
  const grid = prepare(dataset);
  if (types?.length !== grid.count) throw new Error('시나리오 재료 격자가 일치하지 않습니다.');
  if (!finite(endHour) || endHour <= 0 || endHour > 24) throw new Error('모델 시각은 0시 초과 24시 이하여야 합니다.');
  const schedule = forcingSchedule(grid, weather, windEnabled, endHour);
  return { ...solve(grid, dataset, types, weather, schedule), endHour, mask: Array.from(grid.mask), cellSpacingM: [grid.dx, grid.dy] };
}

export function predictAtAcquisition(dataset, { weather = dataset.weather, date = null, datetime = null, acquisitionHour = null, windEnabled = true } = {}) {
  let hour = acquisitionHour ?? 11 + 10 / 60, localDate = date;
  if (datetime) {
    const stamp = Date.parse(datetime);
    if (!Number.isFinite(stamp)) throw new Error('유효한 위성 촬영 시각이 필요합니다.');
    const local = new Date(stamp + 9 * 3600000);
    hour = (local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds() + local.getUTCMilliseconds() / 1000) / 3600;
    localDate = local.toISOString().slice(0, 10);
    if (date && date !== localDate) throw new Error('촬영 날짜와 시각이 일치하지 않습니다.');
  }
  if (localDate && weather?.time?.length && weather.time.some(time => !String(time).startsWith(localDate))) throw new Error('촬영일과 모델 기상 날짜가 다릅니다.');
  // Integrate exactly to acquisition time; avoid rounding 11:10 to 11:00.
  const result = simulateResearch(dataset, { weather, windEnabled, endHour: hour });
  return { values: result.final, hour, metadata: { date: localDate, datetime, timezone: 'Asia/Seoul', calibrated: false, observationLSTUsed: false, diagnostics: result.diagnostics } };
}

export function validationMetrics(predictions, observations, mask = null) {
  const pairs = [];
  for (let i = 0; i < Math.min(predictions?.length || 0, observations?.length || 0); i += 1) {
    if ((!mask || mask[i]) && finite(predictions[i]) && finite(observations[i])) pairs.push([predictions[i], observations[i]]);
  }
  if (!pairs.length) return { count: 0, mae: null, rmse: null, bias: null, r2: null };
  const observedMean = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length;
  let absolute = 0, squared = 0, bias = 0, total = 0;
  for (const [predicted, observed] of pairs) { const error = predicted - observed; absolute += Math.abs(error); squared += error ** 2; bias += error; total += (observed - observedMean) ** 2; }
  return { count: pairs.length, mae: absolute / pairs.length, rmse: Math.sqrt(squared / pairs.length), bias: bias / pairs.length, r2: total > 0 ? 1 - squared / total : null };
}

function statistics(values, grid, threshold) {
  let sum = 0, sumSquares = 0, totalArea = 0, hotAreaM2 = 0, count = 0, hotCount = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i += 1) if (grid.mask[i] && finite(values[i])) {
    const value = values[i], area = grid.areas[i];
    count += 1; totalArea += area; sum += value * area; sumSquares += value * value * area;
    min = Math.min(min, value); max = Math.max(max, value);
    if (finite(threshold) && value >= threshold) { hotAreaM2 += area; hotCount += 1; }
  }
  const mean = totalArea ? sum / totalArea : null;
  return { count, mean, min: count ? min : null, max: count ? max : null, stdDev: count ? Math.sqrt(Math.max(0, sumSquares / totalArea - mean * mean)) : null, hotCount: finite(threshold) ? hotCount : null, hotAreaM2: finite(threshold) ? hotAreaM2 : null, areaM2: totalArea, threshold };
}

const distanceM = (a, b, grid) => Math.hypot((a % grid.width - b % grid.width) * grid.dx, (Math.floor(a / grid.width) - Math.floor(b / grid.width)) * grid.dy);
function greedyMCLP(candidates, values, grid, threshold, count, radiusM) {
  const hot = values.map((value, index) => finite(value) && value >= threshold && grid.mask[index] ? index : -1).filter(index => index >= 0);
  // Equal demand per square meter of modeled hot surface. Legacy demand proxies
  // contain observed LST and must not leak into model-only placement evaluation.
  const weights = new Map(hot.map(i => [i, grid.areas[i]]));
  const uncovered = new Set(hot), hubs = [];
  while (hubs.length < count && uncovered.size) {
    let best = -1, bestScore = -Infinity;
    for (const candidate of candidates) {
      if (hubs.includes(candidate)) continue;
      let score = 0;
      for (const demand of uncovered) if (distanceM(candidate, demand, grid) <= radiusM) score += weights.get(demand);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (best < 0 || bestScore <= 0) break;
    hubs.push(best);
    for (const demand of uncovered) if (distanceM(best, demand, grid) <= radiusM) uncovered.delete(demand);
  }
  const totalWeight = Array.from(weights.values()).reduce((sum, value) => sum + value, 0);
  const uncoveredWeight = Array.from(uncovered).reduce((sum, i) => sum + weights.get(i), 0);
  return { hubs, coverageRadiusM: radiusM, weightedCoverage: totalWeight ? (totalWeight - uncoveredWeight) / totalWeight : null, demandWeight: '모델 고온 셀의 면적 × 동일 단위수요; 인구·보행량·취약성·관측 LST 미사용', method: '탐욕적 MCLP 근사 · 계획상 반경, 실측 냉각 범위 아님' };
}

const COST = { 3: 1, 4: 1.3, 7: 1, 8: 1.1, 9: 1.8 };
/** Fixed resource inventory, equal cost units, actual solver fitness for every GA genome. */
export function runResearchExperiment(dataset, { budgetPercent = 10, seed = 42, evalHour = 11, windEnabled = true, weather = dataset.weather } = {}) {
  const grid = prepare(dataset), baseTypes = grid.materialIds;
  if (!finite(evalHour) || evalHour < 1 || evalHour > 23) throw new Error('평가 시각은 1~23시여야 합니다.');
  const fullSchedule = forcingSchedule(grid, weather, windEnabled, 24);
  const evaluationSchedule = forcingSchedule(grid, weather, windEnabled, evalHour);
  const baseline = solve(grid, dataset, baseTypes, weather, fullSchedule);
  const baseAtEvaluation = Number.isInteger(evalHour) ? baseline.hourly[evalHour] : solve(grid, dataset, baseTypes, weather, evaluationSchedule, { capture: false }).final;
  const threshold = q90(baseAtEvaluation.filter((_, i) => grid.mask[i]));
  const roofCandidates = [], groundCandidates = [];
  for (let i = 0; i < grid.count; i += 1) if (grid.mask[i]) {
    if (baseTypes[i] === MATERIAL.blackRoof.id) roofCandidates.push(i);
    else if (baseTypes[i] === MATERIAL.asphalt.id || baseTypes[i] === MATERIAL.concrete.id) groundCandidates.push(i);
  }
  const candidates = [...roofCandidates, ...groundCandidates];
  const percent = finite(budgetPercent) ? clamp(budgetPercent, 0, 100) : 0;
  const budgetCount = Math.floor(candidates.length * percent / 100);
  const fixed = candidates.slice().sort((a, b) => ((Math.imul(a, 2654435761) >>> 0) - (Math.imul(b, 2654435761) >>> 0)) || a - b).slice(0, budgetCount);
  // Both scenarios use exactly this inventory. The GA may rearrange it among allowed cells.
  const inventory = fixed.map((idx, k) => ({ materialId: baseTypes[idx] === MATERIAL.blackRoof.id ? (k % 3 === 0 ? MATERIAL.greenRoof.id : MATERIAL.epdm.id) : (k % 3 === 0 ? MATERIAL.permeable.id : MATERIAL.coolPave.id), kind: baseTypes[idx] === MATERIAL.blackRoof.id ? 'roof' : 'ground' }));
  const apply = indices => { const types = baseTypes.slice(); indices.forEach((idx, k) => { types[idx] = inventory[k].materialId; }); return types; };
  const materialTypes = apply(fixed);
  const mclp = greedyMCLP(candidates, baseAtEvaluation, grid, threshold, budgetCount ? Math.min(8, Math.ceil(budgetCount / 4)) : 0, MODEL_ASSUMPTIONS.coverageRadiusM);
  const random = seededRandom(seed), groups = { roof: roofCandidates, ground: groundCandidates };
  const normalize = genome => {
    const used = new Set(), output = [];
    for (let k = 0; k < inventory.length; k += 1) {
      const allowed = groups[inventory[k].kind];
      let index = genome[k];
      if (!allowed.includes(index) || used.has(index)) {
        const free = allowed.filter(candidate => !used.has(candidate));
        index = free[Math.floor(random() * free.length)];
      }
      used.add(index); output.push(index);
    }
    return output;
  };
  const cache = new Map();
  const objective = values => {
    const stats = statistics(values, grid, threshold);
    if (!stats.count) return null;
    let exceedance = 0;
    for (let i = 0; i < values.length; i += 1) if (grid.mask[i] && finite(values[i])) exceedance += Math.max(0, values[i] - threshold) * grid.areas[i];
    return stats.mean + 0.5 * exceedance / stats.areaM2 + 0.05 * stats.max;
  };
  const evaluate = genome => {
    const key = genome.map((index, k) => `${index}:${inventory[k].materialId}`).sort().join(',');
    if (!cache.has(key)) cache.set(key, objective(solve(grid, dataset, apply(genome), weather, evaluationSchedule, { capture: false }).final));
    return cache.get(key);
  };
  let best = fixed.slice(), generations = 0;
  if (budgetCount) {
    const used = new Set(), preferred = inventory.map(item => {
      const candidatesForKind = groups[item.kind].filter(i => !used.has(i)).sort((a, b) => {
        const priority = i => baseAtEvaluation[i] + (mclp.hubs.some(hub => distanceM(i, hub, grid) <= mclp.coverageRadiusM) ? 2 : 0);
        return priority(b) - priority(a) || a - b;
      });
      used.add(candidatesForKind[0]); return candidatesForKind[0];
    });
    let population = [fixed.slice(), preferred];
    while (population.length < 8) population.push(normalize(inventory.map(() => -1)));
    for (generations = 0; generations < 6; generations += 1) {
      population.sort((a, b) => evaluate(a) - evaluate(b));
      const next = population.slice(0, 2);
      while (next.length < 8) {
        const a = population[Math.floor(random() * 4)], b = population[Math.floor(random() * 4)];
        const child = a.map((index, k) => random() < 0.5 ? index : b[k]);
        for (let k = 0; k < Math.max(1, Math.ceil(budgetCount * 0.15)); k += 1) child[Math.floor(random() * child.length)] = -1;
        next.push(normalize(child));
      }
      population = next;
    }
    population.sort((a, b) => evaluate(a) - evaluate(b));
    best = population[0];
  }
  const optimizedTypes = apply(best);
  const runs = budgetCount ? [baseline, solve(grid, dataset, materialTypes, weather, fullSchedule), solve(grid, dataset, optimizedTypes, weather, fullSchedule)] : [baseline, baseline, baseline];
  const models = runs.map((result, i) => {
    const types = [baseTypes, materialTypes, optimizedTypes][i];
    const atEvaluation = Number.isInteger(evalHour) ? result.hourly[evalHour] : solve(grid, dataset, types, weather, evaluationSchedule, { capture: false }).final;
    return { id: `model${i + 1}`, name: ['Model 1 · 기준 도시', 'Model 2 · 고정 위치 재료 변경', 'Model 3 · 같은 자원 배치 탐색'][i], types, ...result, values: atEvaluation, stats: statistics(atEvaluation, grid, threshold), hourlyStats: result.hourly.map(values => statistics(values, grid, threshold)), objective: objective(atEvaluation), changedCells: types.map((type, index) => type !== baseTypes[index] ? index : -1).filter(index => index >= 0) };
  });
  const inventoryCounts = {};
  inventory.forEach(item => { inventoryCounts[item.materialId] = (inventoryCounts[item.materialId] || 0) + 1; });
  return {
    models, threshold,
    plan: { ...mclp, budgetPercent: percent, budgetCount, eligibleCount: candidates.length, fixedIndices: fixed, optimizedIndices: best, inventory: inventoryCounts, costUnits: inventory.reduce((sum, item) => sum + COST[item.materialId], 0), costUnitLabel: '가정 상대비용/셀 · 실제 원화 견적 아님', generations, populationSize: budgetCount ? 8 : 0, evaluatedLayouts: cache.size, seed, objective: '평균 LST + 0.5 × 임계값 초과량의 면적가중 평균 + 0.05 × 최고 LST', objectiveFixed: models[1].objective, objectiveOptimized: models[2].objective },
    metadata: {
      calibrated: false, observationLSTUsed: false, legacyDemandUsed: false, independentValidationRequired: true,
      demandWeights: '모델 고온 영역의 단위면적당 동일 수요; 실측 인구·보행량·취약성을 의미하지 않음',
      grid: { width: grid.width, height: grid.height, spacingM: [grid.dx, grid.dy] }, mask: Array.from(grid.mask), areas: Array.from(grid.areas), evalHour, windEnabled,
      assumptions: MODEL_ASSUMPTIONS, thresholdSource: 'Model 1 평가 시각의 90백분위, 모든 모델·시각에 동일 적용',
      boundary: '지표·확산 경계는 무유속, 공기 유입은 배경 기온, 유출은 상류차분, 공기는 배경 기온에 900초 완화',
      initialCondition: '모든 시나리오에서 00시 기온으로 지표·기층·공기를 초기화, 이전 날 열 저장은 미반영',
      limitations: ['재질 및 증발·인공열·공기층 높이·풍속 감소 계수는 가정값', '상대 예산은 동일 재료 수량에 대한 가정 비용, 시공·법적 가능성 미검증', '표면 자체는 이류하지 않으며 바람은 별도 공기 상태를 수송', '균일한 풍향장을 사용하므로 건물 사이 실제 바람길을 재현하지 않음', '수목 셀 자체의 그늘 계수·맑은 하늘 장파 근사를 사용하며 상세 건물 그림자·다중 복사는 미구현', 'GA는 제한 횟수 근사 탐색이며 전역 최적해를 보장하지 않음'],
    },
  };
}
