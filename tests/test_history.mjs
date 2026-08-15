import assert from "node:assert/strict";
import { GUWOL_DATA } from "../data/guwol-data.js";
import { GUWOL_HISTORY } from "../data/guwol-history.js";
import { CELL_COUNT, createCity } from "../src/engine.js";
import { HISTORY_METRICS } from "../src/scene3d.js";

assert.ok(GUWOL_HISTORY.sceneCount >= 6, "multi-temporal composite needs at least six clear scenes");
assert.equal(GUWOL_HISTORY.scenes.length, GUWOL_HISTORY.sceneCount);
assert.ok(GUWOL_HISTORY.scenes.every(scene => scene.item.endsWith("_T1")), "only Tier 1 scenes may enter the composite");
assert.ok(GUWOL_HISTORY.scenes.every(scene => scene.meanLstC > 10 && scene.meanLstC < 70), "scene LST must be physically plausible");
assert.ok(GUWOL_HISTORY.scenes.every(scene => scene.aoiValidPercent >= 70), "each scene must pass the AOI-valid threshold");
for (const metric of Object.values(HISTORY_METRICS).filter(metric => metric.key !== "scene")) assert.equal(GUWOL_HISTORY.metrics[metric.key].length, CELL_COUNT, `${metric.key} must match the city grid`);
assert.equal(GUWOL_HISTORY.metrics.validSceneCount.length, CELL_COUNT);
assert.equal(GUWOL_HISTORY.sceneMaps.lstC.length, GUWOL_HISTORY.sceneCount);
assert.ok(GUWOL_HISTORY.sceneMaps.lstC.every(values => values.length === CELL_COUNT));

const city = createCity(GUWOL_DATA, GUWOL_HISTORY);
assert.equal(city.historyHotFrequency.length, CELL_COUNT);
assert.equal(city.historyMeanAnomaly.length, CELL_COUNT);
assert.ok(Math.max(...city.historyHotFrequency) <= 100);

console.log(JSON.stringify({
  scenes: GUWOL_HISTORY.sceneCount,
  period: GUWOL_HISTORY.period,
  meanLstC: GUWOL_HISTORY.summary.meanLstC,
  maxHotFrequencyPercent: Math.max(...city.historyHotFrequency),
}));
