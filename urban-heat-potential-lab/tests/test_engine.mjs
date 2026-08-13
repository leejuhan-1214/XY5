import assert from "node:assert/strict";
import { MATERIALS } from "../src/materials.js";
import { CELL_COUNT, createCity, simulate, potentialField, fluxField, optimize } from "../src/engine.js";

const settings = { peakAir: 34, solar: 850, moisture: .6, budget: 18, windDeg: 0, objective: "exposure" };
const city = createCity();
assert.equal(city.types.length, CELL_COUNT);
assert.equal(MATERIALS[0].albedo, .05);

const baseline = simulate(city.types, settings, city);
assert.equal(baseline.hourly.length, 24);
assert.ok(baseline.hourly.flatMap(values => Array.from(values)).every(Number.isFinite));

const plan = optimize(city.types, baseline, settings, city);
assert.equal(plan.types.length, CELL_COUNT);
assert.ok(plan.budgetCount > 0);

const optimized = simulate(plan.types, settings, city);
const basePhi = potentialField(city.types, baseline, 15, settings, city);
const optPhi = potentialField(plan.types, optimized, 15, settings, city);
assert.ok(basePhi.every(Number.isFinite));
assert.ok(optPhi.every(Number.isFinite));
assert.equal(fluxField(basePhi, settings, city).length, CELL_COUNT * 2);

const changed = plan.types.reduce((sum, id, i) => sum + Number(id !== city.types[i]), 0);
assert.equal(changed, plan.budgetCount);
console.log(JSON.stringify({ hourlySteps: baseline.hourly.length, changedCells: changed, clusters: plan.clusterCount, hubs: plan.hubs.length }));
