import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyzeClusters, gridMetrics, summarizeTemperatures, compareObservations,
  pairSummary, relationships,
} from '../src/research-analysis.js';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

// Missing values never become zero; mask, threshold and known pixel areas all matter.
const summary = summarizeTemperatures({ values: [30, 40, null, NaN, 100, 50], mask: [1, 1, 1, 1, 0, 1], areas: [2, 3, 4, 5, 6, 7], threshold: 40 });
assert.deepEqual(summary, { count: 3, mean: 40, min: 30, max: 50, stdDev: Math.sqrt(200 / 3), hotCount: 2, hotAreaM2: 10 });
assert.equal(summarizeTemperatures({ values: [35, 40], threshold: 37 }).hotAreaM2, null);
assert.equal(summarizeTemperatures({ values: [35, 40] }).hotCount, null);
assert.equal(summarizeTemperatures({ values: [null, NaN] }).mean, null);
assert.equal(summarizeTemperatures({ values: [35, 40], threshold: 37, areas: [900, NaN] }).hotAreaM2, null);
assert.throws(() => summarizeTemperatures({ values: [1], mask: [] }), /mask/);

// Whole-cell masking governs the denominator; a missing cell is not hot or cold.
const islands = analyzeClusters({ values: [40, 42, null, 46, 47, 10, 90], width: 7, height: 1,
  bbox: [126.7, 37.44, 126.707, 37.441], mask: [1, 1, 1, 1, 1, 1, 0], threshold: 35, epsMeters: 110, minPoints: 2 });
assert.equal(islands.totalCount, 6);
assert.equal(islands.validCount, 5);
close(islands.coverage, 5 / 6);
assert.equal(islands.hotCount, 4);
assert.deepEqual(islands.clusters.map(c => c.indices), [[0, 1], [3, 4]]);
assert.deepEqual(islands.clusters.map(c => c.mean), [41, 46.5]);
assert.deepEqual(islands.clusters.map(c => c.max), [42, 47]);
assert.deepEqual(islands.labels, [1, 1, null, 2, 2, null, null]);
assert.equal(islands.features.type, 'FeatureCollection');
assert.equal(islands.features.features.length, 2);
close(islands.clusters.reduce((s, c) => s + c.areaM2, 0), islands.hotAreaM2, 1e-6);

// eps is a ground-distance parameter, not a degree or cell-index distance.
const pair = { values: [40, 40], width: 2, height: 1, threshold: 35, epsMeters: 160, minPoints: 2 };
const equator = analyzeClusters({ ...pair, bbox: [0, 0, .004, .001] });
const highLatitude = analyzeClusters({ ...pair, bbox: [0, 60, .004, 60.001] });
assert.equal(equator.clusters.length, 0);
assert.deepEqual(equator.noiseIndices, [0, 1]);
assert.equal(highLatitude.clusters.length, 1);
assert.equal(equator.hotCount, 2, 'noise still contributes to total hot area');
assert.ok(equator.hotAreaM2 > 0);

// minPoints includes the point itself. Border points remain in a core cluster.
const border = analyzeClusters({ values: [40, 40, 40, 40], width: 4, height: 1, bbox: [0, 0, .004, .001], epsMeters: 120, minPoints: 3 });
assert.deepEqual(border.clusters[0].indices, [0, 1, 2, 3]);
assert.equal(analyzeClusters({ values: [40], width: 1, height: 1, bbox: [0, 0, .001, .001], minPoints: 1 }).clusters.length, 1);

// P90 includes tied threshold cells; the UI must not claim the fraction is exactly 10%.
const ties = analyzeClusters({ values: [30, 30, 30, 30], width: 2, height: 2, bbox: [126.7, 37.44, 126.701, 37.441] });
assert.equal(ties.threshold, 30); assert.equal(ties.hotFraction, 1); assert.equal(ties.hotCount, 4);
const empty = analyzeClusters({ values: [null, NaN], width: 2, height: 1, bbox: [0, 0, .001, .001] });
assert.equal(empty.threshold, null); assert.equal(empty.coverage, 0); assert.equal(empty.hotFraction, null);
assert.equal(empty.hotAreaM2, 0); assert.deepEqual(empty.labels, [null, null]);
assert.throws(() => analyzeClusters({ ...pair, bbox: [0, 0, .01, .01], epsMeters: 0 }), /epsMeters/);
assert.throws(() => analyzeClusters({ ...pair, bbox: [0, 0, .01, .01], minPoints: 1.5 }), /minPoints/);

// Spherical cell areas sum to the spherical bbox area; Mercator pixels have
// different ground areas by latitude and must not use map metres squared.
const geo = gridMetrics({ width: 4, height: 3, bbox: [0, 30, 2, 60] });
const mercator = gridMetrics({ width: 4, height: 3, bbox: [0, 30, 2, 60], projection: 'mercator' });
const expectedArea = 6371008.8 ** 2 * 2 * Math.PI / 180 * (Math.sin(Math.PI / 3) - Math.sin(Math.PI / 6));
close(geo.areas.reduce((s, a) => s + a, 0) / expectedArea, 1, 1e-12);
close(mercator.areas.reduce((s, a) => s + a, 0) / expectedArea, 1, 1e-12);
assert.ok(mercator.areas[0] < mercator.areas.at(-1));
assert.ok(mercator.centers[0][1] > geo.centers[0][1]);
assert.throws(() => gridMetrics({ width: 2, height: 2, bbox: [170, 0, -170, 1] }), /bbox/);

// Geometries preserve a masked hole instead of filling a convex hull across it.
const ring = analyzeClusters({ values: new Array(9).fill(40), width: 3, height: 3,
  bbox: [0, 0, .003, .003], mask: [1, 1, 1, 1, 0, 1, 1, 1, 1], minPoints: 2, epsMeters: 120 });
assert.equal(ring.clusters.length, 1); assert.equal(ring.clusters[0].count, 8);
const rectangles = ring.clusters[0].geometry.coordinates;
assert.equal(rectangles.length, 4, 'runs compress rows without filling the central gap');
assert.ok(rectangles.every(([polygon]) => !(.0015 > polygon[0][0] && .0015 < polygon[1][0] && .0015 > polygon[0][1] && .0015 < polygon[2][1])));

// A small brute-force DBSCAN oracle checks the accelerated algorithm's density,
// noise and partition semantics on varied sparse/cold/missing grids.
function brute(values, metric, threshold, eps, minPoints) {
  const hot = values.map((v, i) => Number.isFinite(v) && v >= threshold ? i : -1).filter(i => i >= 0);
  const adjacent = i => hot.filter(j => Math.hypot(metric.projectedCenters[i][0] - metric.projectedCenters[j][0], metric.projectedCenters[i][1] - metric.projectedCenters[j][1]) <= eps);
  const labels = new Array(values.length).fill(null), seen = new Set();
  for (const i of hot) labels[i] = -1;
  let id = 0;
  for (const seed of hot) {
    if (seen.has(seed)) continue;
    seen.add(seed);
    const queue = adjacent(seed);
    if (queue.length < minPoints) continue;
    labels[seed] = ++id;
    const queued = new Set(queue);
    for (let p = 0; p < queue.length; p++) {
      const i = queue[p];
      if (!seen.has(i)) {
        seen.add(i); const next = adjacent(i);
        if (next.length >= minPoints) for (const j of next) if (!queued.has(j)) { queued.add(j); queue.push(j); }
      }
      if (labels[i] === -1) labels[i] = id;
    }
  }
  return labels;
}
let seed = 41;
const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 4294967296);
for (let trial = 0; trial < 40; trial++) {
  const width = 8, height = 7, bbox = [126.7, 37.44, 126.71, 37.45];
  const values = Array.from({ length: width * height }, () => random() < .2 ? null : random() * 50);
  const epsMeters = 120 + random() * 400, minPoints = 1 + Math.floor(random() * 7), threshold = 15;
  const result = analyzeClusters({ values, width, height, bbox, threshold, epsMeters, minPoints });
  assert.deepEqual(result.labels, brute(values, gridMetrics({ width, height, bbox }), threshold, epsMeters, minPoints), `DBSCAN trial ${trial}`);
}

// Same date is insufficient: exact scene provenance is required for A/B values.
const a = { value: 32, source: { id: 'scene-a', datetime: '2024-08-29T02:10:00Z' } };
assert.equal(compareObservations(a, { ...a, value: 35 }).delta, 3);
assert.equal(compareObservations(a, { value: null, source: a.source }).comparable, false);
assert.equal(compareObservations(a, { value: 40 }).reasonCode, 'missing-source');
assert.equal(compareObservations(a, { value: 40, source: { ...a.source, id: 'scene-b' } }).reasonCode, 'different-source');
assert.equal(compareObservations(a, { value: 40, source: { ...a.source, datetime: '2024-09-01T02:10:00Z' } }).reasonCode, 'inconsistent-date');

const relation = pairSummary([1, 2, null, 4, 9], [3, 5, 0, 9, 0], { mask: [1, 1, 1, 1, 0] });
assert.equal(relation.count, 3); close(relation.correlation, 1); close(relation.slope, 2); close(relation.intercept, 1);
assert.equal(pairSummary([1, 1], [2, 3]).correlation, null);
assert.equal(pairSummary([null], [3]).meanX, null);
const dataset = JSON.parse(readFileSync(new URL('../data/guwol-data.json', import.meta.url)));
const relations = relationships(dataset);
assert.equal(relations.length, 5);
assert.equal(relations.find(r => r.key === 'ndvi').source, 'Landsat');
assert.ok(relations.every(r => r.count <= dataset.surface.insideBoundary.filter(Boolean).length));

// Full-frame tied values are a real P90 case. This must finish without an all-pairs
// neighbour matrix and the output must remain compact even for dense sub-eps cells.
const start = performance.now();
const dense = analyzeClusters({ values: new Float32Array(256 * 256).fill(40), width: 256, height: 256,
  bbox: [126.7, 37.44, 126.701, 37.441], epsMeters: 250, minPoints: 3 });
assert.equal(dense.clusters.length, 1); assert.equal(dense.hotCount, 65536);
assert.equal(dense.clusters[0].geometry.coordinates.length, 256);
console.log(`Research analysis: metric DBSCAN, masks, geometry holes, provenance, descriptive pairs and 65,536 dense cells verified (${Math.round(performance.now() - start)} ms dense frame).`);
