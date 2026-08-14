import assert from "node:assert/strict";
import { GUWOL_DATA } from "../data/guwol-data.js";
import { CELL_COUNT, createCity, simulate, optimize, potentialField, pedestrianValues, mean } from "../src/engine.js";

const weather = GUWOL_DATA.weather;
const settings = {
  peakAir: Math.max(...weather.temperature_2m),
  solar: Math.max(...weather.shortwave_radiation),
  moisture: weather.soil_moisture_0_to_7cm[11],
  budget: 18,
  windDeg: 45,
  objective: "exposure",
  weather,
  observedHour: 11,
  calibrateLST: true,
};
const city = createCity(GUWOL_DATA);
assert.equal(city.types.length, CELL_COUNT);
assert.equal(city.observedLST.length, CELL_COUNT);
assert.equal(GUWOL_DATA.weather.time.length, 24);

const baseline = simulate(city.types, settings, city);
const observedWalkable = pedestrianValues(city.observedLST, city);
const modeledWalkable = pedestrianValues(baseline.hourly[11], city);
assert.ok(Math.abs(mean(observedWalkable) - mean(modeledWalkable)) < 0.01, "baseline must match the Landsat LST anchor at 11:10");

settings.calibrationBias = baseline.calibrationBias;
const plan = optimize(city.types, baseline, settings, city);
const optimized = simulate(plan.types, settings, city);
const basePhi = mean(pedestrianValues(potentialField(city.types, baseline, 15, settings, city), city));
const optPhi = mean(pedestrianValues(potentialField(plan.types, optimized, 15, settings, city), city));
assert.ok(optPhi < basePhi, "optimized Guwol plan should reduce mean pedestrian heat potential");
for (let i = 0; i < CELL_COUNT; i += 1) if (!city.insideBoundary[i]) assert.equal(plan.types[i], city.types[i], "cells outside Guwol boundary must be unchanged");

console.log(JSON.stringify({
  place: GUWOL_DATA.place,
  lstMeanC: GUWOL_DATA.acquisition.lstMeanC,
  taggedBuildings: GUWOL_DATA.osm.buildingHeightTagged,
  changedCells: plan.budgetCount,
  meanPotentialDelta: +(optPhi - basePhi).toFixed(2),
}));
