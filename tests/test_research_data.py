"""Data-contract tests independent of network and no filled validation truth."""
import importlib.util
import json
from pathlib import Path
import unittest

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('build_research_data', ROOT / 'scripts/build_research_data.py')
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


class ResearchDataTests(unittest.TestCase):
    def test_mask_before_average_and_coverage_gate(self):
        # One source cell has 25% clear coverage and must stay missing even
        # though averaging the surviving sample would produce a plausible value.
        values = np.array([[10, 20, 99, np.nan], [30, 40, np.nan, np.nan]])
        mean, fraction = pipeline.block_mean(values, 2, 1, np.ones((1, 2), bool))
        self.assertEqual(mean[0, 0], 25)
        self.assertTrue(np.isnan(mean[0, 1]))
        self.assertEqual(fraction[0, 1], .25)
        self.assertEqual(pipeline.nullable_flat(mean), [25.0, None])

    def test_grid_and_recorded_source_contract(self):
        result = json.loads((ROOT / 'data/research-inputs.json').read_text())
        self.assertEqual(len(result['grid']['cellAreaM2']), 432)
        self.assertEqual(sum(result['grid']['insideBoundary']), 246)
        self.assertTrue(all(a > 0 for a in result['grid']['cellAreaM2']))
        for scene in result['landsat']['scenes']:
            self.assertEqual(len(scene['values']), 432)
            for val, coverage, inside in zip(scene['values'], scene['validFraction'], result['grid']['insideBoundary']):
                self.assertTrue(val is None or coverage >= .8)
                if not inside:
                    self.assertIsNone(val)
        s2 = result['sentinel2']
        self.assertEqual(s2['scene']['date'], '2024-08-29')
        self.assertEqual(s2['reflectance']['offsets']['B04'], -1000)
        self.assertEqual(s2['reflectance']['quantification'], 10000)
        self.assertEqual(len(s2['ndvi']), 432)
        self.assertTrue(all(v is None or -1 <= v <= 1 for v in s2['ndvi']))
        self.assertTrue(any(v is None for v in s2['ndvi']))
        for day in result['weather']['dates']:
            self.assertEqual(day['utcOffsetSeconds'], 32400)
            self.assertEqual(day['units']['wind_speed_10m'], 'm/s')
            self.assertEqual(len(day['hourly']['temperature_2m']), 24)

    def test_complete_official_landcover_and_fraction_accounting(self):
        result = json.loads((ROOT / 'data/research-inputs.json').read_text())
        cover = result['landcover']
        self.assertEqual(cover['status'], 'available')
        self.assertEqual(cover['sourceFeatureCount'], 12074)
        self.assertEqual(cover['imageryDates'], ['2023-12-30Z'])
        pipeline.validate_landcover(cover, result['grid'])
        for i, inside in enumerate(result['grid']['insideBoundary']):
            if not inside:
                self.assertIsNone(cover['classes'][i])
                self.assertTrue(all(a[i] is None for a in cover['fractions'].values()))
                continue
            total = sum(a[i] for a in cover['fractions'].values())
            self.assertAlmostEqual(total, cover['validFraction'][i], delta=.001)
            self.assertEqual(cover['classes'][i], int(max(cover['fractions'], key=lambda code: cover['fractions'][code][i])))

    def test_boundary_ring_and_hole_assembly_is_not_bbox(self):
        boundary = json.loads((ROOT / 'data/research-boundary.geojson').read_text())
        ring = boundary['features'][0]['geometry']['coordinates'][0]
        self.assertEqual(ring[0], ring[-1])
        self.assertGreater(len(ring), 20)
        self.assertTrue(pipeline.ring_contains(126.706289, 37.4473875, ring))
        self.assertFalse(pipeline.ring_contains(126.6925639, 37.4610653, ring))

    def test_landcover_rejects_shifted_grid_and_missing_provenance(self):
        result = json.loads((ROOT / 'data/research-inputs.json').read_text())
        grid = result['grid']
        with self.assertRaises(ValueError):
            pipeline.validate_landcover({}, grid)
        data = {'source': 'https://egisapp.me.go.kr/', 'edition': 'unit test, not actual data',
                'sourceCRS': 'EPSG:5179', 'method': 'unit test only', 'grid': dict(grid),
                'classes': [None] * 432, 'legend': {'154': '도로'}}
        self.assertIs(pipeline.validate_landcover(data, grid), data)
        data['grid']['bbox'] = [0, 0, 1, 1]
        with self.assertRaises(ValueError):
            pipeline.validate_landcover(data, grid)


if __name__ == '__main__':
    unittest.main()
