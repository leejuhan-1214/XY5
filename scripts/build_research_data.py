"""Build traceable, null-preserving research inputs. Run from any directory.

Requires numpy and Pillow. Network sources are public STAC/Data APIs and Open-Meteo.
The raw-file cache is outside git (default /tmp/xy5-research-cache). It can be deleted
and rebuilt. An official land-cover grid may be supplied with --landcover FILE;
it must follow data/landcover-import.schema.json and have exactly the target grid.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1'
DATA = 'https://planetarycomputer.microsoft.com/api/data/v1/item/bbox'
SENTINEL_ITEM = 'S2B_MSIL2A_20240829T021539_R003_T52SBG_20240829T043313'
SCL_ACCEPTED = [4, 5, 6]  # vegetation, non-vegetated, water; reject shadow/cloud/snow/unknown
WEATHER_VARIABLES = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m',
                     'wind_direction_10m', 'shortwave_radiation_instant',
                     'soil_moisture_0_to_7cm', 'precipitation']
BOUNDARY_SOURCE = 'https://api.openstreetmap.org/api/0.6/relation/8857846/full.json'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_remote(url, cache):
    """Content-addressed-by-URL cache; caller records content hash in provenance."""
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / hashlib.sha256(url.encode()).hexdigest()
    if path.exists():
        return path.read_bytes()
    req = Request(url, headers={'User-Agent': 'XY5-Guwol-Research/3.0'})
    with urlopen(req, timeout=80) as response:
        data = response.read()
    path.write_bytes(data)
    return data


def nullable_flat(values, digits=4):
    return [round(float(v), digits) if np.isfinite(v) else None for v in np.asarray(values).flat]


def block_mean(values, target_width, target_height, inside, min_fraction=0.8):
    """Mask first, then average. Nulls never become zero or a scene-mean value."""
    values = np.asarray(values, dtype=float)
    h, w = values.shape
    if h % target_height or w % target_width:
        raise ValueError('Source grid must align exactly with target grid blocks')
    blocks = values.reshape(target_height, h // target_height, target_width, w // target_width)
    count = np.isfinite(blocks).sum(axis=(1, 3))
    fraction = count / ((h // target_height) * (w // target_width))
    sums = np.nansum(blocks, axis=(1, 3))
    means = np.divide(sums, count, out=np.full_like(sums, np.nan), where=count > 0)
    means[(fraction < min_fraction) | ~inside] = np.nan
    fraction[~inside] = 0
    return means, fraction


def ring_contains(x, y, ring):
    inside = False
    previous = ring[-1]
    for current in ring:
        x1, y1 = previous
        x2, y2 = current
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
        previous = current
    return inside


def boundary_from_osm(raw):
    data = json.loads(raw)
    nodes = {e['id']: [e['lon'], e['lat']] for e in data['elements'] if e['type'] == 'node'}
    ways = {e['id']: e['nodes'] for e in data['elements'] if e['type'] == 'way'}
    relation = next(e for e in data['elements'] if e['type'] == 'relation' and e['id'] == 8857846)
    if any(m['role'] == 'inner' for m in relation['members']):
        raise ValueError('Boundary now contains holes; update polygon assembler explicitly before rebuilding')
    pieces = [list(ways[m['ref']]) for m in relation['members'] if m['type'] == 'way' and m['role'] == 'outer']
    ring = pieces.pop(0)
    while pieces:
        found = False
        for i, piece in enumerate(pieces):
            if piece[0] == ring[-1]:
                ring += piece[1:]
            elif piece[-1] == ring[-1]:
                ring += piece[-2::-1]
            else:
                continue
            pieces.pop(i)
            found = True
            break
        if not found:
            raise ValueError('Boundary segments do not form one connected outer ring')
    if ring[0] != ring[-1]:
        raise ValueError('Boundary ring is not closed')
    return {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {
        'name': '구월동', 'source': BOUNDARY_SOURCE, 'osm_relation': 8857846,
        'osm_version': relation['version'], 'osm_timestamp': relation['timestamp'],
        'sourceSha256': sha(raw), 'retrievedAt': datetime.now(timezone.utc).isoformat(),
        'license': 'ODbL 1.0', 'attribution': '© OpenStreetMap contributors',
        'note': 'OSM legal-dong outline; not an official cadastral boundary survey'},
        'geometry': {'type': 'Polygon', 'coordinates': [[nodes[n] for n in ring]]}}]}


def apply_boundary(base, cache, offline):
    path = ROOT / 'data/research-boundary.geojson'
    if path.exists():
        boundary = json.loads(path.read_text())
    elif not offline:
        boundary = boundary_from_osm(read_remote(BOUNDARY_SOURCE, cache))
        path.write_text(json.dumps(boundary, ensure_ascii=False, indent=2) + '\n')
    else:
        return
    ring = boundary['features'][0]['geometry']['coordinates'][0]
    w, h = base['grid']['width'], base['grid']['height']
    west, south, east, north = base['bbox']
    base['surface']['insideBoundary'] = [int(ring_contains(west + (x + .5) * (east-west)/w,
        north - (y + .5) * (north-south)/h, ring)) for y in range(h) for x in range(w)]
    base['_researchBoundary'] = boundary['features'][0]['properties']


def grid_metadata(base):
    w, h = base['grid']['width'], base['grid']['height']
    west, south, east, north = base['bbox']
    # Spherical area of each longitude-latitude cell. Full cells selected by
    # original boundary-center mask; these are not exact polygon-clipped areas.
    radius = 6371008.8
    dlambda = math.radians((east - west) / w)
    areas = []
    for y in range(h):
        high = math.radians(north - y * (north - south) / h)
        low = math.radians(north - (y + 1) * (north - south) / h)
        areas.extend([round(radius ** 2 * dlambda * (math.sin(high) - math.sin(low)), 2)] * w)
    grid = {'width': w, 'height': h, 'bbox': base['bbox'], 'projection': 'EPSG:4326',
            'order': 'row-major north-to-south', 'cellAreaM2': areas,
            'areaMethod': 'Spherical WGS84-like mean Earth radius 6371008.8 m; full cells, boundary-center mask',
            'insideBoundary': base['surface']['insideBoundary'],
            'boundarySource': 'data/guwol-boundary.geojson is only the study bbox rectangle, not an administrative polygon',
            'boundaryApproximation': '구월동 주변 직사각형 연구영역; 법정동 경계 아님. 면적은 이 연구영역 안의 격자 면적.',
            'scope': 'Guwol-dong surrounding study bounding box; not the exact legal-dong boundary'}
    if base.get('_researchBoundary'):
        grid.update({'boundarySource': 'data/research-boundary.geojson',
            'boundaryMetadata': base['_researchBoundary'],
            'boundaryApproximation': 'OSM 구월동 경계 내 중심점이 있는 셀만 포함. 경계 셀은 전체 셀 면적으로 근사하며 공식 측량 면적이 아님.',
            'scope': 'Guwol-dong OSM legal boundary, approximated by included grid-cell centers'})
    return grid


def landsat_inputs(base):
    path = ROOT / 'data/observations.json'
    raw = path.read_bytes()
    source = json.loads(raw)
    if source['bbox'] != base['bbox'] or source.get('missingValue') is not None:
        raise ValueError('Landsat bbox or null contract does not match research grid')
    w, h = base['grid']['width'], base['grid']['height']
    inside = np.asarray(base['surface']['insideBoundary'], bool).reshape(h, w)
    scenes = []
    for scene in source['scenes']:
        pixels = np.asarray(scene['values'], dtype=float).reshape(source['height'], source['width'])
        values, coverage = block_mean(pixels, w, h, inside)
        scenes.append({'id': scene['id'], 'datetime': scene['datetime'], 'date': scene['datetime'][:10],
                       'source': scene['source'], 'platform': scene['platform'],
                       'values': nullable_flat(values, 3), 'validFraction': nullable_flat(coverage, 3),
                       'validCellCount': int(np.isfinite(values).sum()), 'assets': scene['assets']})
    return {'status': 'available', 'scenes': scenes, 'unit': '°C',
            'sourceFile': 'data/observations.json', 'sourceSha256': sha(raw),
            'sourceRetrievedAt': source['retrievedAt'],
            'sourceGrid': {'width': source['width'], 'height': source['height']},
            'qaRejectedBits': source['qaRejectedBits'], 'minimumValidFraction': 0.8,
            'method': 'QA-masked 96×108 values; 4×6 block means on 24×18; require 80% valid samples; null preserved; no imputation',
            'nativeThermalResolutionM': source['thermalNativeResolutionM'],
            'stQaStatus': 'not-imported', 'note': 'Grid samples are spatially correlated and are not individual building temperatures.'}


def sentinel_inputs(base, cache):
    source = f'{STAC}/collections/sentinel-2-l2a/items/{SENTINEL_ITEM}'
    item_raw = read_remote(source, cache)
    item = json.loads(item_raw)
    xml_url = item['assets']['product-metadata']['href']
    # Short-lived signed URL is used only in memory, never persisted in output.
    sign = json.loads(read_remote('https://planetarycomputer.microsoft.com/api/sas/v1/sign?' + urlencode({'href': xml_url}), cache))
    xml_raw = read_remote(sign['href'], cache)
    tree = ET.fromstring(xml_raw)
    quant = float(tree.find('.//BOA_QUANTIFICATION_VALUE').text)
    offsets = {e.attrib['band_id']: float(e.text) for e in tree.findall('.//BOA_ADD_OFFSET')}
    band_ids = {'B04': '3', 'B08': '7', 'B11': '11'}
    if not all(i in offsets for i in band_ids.values()):
        raise ValueError('Missing verified Sentinel-2 reflectance offset')
    bbox = ','.join(map(str, base['bbox']))
    urls = {b: f'{DATA}/{bbox}/144x162.tif?' + urlencode({
        'collection': 'sentinel-2-l2a', 'item': item['id'], 'assets': b,
        'asset_as_band': 'true', 'unscale': 'false', 'resampling': 'nearest',
        'reproject': 'nearest', 'return_mask': 'false'}) for b in ['B04', 'B08', 'B11', 'SCL']}
    with ThreadPoolExecutor(max_workers=4) as pool:
        raws = dict(zip(urls, pool.map(lambda b: read_remote(urls[b], cache), urls)))
    arrays = {b: np.asarray(Image.open(BytesIO(raw)), dtype=float) for b, raw in raws.items()}
    clear = np.isin(arrays['SCL'], SCL_ACCEPTED)
    refl = {b: (arrays[b] + offsets[band_ids[b]]) / quant for b in band_ids}
    valid = clear.copy()
    for b in refl:
        valid &= (arrays[b] > 0) & np.isfinite(refl[b]) & (refl[b] >= 0)
    with np.errstate(divide='ignore', invalid='ignore'):
        ndvi = (refl['B08'] - refl['B04']) / (refl['B08'] + refl['B04'])
        ndbi = (refl['B11'] - refl['B08']) / (refl['B11'] + refl['B08'])
    valid &= np.isfinite(ndvi) & np.isfinite(ndbi) & (np.abs(ndvi) <= 1) & (np.abs(ndbi) <= 1)
    ndvi[~valid] = np.nan
    ndbi[~valid] = np.nan
    w, h = base['grid']['width'], base['grid']['height']
    inside = np.asarray(base['surface']['insideBoundary'], bool).reshape(h, w)
    ndvi, fraction = block_mean(ndvi, w, h, inside)
    ndbi, _ = block_mean(ndbi, w, h, inside)
    return {'status': 'available', 'scene': {'id': item['id'], 'datetime': item['properties']['datetime'],
             'date': item['properties']['datetime'][:10], 'platform': item['properties']['platform'],
             'source': source, 'cloudPercent': item['properties']['eo:cloud_cover'],
             'processingBaseline': item['properties']['s2:processing_baseline']},
            'ndvi': nullable_flat(ndvi), 'ndbi': nullable_flat(ndbi), 'validFraction': nullable_flat(fraction),
            'validCellCount': int(np.isfinite(ndvi).sum()), 'minimumValidFraction': 0.8,
            'method': 'Nearest-neighbor B04/B08/B11 and SCL sampling to aligned 144×162 (~18 m) grid; SCL mask; reflectance offset; per-sample NDVI/NDBI; 6×9 block mean to 24×18; null outside boundary or under 80% valid',
            'nativeResolutionM': {'B04': 10, 'B08': 10, 'B11': 20, 'SCL': 20},
            'sclAcceptedClasses': SCL_ACCEPTED, 'reflectance': {'quantification': quant, 'offsets': {b: offsets[i] for b, i in band_ids.items()}},
            'assets': {b: {'url': urls[b], 'sha256': sha(raws[b])} for b in raws},
            'metadata': {'url': xml_url, 'sha256': sha(xml_raw), 'stacSha256': sha(item_raw)},
            'documentation': 'https://sentiwiki.copernicus.eu/web/s2-products',
            'limitations': ['Different sensors and several minutes apart, despite same date.',
                            'Nearest sampling is exploratory aggregation, not exact native-pixel area integration.',
                            'Sentinel-2 SCL is an automatic quality mask and can miss residual cloud or haze.']}


def weather_inputs(base, dates, cache):
    results = []
    for date in dates:
        url = 'https://archive-api.open-meteo.com/v1/archive?' + urlencode({
            'latitude': base['center'][0], 'longitude': base['center'][1],
            'start_date': date, 'end_date': date, 'hourly': ','.join(WEATHER_VARIABLES),
            'timezone': 'Asia/Seoul', 'wind_speed_unit': 'ms', 'models': 'era5'})
        try:
            raw = read_remote(url, cache)
            result = json.loads(raw)
            results.append({'date': date, 'status': 'available', 'hourly': result['hourly'],
                            'timezone': result['timezone'], 'utcOffsetSeconds': result['utc_offset_seconds'],
                            'units': result['hourly_units'], 'source': url, 'sha256': sha(raw),
                            'gridCenter': [result['latitude'], result['longitude']]})
        except Exception as error:
            results.append({'date': date, 'status': 'unavailable', 'source': url, 'reason': str(error)})
    return {'status': 'available' if all(d['status'] == 'available' for d in results) else 'partial',
            'dates': results, 'model': 'ERA5', 'spatialResolution': '0.25° (~25 km)',
            'source': 'Open-Meteo Historical Weather API / Copernicus ERA5',
            'documentation': 'https://open-meteo.com/en/docs/historical-weather-api',
            'note': 'Hourly gridded reanalysis forcing; not Guwol weather-station measurements or building-scale wind.'}


def official_landcover(grid, cache):
    """Read the publicly advertised WFS, never infer class codes from map colors."""
    bbox = ','.join(map(str, grid['bbox']))
    url = 'https://api.mcee.go.kr/geoserver/ows?' + urlencode({
        'service': 'WFS', 'request': 'GetFeature', 'version': '1.0.0',
        'typeName': 'EGIS:lv3_2024y', 'bbox': bbox + ',EPSG:4326',
        'srsName': 'EPSG:4326', 'outputFormat': 'application/json', 'maxFeatures': 20000})
    raw = read_remote(url, cache)
    data = json.loads(raw)
    features = data.get('features', [])
    if not features or int(data.get('numberMatched', data.get('totalFeatures', 0))) != len(features):
        raise ValueError('Official landcover response is empty or truncated; do not aggregate incomplete coverage')
    # ~2.7 m raster sampling makes all cells exact integer blocks and preserves
    # categorical codes. This is a documented approximation to polygon area.
    fine_w, fine_h = grid['width'] * 40, grid['height'] * 60
    raster = Image.new('I', (fine_w, fine_h), 0)
    west, south, east, north = grid['bbox']
    legend, imagery_dates = {}, set()
    for feature in features:
        props, geometry = feature['properties'], feature['geometry']
        code = int(props['l3_code'])
        legend[str(code)] = props['l3_name']
        if props.get('img_date'):
            imagery_dates.add(props['img_date'])
        polygons = geometry['coordinates'] if geometry['type'] == 'MultiPolygon' else [geometry['coordinates']]
        for polygon in polygons:
            rings = [[((p[0]-west)/(east-west)*fine_w, (north-p[1])/(north-south)*fine_h) for p in ring] for ring in polygon]
            left = max(0, math.floor(min(p[0] for p in rings[0])))
            top = max(0, math.floor(min(p[1] for p in rings[0])))
            right = min(fine_w, math.ceil(max(p[0] for p in rings[0])) + 1)
            bottom = min(fine_h, math.ceil(max(p[1] for p in rings[0])) + 1)
            if right <= left or bottom <= top:
                continue
            mask = Image.new('L', (right-left, bottom-top), 0)
            draw = ImageDraw.Draw(mask)
            draw.polygon([(x-left, y-top) for x, y in rings[0]], fill=255)
            for hole in rings[1:]:
                draw.polygon([(x-left, y-top) for x, y in hole], fill=0)
            raster.paste(code, (left, top, right, bottom), mask)
    samples = np.asarray(raster)
    w, h = grid['width'], grid['height']
    inside = np.asarray(grid['insideBoundary'], bool).reshape(h, w)
    coverage = (samples > 0).reshape(h, 60, w, 40).mean(axis=(1, 3))
    fractions = {code: (samples == int(code)).reshape(h, 60, w, 40).mean(axis=(1, 3)) for code in sorted(legend)}
    classes, dominant = np.zeros((h, w), dtype=float), np.zeros((h, w))
    for code, proportion in fractions.items():
        higher = proportion > dominant
        classes[higher] = int(code)
        dominant[higher] = proportion[higher]
        proportion[~inside] = np.nan
    classes[(coverage < .8) | ~inside] = np.nan
    dominant[~inside] = np.nan
    coverage[~inside] = 0
    result = {'status': 'available', 'source': url, 'sourceSha256': sha(raw),
        'sourceCRS': 'EPSG:3857 (WFS advertised); requested/reprojected EPSG:4326',
        'edition': '2024 전국 세분류 토지피복지도 (EGIS:lv3_2024y)',
        'sourceFeatureCount': len(features), 'sourceTimeStamp': data.get('timeStamp'),
        'imageryDates': sorted(imagery_dates), 'grid': {k: grid[k] for k in ['width', 'height', 'bbox', 'projection', 'order']},
        'classes': [int(v) if np.isfinite(v) else None for v in classes.flat], 'legend': legend,
        'fractions': {code: nullable_flat(p, 4) for code, p in fractions.items()},
        'validFraction': nullable_flat(coverage, 4), 'dominantFraction': nullable_flat(dominant, 4),
        'validCellCount': int(np.isfinite(classes).sum()),
        'method': 'Official categorical polygons from WFS; render holes-aware classes on aligned 960×1080 (~2.7 m) grid; per-cell sample fractions and majority class; minimum80% source coverage; no bilinear interpolation',
        'documentation': 'https://egisapp.me.go.kr/api/land.do',
        'capabilities': 'https://api.mcee.go.kr/geoserver/ows?service=WFS&request=GetCapabilities&version=1.0.0',
        'provider': '기후에너지환경부 환경공간정보서비스',
        'limitations': ['Edition year is not image acquisition date; see imageryDates.',
            'Area fractions are raster-sampling approximations, not exact polygon intersections.',
            'Land-cover classes do not identify actual roof materials or directly measure impervious fraction.']}
    validate_landcover(result, grid)
    return result


def landcover_inputs(grid, file=None, cache=None, previous=None):
    result = {'status': 'unavailable', 'source': 'https://egisapp.me.go.kr/',
              'documentation': 'https://aid.mcee.go.kr/intro/land.do',
              'reason': '공식 세분류 토지피복 원자료 미확보. 온라인 자료신청 페이지는 로그인 페이지로 이동함(2026-09-26 확인).',
              'requestURL': 'https://egisapp.me.go.kr/req/write.do',
              'requestRedirectObserved': 'https://egisapp.me.go.kr/login/goLogin.jsp',
              'wmsDocumentation': 'https://egisapp.me.go.kr/api/land.do',
              'importSchema': 'data/landcover-import.schema.json',
              'importCommand': 'python scripts/build_research_data.py --landcover PATH_TO_ALIGNED_JSON',
              'importInstructions': ['Obtain official detailed land-cover polygons/rasters and record source, edition/year and CRS.',
                 'Reproject to this bbox in EPSG:4326 and aggregate categorical coverage using majority area per target cell (never bilinear).',
                 'Provide 432 row-major classes, null for missing/outside boundary, plus class legend and provenance.',
                 'A category describes land cover; it does not establish roof material, permeability or measured albedo.']}
    if file:
        value = json.loads(Path(file).read_text(encoding='utf-8'))
        validate_landcover(value, grid)
        result.update(value)
        result['status'] = 'imported'
        result['fileSha256'] = sha(Path(file).read_bytes())
        result.pop('reason', None)
    elif previous and previous.get('status') == 'available':
        return previous
    elif cache:
        try:
            return official_landcover(grid, cache)
        except Exception as error:
            result['reason'] = str(error)
    return result


def validate_landcover(value, grid):
    """Strict alignment and provenance validation without inventing missing values."""
    required = ['source', 'edition', 'sourceCRS', 'method', 'grid', 'classes', 'legend']
    if any(k not in value for k in required):
        raise ValueError('Missing landcover provenance, grid, classes or legend')
    for k in ['width', 'height', 'projection', 'bbox']:
        if value['grid'].get(k) != grid[k]:
            raise ValueError(f'Landcover grid mismatch: {k}')
    if value['grid'].get('order') != grid['order']:
        raise ValueError('Landcover row order must be north-to-south')
    if len(value['classes']) != grid['width'] * grid['height']:
        raise ValueError('Landcover classes length does not match grid')
    if not all(isinstance(value[k], str) and value[k].strip() for k in required[:4]):
        raise ValueError('Landcover provenance must be non-empty strings')
    if not value['source'].startswith('https://'):
        raise ValueError('Landcover source must be a traceable HTTPS URL')
    for i, code in enumerate(value['classes']):
        if code is not None and (isinstance(code, bool) or not isinstance(code, int) or str(code) not in value['legend']):
            raise ValueError(f'Unknown landcover class at cell {i}')
        if not grid['insideBoundary'][i] and code is not None:
            raise ValueError('Landcover outside the boundary must be null')
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, default=Path('/tmp/xy5-research-cache'))
    parser.add_argument('--landcover', type=Path)
    parser.add_argument('--offline', action='store_true', help='Reuse existing Sentinel and weather sections; rebuild Landsat/null mask')
    parser.add_argument('--refresh-landcover', action='store_true', help='Refresh official landcover even when --offline preserves Sentinel/weather')
    args = parser.parse_args()
    base = json.loads((ROOT / 'data/guwol-data.json').read_text())
    apply_boundary(base, args.cache, args.offline)
    output = ROOT / 'data/research-inputs.json'
    result = {'schemaVersion': 1, 'place': base['place'], 'generatedAt': datetime.now(timezone.utc).isoformat(),
              'grid': grid_metadata(base), 'landsat': landsat_inputs(base)}
    if args.offline:
        previous = json.loads(output.read_text())
        result.update({key: previous[key] for key in ['sentinel2', 'weather']})
        for key in ['ndvi', 'ndbi', 'validFraction']:
            if len(result['sentinel2'].get(key, [])) == len(result['grid']['insideBoundary']):
                result['sentinel2'][key] = [v if inside else (0 if key == 'validFraction' else None)
                    for v, inside in zip(result['sentinel2'][key], result['grid']['insideBoundary'])]
        if result['sentinel2'].get('status') == 'available':
            result['sentinel2']['validCellCount'] = sum(v is not None for v in result['sentinel2']['ndvi'])
    else:
        try:
            result['sentinel2'] = sentinel_inputs(base, args.cache)
        except Exception as error:
            result['sentinel2'] = {'status': 'unavailable', 'reason': str(error), 'ndvi': [], 'ndbi': [],
                                   'source': f'{STAC}/collections/sentinel-2-l2a/items/{SENTINEL_ITEM}'}
        result['weather'] = weather_inputs(base, ['2024-08-29', '2025-06-05'], args.cache)
    result['landcover'] = landcover_inputs(result['grid'], args.landcover,
        cache=args.cache if not args.offline or args.refresh_landcover else None,
        previous=previous.get('landcover') if args.offline and not args.refresh_landcover else None)
    result['validationPolicy'] = {'baselineDate': '2024-08-29', 'heldOutDate': '2025-06-05',
        'trainingUse': 'No per-pixel LST residual correction and no held-out temperature used to initialize/tune the model.',
        'independenceLimit': 'Static land-use/greenness inputs describe 2024; holdout evaluates a new date with that fixed city representation.',
        'unusableSource': 'guwol-history.sceneMaps contains imputed cells and must not be used as independent validation truth.'}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({key: value.get('status') for key, value in result.items() if isinstance(value, dict) and 'status' in value}))


if __name__ == '__main__':
    main()
