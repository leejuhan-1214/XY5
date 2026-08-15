import { MATERIAL, byId } from "./materials.js";

export const GRID_W = 24;
export const GRID_H = 18;
export const CELL_COUNT = GRID_W * GRID_H;
const DT = 600;
const SIGMA = 5.670374419e-8;

const gaussian = (x, y, cx, cy, s) => Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * s ** 2));
export const percentile = (values, q) => {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p), hi = Math.ceil(p);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
};
export const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const xy = i => [i % GRID_W, Math.floor(i / GRID_W)];
const distance = (a, b) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.hypot(ax - bx, ay - by); };

export function createCity(dataset = null, history = null) {
  if (dataset?.surface?.material?.length === CELL_COUNT) {
    return {
      types: Uint8Array.from(dataset.surface.material),
      population: Float32Array.from(dataset.demand.activityProxy),
      vulnerability: Float32Array.from(dataset.demand.vulnerabilityProxy),
      heights: Float32Array.from(dataset.surface.buildingHeightM),
      buildings: Uint8Array.from(dataset.surface.building),
      insideBoundary: Uint8Array.from(dataset.surface.insideBoundary),
      observedLST: Float32Array.from(dataset.remoteSensing.lstC),
      ndvi: Float32Array.from(dataset.remoteSensing.ndvi),
      ndbi: Float32Array.from(dataset.remoteSensing.ndbi),
      historyHotFrequency: history?.metrics?.hotFrequencyPercent?.length === CELL_COUNT ? Float32Array.from(history.metrics.hotFrequencyPercent) : null,
      historyMeanAnomaly: history?.metrics?.meanAnomalyC?.length === CELL_COUNT ? Float32Array.from(history.metrics.meanAnomalyC) : null,
      dataset,
      history,
    };
  }
  const types = new Uint8Array(CELL_COUNT);
  const population = new Float32Array(CELL_COUNT);
  const vulnerability = new Float32Array(CELL_COUNT);
  const heights = new Float32Array(CELL_COUNT);
  const buildings = new Uint8Array(CELL_COUNT);
  for (let y = 0; y < GRID_H; y += 1) for (let x = 0; x < GRID_W; x += 1) {
    const i = y * GRID_W + x, lx = x % 6, ly = y % 6;
    const park = x >= 9 && x <= 14 && y >= 7 && y <= 10;
    const building = !park && lx >= 1 && lx <= 4 && ly >= 1 && ly <= 3;
    if (park) types[i] = (x + y) % 5 === 0 ? MATERIAL.tree.id : MATERIAL.grass.id;
    else if (building) { types[i] = MATERIAL.blackRoof.id; buildings[i] = 1; heights[i] = 12 + ((x * 17 + y * 11) % 33); }
    else if (lx === 0 || ly === 0 || ly === 4) types[i] = MATERIAL.asphalt.id;
    else types[i] = MATERIAL.concrete.id;
    population[i] = building ? 0 : 1.2 + 8.5 * gaussian(x, y, 5, 13, 3.1) + 7 * gaussian(x, y, 19, 5, 3.5) + 4.5 * gaussian(x, y, 18, 15, 2.8);
    vulnerability[i] = building ? 0 : 1 + .9 * gaussian(x, y, 5, 13, 3.8) + .45 * gaussian(x, y, 19, 5, 4.2);
  }
  return { types, population, vulnerability, heights, buildings };
}

export const airAt = (hour, settings) => settings.weather?.temperature_2m?.[Math.max(0, Math.min(23, Math.floor(hour)))] ?? settings.peakAir - 5.5 + 5.5 * Math.sin(2 * Math.PI * (hour - 9) / 24);
const buildingAt = (types, i) => Boolean(byId(types[i]).building);

function shadeAt(i, hour, types, city) {
  if (buildingAt(types, i)) return 1;
  const x = i % GRID_W, y = Math.floor(i / GRID_W);
  let shade = 1;
  const direction = hour < 12 ? 1 : -1;
  const reach = Math.max(1, Math.round(3.2 - 2 * Math.sin(Math.PI * Math.max(0, Math.min(12, hour - 6)) / 12)));
  for (let d = 1; d <= reach; d += 1) {
    const xx = x + direction * d;
    if (xx >= 0 && xx < GRID_W && city.buildings[y * GRID_W + xx]) { shade = .34; break; }
  }
  for (let yy = Math.max(0, y - 1); yy <= Math.min(GRID_H - 1, y + 1); yy += 1) for (let xx = Math.max(0, x - 1); xx <= Math.min(GRID_W - 1, x + 1); xx += 1) {
    if (types[yy * GRID_W + xx] === MATERIAL.tree.id) shade = Math.min(shade, .24);
  }
  return shade;
}

export function windVectorAt(i, settings, city) {
  const angle = settings.windDeg * Math.PI / 180;
  let u = Math.cos(angle), v = Math.sin(angle);
  const x = i % GRID_W, y = Math.floor(i / GRID_W);
  let density = 0;
  for (let yy = Math.max(0, y - 2); yy <= Math.min(GRID_H - 1, y + 2); yy += 1) for (let xx = Math.max(0, x - 2); xx <= Math.min(GRID_W - 1, x + 2); xx += 1) density += city.heights[yy * GRID_W + xx] / 45;
  const drag = Math.max(.2, 1 - density / 45);
  if (city.buildings[i]) return [0, 0];
  const channel = (x % 6 === 0 || y % 6 === 0 || y % 6 === 4) ? 1.25 : .8;
  return [u * drag * channel, v * drag * channel];
}

export function simulate(types, settings, city) {
  let surface = new Float32Array(CELL_COUNT), bulk = new Float32Array(CELL_COUNT), nextSurface = new Float32Array(CELL_COUNT), nextBulk = new Float32Array(CELL_COUNT);
  const initial = airAt(0, settings);
  for (let i = 0; i < CELL_COUNT; i += 1) { surface[i] = initial + (buildingAt(types, i) ? 1.2 : 2); bulk[i] = initial + 3; }
  const hourly = [], sensible = [], solarAbsorbed = [];
  for (let step = 0; step < 144; step += 1) {
    const hour = (step + .5) / 6, air = airAt(hour, settings);
    const solarFactor = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
    const observedSolar = settings.weather?.shortwave_radiation?.[Math.max(0, Math.min(23, Math.floor(hour)))];
    const solar = observedSolar ?? settings.solar * solarFactor, sky = air - (solarFactor > 0 ? 8 : 13), hConv = 10.2;
    const absorbedStep = new Float32Array(CELL_COUNT);
    for (let i = 0; i < CELL_COUNT; i += 1) {
      const material = byId(types[i]), x = i % GRID_W, y = Math.floor(i / GRID_W);
      let neighborSum = 0, neighborCount = 0;
      if (x > 0) { neighborSum += surface[i - 1]; neighborCount += 1; }
      if (x < GRID_W - 1) { neighborSum += surface[i + 1]; neighborCount += 1; }
      if (y > 0) { neighborSum += surface[i - GRID_W]; neighborCount += 1; }
      if (y < GRID_H - 1) { neighborSum += surface[i + GRID_W]; neighborCount += 1; }
      const qSolar = (1 - material.albedo) * solar * shadeAt(i, hour, types, city);
      const qConv = hConv * (surface[i] - air);
      const qLong = material.emissivity * SIGMA * ((surface[i] + 273.15) ** 4 - (sky + 273.15) ** 4);
      const qLatent = material.evap * settings.moisture * (material.green ? 1 : .72) * (.25 + .75 * solarFactor);
      const qCond = material.conductance * (surface[i] - bulk[i]);
      const qMix = 1.7 * (neighborSum / neighborCount - surface[i]);
      const qAnthropogenic = material.building ? 12 : types[i] === MATERIAL.asphalt.id ? 5 : 1;
      nextSurface[i] = Math.max(-5, Math.min(80, surface[i] + (qSolar - qConv - qLong - qLatent - qCond + qMix + qAnthropogenic) * DT / material.surfaceCapacity));
      nextBulk[i] = Math.max(-5, Math.min(65, bulk[i] + (qCond - 1.2 * (bulk[i] - (initial + 4))) * DT / material.bulkCapacity));
      absorbedStep[i] = qSolar;
    }
    [surface, nextSurface] = [nextSurface, surface];
    [bulk, nextBulk] = [nextBulk, bulk];
    if ((step + 1) % 6 === 0) {
      hourly.push(Float32Array.from(surface));
      solarAbsorbed.push(absorbedStep);
      let flux = 0, area = 0;
      for (let i = 0; i < CELL_COUNT; i += 1) if (!city.buildings[i]) { flux += Math.max(0, hConv * (surface[i] - airAt(Math.floor(hour), settings))); area += 1; }
      sensible.push(flux / Math.max(1, area));
    }
  }
  let calibrationBias = null;
  if (city.observedLST && settings.calibrateLST !== false) {
    const observedHour = settings.observedHour ?? 11;
    calibrationBias = settings.calibrationBias ? Float32Array.from(settings.calibrationBias) : new Float32Array(CELL_COUNT);
    if (!settings.calibrationBias) for (let i = 0; i < CELL_COUNT; i += 1) calibrationBias[i] = city.observedLST[i] - hourly[observedHour][i];
    for (let hour = 0; hour < 24; hour += 1) {
      const weight = Math.max(.12, Math.exp(-((hour - observedHour) ** 2) / 35));
      for (let i = 0; i < CELL_COUNT; i += 1) hourly[hour][i] += calibrationBias[i] * weight;
    }
  }
  return { hourly, sensible, solarAbsorbed, calibrationBias };
}

export function potentialField(types, result, hour, settings, city) {
  const temp = result.hourly[hour], absorbed = result.solarAbsorbed[hour], field = new Float32Array(CELL_COUNT);
  for (let i = 0; i < CELL_COUNT; i += 1) {
    const material = byId(types[i]);
    const heatStorage = material.bulkCapacity / 1000000;
    const buildingStagnation = city.heights[i] / 45;
    const greenCooling = material.green ? 1 : 0;
    const evapCooling = material.evap * settings.moisture / 190;
    field[i] = 1.0 * temp[i] + 4.2 * heatStorage + 5.0 * buildingStagnation + .007 * absorbed[i] - 5.2 * greenCooling - 4.5 * evapCooling;
  }
  return field;
}

export function fluxField(field, settings, city) {
  const flux = new Float32Array(CELL_COUNT * 2);
  for (let y = 0; y < GRID_H; y += 1) for (let x = 0; x < GRID_W; x += 1) {
    const i = y * GRID_W + x;
    if (city.buildings[i]) continue;
    const left = field[y * GRID_W + Math.max(0, x - 1)], right = field[y * GRID_W + Math.min(GRID_W - 1, x + 1)];
    const up = field[Math.max(0, y - 1) * GRID_W + x], down = field[Math.min(GRID_H - 1, y + 1) * GRID_W + x];
    const [wu, wv] = windVectorAt(i, settings, city);
    flux[i * 2] = -.28 * (right - left) / 2 + 1.1 * wu;
    flux[i * 2 + 1] = -.28 * (down - up) / 2 + 1.1 * wv;
  }
  return flux;
}

function dbscan(points, eps, minPoints) {
  const labels = new Int16Array(points.length); labels.fill(-1);
  let count = 0;
  const neighbors = p => points.map((_, j) => j).filter(j => distance(points[p], points[j]) <= eps);
  for (let i = 0; i < points.length; i += 1) {
    if (labels[i] !== -1) continue;
    const near = neighbors(i);
    if (near.length < minPoints) { labels[i] = -2; continue; }
    labels[i] = count;
    const queue = near.slice();
    for (let q = 0; q < queue.length; q += 1) {
      const j = queue[q];
      if (labels[j] === -2) labels[j] = count;
      if (labels[j] !== -1) continue;
      labels[j] = count;
      const expanded = neighbors(j);
      if (expanded.length >= minPoints) for (const k of expanded) if (!queue.includes(k)) queue.push(k);
    }
    count += 1;
  }
  return { labels, count };
}

function greedyMCLP(candidates, demands, weights, count, radius) {
  const chosen = [], uncovered = new Set(demands);
  while (chosen.length < count && uncovered.size) {
    let best = -1, bestScore = -1;
    for (const candidate of candidates) {
      if (chosen.includes(candidate)) continue;
      let score = 0;
      for (const demand of uncovered) if (distance(candidate, demand) <= radius) score += weights.get(demand) || 0;
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    if (best < 0) break;
    chosen.push(best);
    for (const demand of Array.from(uncovered)) if (distance(best, demand) <= radius) uncovered.delete(demand);
  }
  return chosen;
}

const seededRandom = seed => { let state = seed >>> 0; return () => { state += 0x6D2B79F5; let z = state; z = Math.imul(z ^ z >>> 15, z | 1); z ^= z + Math.imul(z ^ z >>> 7, z | 61); return ((z ^ z >>> 14) >>> 0) / 4294967296; }; };

export function optimize(baseTypes, baseResult, settings, city) {
  const peakPotential = potentialField(baseTypes, baseResult, 15, settings, city);
  const active = i => !city.insideBoundary || Boolean(city.insideBoundary[i]);
  const walkable = Array.from(peakPotential).filter((_, i) => active(i) && !city.buildings[i]);
  const threshold = percentile(walkable, .72), hot = [];
  for (let i = 0; i < CELL_COUNT; i += 1) if (active(i) && !city.buildings[i] && peakPotential[i] >= threshold && city.population[i] > 1.5) hot.push(i);
  const clusters = dbscan(hot, 1.55, 3);
  const candidates = [];
  for (let i = 0; i < CELL_COUNT; i += 1) if (active(i) && !city.buildings[i] && baseTypes[i] !== MATERIAL.grass.id && baseTypes[i] !== MATERIAL.tree.id) candidates.push(i);
  const historyPriority = i => 1
    + (city.historyHotFrequency?.[i] || 0) / 100 * .9
    + Math.max(0, city.historyMeanAnomaly?.[i] || 0) * .18;
  const weights = new Map(hot.map(i => [i, city.population[i] * city.vulnerability[i] * Math.max(1, peakPotential[i] - threshold + 1) * historyPriority(i)]));
  const hubs = greedyMCLP(candidates, hot, weights, Math.max(3, Math.min(8, Math.round(settings.budget / 4))), 3.2);
  const eligible = Array.from({ length: CELL_COUNT }, (_, i) => i).filter(i => active(i) && baseTypes[i] !== MATERIAL.grass.id && baseTypes[i] !== MATERIAL.tree.id);
  const budgetCount = Math.max(1, Math.round(eligible.length * settings.budget / 100));
  const genes = [];
  for (const idx of eligible) {
    const choices = city.buildings[idx] ? [MATERIAL.epdm.id, MATERIAL.greenRoof.id, MATERIAL.whitePaint.id] : [MATERIAL.coolPave.id, MATERIAL.permeable.id, ...(baseTypes[idx] === MATERIAL.concrete.id || city.population[idx] > 4 ? [MATERIAL.tree.id] : []), ...(baseTypes[idx] !== MATERIAL.asphalt.id ? [MATERIAL.grass.id] : [])];
    for (const materialId of choices) {
      const old = byId(baseTypes[idx]), next = byId(materialId);
      let nearby = 0, equity = 0;
      for (let j = 0; j < CELL_COUNT; j += 1) if (!city.buildings[j] && distance(idx, j) <= 2.6) {
        const falloff = Math.max(0, 1 - distance(idx, j) / 3);
        nearby += city.population[j] * falloff; equity += city.population[j] * city.vulnerability[j] * falloff;
      }
      const solarGain = Math.max(0, next.albedo - old.albedo) * settings.solar / 95;
      const evapGain = Math.max(0, next.evap - old.evap) * settings.moisture / 38;
      const storageGain = Math.max(0, (old.bulkCapacity - next.bulkCapacity) / 180000);
      const hubBonus = hubs.some(hub => distance(idx, hub) <= 2.5) ? 2.2 : 0;
      let score = (solarGain + evapGain * 1.45 + storageGain * .55) * (1 + equity * .022) + hubBonus;
      if (settings.objective === "potential") score = (solarGain * 1.8 + evapGain * 1.2 + storageGain * .7) * (1 + nearby * .015) + hubBonus;
      if (settings.objective === "residence") score = (evapGain * 1.2 + storageGain + solarGain * .65) * (1 + nearby * .014) + hubBonus * 1.5;
      if (settings.objective === "night") score = (storageGain * 2.3 + evapGain * .8 + solarGain * .55) * (1 + nearby * .012) + hubBonus * .5;
      if (next.tree) score += 3.2 + equity * .018;
      score *= historyPriority(idx);
      genes.push({ idx, materialId, score });
    }
  }
  genes.sort((a, b) => b.score - a.score);
  const random = seededRandom(8132026 + Math.round(settings.budget * 17) + Math.round(settings.moisture * 100));
  const normalize = pool => {
    const output = [], used = new Set();
    for (const gene of pool) if (!used.has(gene.idx) && output.length < budgetCount) { used.add(gene.idx); output.push(gene); }
    while (output.length < budgetCount) {
      const gene = genes[Math.floor(random() * Math.min(genes.length, Math.max(80, budgetCount * 5)))];
      if (!used.has(gene.idx)) { used.add(gene.idx); output.push(gene); }
    }
    return output;
  };
  const fitness = genome => genome.reduce((sum, gene) => sum + gene.score, 0) + hot.filter(i => genome.some(gene => distance(gene.idx, i) <= 2.5)).length * 1.6;
  const randomGenome = () => normalize(Array.from({ length: budgetCount * 2 }, () => genes[Math.floor(random() * Math.min(genes.length, budgetCount * 7))]));
  const mutate = genome => {
    const output = genome.slice();
    for (let k = 0; k < Math.max(1, Math.round(output.length * .08)); k += 1) output[Math.floor(random() * output.length)] = genes[Math.floor(random() * Math.min(genes.length, budgetCount * 8))];
    return normalize(output);
  };
  let population = [normalize(genes.slice(0, budgetCount))];
  while (population.length < 22) population.push(randomGenome());
  for (let generation = 0; generation < 30; generation += 1) {
    population.sort((a, b) => fitness(b) - fitness(a));
    const next = population.slice(0, 5);
    while (next.length < 22) {
      const a = population[Math.floor(random() * 10)], b = population[Math.floor(random() * 10)];
      next.push(mutate(normalize([...a.filter(() => random() < .58), ...b.filter(() => random() < .58)])));
    }
    population = next;
  }
  population.sort((a, b) => fitness(b) - fitness(a));
  const output = Uint8Array.from(baseTypes);
  for (const gene of population[0]) output[gene.idx] = gene.materialId;
  return { types: output, hubs, clusterCount: clusters.count, budgetCount, generations: 30 };
}

export function pedestrianValues(array, city) { return Array.from(array).filter((_, i) => !city.buildings[i] && (!city.insideBoundary || city.insideBoundary[i])); }
export function exposure(result, threshold, city) {
  const values = result.hourly[15]; let numerator = 0, denominator = 0;
  for (let i = 0; i < CELL_COUNT; i += 1) if (!city.buildings[i] && (!city.insideBoundary || city.insideBoundary[i])) { const weight = city.population[i] * city.vulnerability[i]; denominator += weight; if (values[i] >= threshold) numerator += weight; }
  return 100 * numerator / Math.max(1, denominator);
}

export function tracerResidence(types, field, flux, city, referenceField = field) {
  let total = 0, count = 0;
  const starts = Array.from({ length: CELL_COUNT }, (_, i) => i)
    .filter(i => !city.buildings[i] && (!city.insideBoundary || city.insideBoundary[i]))
    .sort((a, b) => referenceField[b] - referenceField[a])
    .slice(0, 28);
  const coolExit = percentile(pedestrianValues(referenceField, city), .45);
  for (const start of starts) {
    let x = start % GRID_W + .5, y = Math.floor(start / GRID_W) + .5, steps = 0;
    while (steps < 160) {
      const ix = Math.max(0, Math.min(GRID_W - 1, Math.floor(x))), iy = Math.max(0, Math.min(GRID_H - 1, Math.floor(y))), i = iy * GRID_W + ix;
      if (byId(types[i]).green || field[i] < coolExit) { steps += 1; break; }
      const u = flux[i * 2], v = flux[i * 2 + 1], magnitude = Math.hypot(u, v) || 1;
      x += .11 * u / magnitude; y += .11 * v / magnitude; steps += 1;
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) break;
    }
    total += steps * 10 / 60; count += 1;
  }
  return total / Math.max(1, count);
}
