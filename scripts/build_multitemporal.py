"""Build a cloud-masked, multi-temporal Landsat summer composite for Guwol-dong.

The browser consumes the compact 24 x 18 output. Source scenes remain traceable by
STAC item id and acquisition date. This script intentionally keeps raw rasters out
of git and stores only reproducible aggregate indicators.
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
GRID_W, GRID_H = 24, 18
COLLECTION = "landsat-c2-l2"
STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
DATA_API = "https://planetarycomputer.microsoft.com/api/data/v1/item/bbox"
USER_AGENT = "UrbanHeatPotentialLab/2.0 educational-research"
YEARS = range(2018, 2026)
TARGET_SCENES = 16
MIN_AOI_VALID = 0.70

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def load_base() -> dict:
    return json.loads((DATA_DIR / "guwol-data.json").read_text(encoding="utf-8"))


def open_url(url: str, *, data: bytes | None = None, timeout: int = 150) -> bytes:
    request = Request(
        url,
        data=data,
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    with urlopen(request, timeout=timeout) as response:
        return response.read()


def search_items(bbox: list[float]) -> list[dict]:
    body = {
        "collections": [COLLECTION],
        "bbox": bbox,
        "datetime": "2018-06-01T00:00:00Z/2025-09-30T23:59:59Z",
        "limit": 1000,
        "query": {"eo:cloud_cover": {"lt": 35}},
    }
    raw = open_url(STAC_SEARCH, data=json.dumps(body).encode("utf-8"), timeout=120)
    features = json.loads(raw).get("features", [])
    return [
        feature for feature in features
        if feature.get("id", "").startswith(("LC08_", "LC09_"))
        and feature.get("id", "").endswith("_T1")
        and datetime.fromisoformat(feature["properties"]["datetime"].replace("Z", "+00:00")).month in (6, 7, 8, 9)
        and feature.get("assets", {}).get("lwir11")
    ]


def choose_candidates(items: list[dict]) -> list[dict]:
    by_year: dict[int, list[dict]] = defaultdict(list)
    for item in items:
        year = int(item["properties"]["datetime"][:4])
        if year in YEARS:
            by_year[year].append(item)
    for values in by_year.values():
        values.sort(key=lambda item: (item["properties"].get("eo:cloud_cover", 100), item["properties"]["datetime"]))

    chosen: list[dict] = []
    # One scene per year first makes the trend less sensitive to a single year.
    for year in YEARS:
        if by_year[year]:
            chosen.append(by_year[year][0])
    rank = 1
    while len(chosen) < TARGET_SCENES:
        added = False
        for year in YEARS:
            if len(by_year[year]) > rank and len(chosen) < TARGET_SCENES:
                chosen.append(by_year[year][rank])
                added = True
        if not added:
            break
        rank += 1
    return chosen


def fetch_asset(item_id: str, bbox: list[float], asset: str, resampling: str = "average") -> np.ndarray:
    bbox_text = ",".join(map(str, bbox))
    url = f"{DATA_API}/{COLLECTION}/items/{item_id}/bbox/{bbox_text}/{GRID_W}x{GRID_H}.tif"
    # The API also accepts the legacy path without /items/. Try the documented
    # endpoint first and retain compatibility with the endpoint used by v1 data.
    params = {
        "assets": asset,
        "asset_as_band": "true",
        "unscale": "false",
        "resampling": resampling,
        "reproject": resampling,
        "return_mask": "false",
    }
    try:
        content = open_url(f"{url}?{urlencode(params)}")
    except HTTPError as error:
        if error.code != 404:
            raise
        url = f"{DATA_API}/{bbox_text}/{GRID_W}x{GRID_H}.tif"
        params.update({"collection": COLLECTION, "item": item_id})
        content = open_url(f"{url}?{urlencode(params)}")
    with Image.open(BytesIO(content)) as image:
        return np.asarray(image).astype(np.float32)


def valid_mask(qa: np.ndarray, thermal_dn: np.ndarray, inside: np.ndarray) -> np.ndarray:
    # QA_PIXEL bits: 0 fill, 1 dilated cloud, 2 cirrus, 3 cloud, 4 cloud shadow.
    rejected = (qa.astype(np.uint16) & sum(1 << bit for bit in range(5))) != 0
    return inside & ~rejected & np.isfinite(thermal_dn) & (thermal_dn >= 293)


def process_scene(item: dict, bbox: list[float], inside: np.ndarray) -> tuple[dict, dict[str, np.ndarray]] | None:
    item_id = item["id"]
    thermal = fetch_asset(item_id, bbox, "lwir11")
    qa = fetch_asset(item_id, bbox, "qa_pixel", "nearest")
    mask = valid_mask(qa, thermal, inside)
    aoi_valid = mask.sum() / max(1, inside.sum())
    if aoi_valid < MIN_AOI_VALID:
        print(f"skip {item_id}: AOI valid {aoi_valid:.1%}", file=sys.stderr)
        return None

    red = fetch_asset(item_id, bbox, "red")
    nir = fetch_asset(item_id, bbox, "nir08")
    swir = fetch_asset(item_id, bbox, "swir16")
    lst = thermal * 0.00341802 + 149.0 - 273.15
    red = red * 0.0000275 - 0.2
    nir = nir * 0.0000275 - 0.2
    swir = swir * 0.0000275 - 0.2
    ndvi = (nir - red) / np.where(np.abs(nir + red) < 1e-6, np.nan, nir + red)
    ndbi = (swir - nir) / np.where(np.abs(swir + nir) < 1e-6, np.nan, swir + nir)
    for values in (lst, ndvi, ndbi):
        values[~mask] = np.nan

    date = item["properties"]["datetime"][:10]
    metadata = {
        "date": date,
        "item": item_id,
        "platform": item["properties"].get("platform", item_id[:4]),
        "sceneCloudPercent": round(float(item["properties"].get("eo:cloud_cover", math.nan)), 2),
        "aoiValidPercent": round(float(aoi_valid * 100), 1),
        "meanLstC": round(float(np.nanmean(lst[inside])), 2),
        "p90LstC": round(float(np.nanpercentile(lst[inside], 90)), 2),
    }
    print(f"accepted {date} {item_id}: {metadata['meanLstC']:.2f} C, valid {aoi_valid:.1%}")
    return metadata, {"lst": lst, "ndvi": ndvi, "ndbi": ndbi}


def linear_trend(anomalies: np.ndarray, years: np.ndarray) -> np.ndarray:
    output = np.full((GRID_H, GRID_W), np.nan, dtype=np.float32)
    for y in range(GRID_H):
        for x in range(GRID_W):
            values = anomalies[:, y, x]
            valid = np.isfinite(values)
            if valid.sum() >= 4:
                centered_years = years[valid] - years[valid].mean()
                output[y, x] = np.sum(centered_years * values[valid]) / max(1e-9, np.sum(centered_years ** 2))
    return output


def round_flat(values: np.ndarray, digits: int = 2, fill: float = 0.0) -> list[float]:
    return np.round(np.nan_to_num(values, nan=fill), digits).reshape(-1).tolist()


def build() -> dict:
    base = load_base()
    bbox = base["bbox"]
    inside = np.asarray(base["surface"]["insideBoundary"], dtype=bool).reshape(GRID_H, GRID_W)
    items = search_items(bbox)
    candidates = choose_candidates(items)
    print(f"STAC candidates: {len(items)}; selected: {len(candidates)}")

    scenes: list[dict] = []
    arrays: list[dict[str, np.ndarray]] = []
    for item in candidates:
        processed = process_scene(item, bbox, inside)
        if processed:
            metadata, values = processed
            scenes.append(metadata)
            arrays.append(values)

    if len(scenes) < 6:
        raise RuntimeError(f"Only {len(scenes)} usable scenes; at least 6 are required")
    order = np.argsort([scene["date"] for scene in scenes])
    scenes = [scenes[i] for i in order]
    arrays = [arrays[i] for i in order]
    lst = np.stack([entry["lst"] for entry in arrays])
    ndvi = np.stack([entry["ndvi"] for entry in arrays])
    ndbi = np.stack([entry["ndbi"] for entry in arrays])
    scene_means = np.nanmean(lst[:, inside], axis=1)
    anomalies = lst - scene_means[:, None, None]
    years = np.asarray([
        datetime.fromisoformat(scene["date"]).year + (datetime.fromisoformat(scene["date"]).timetuple().tm_yday - 1) / 365.25
        for scene in scenes
    ])
    hot = np.zeros_like(lst, dtype=np.float32)
    for index in range(len(scenes)):
        threshold = np.nanpercentile(lst[index][inside], 80)
        hot[index] = np.where(np.isfinite(lst[index]), lst[index] >= threshold, np.nan)

    metrics = {
        "meanLstC": round_flat(np.nanmean(lst, axis=0)),
        "p90LstC": round_flat(np.nanpercentile(lst, 90, axis=0)),
        "stdLstC": round_flat(np.nanstd(lst, axis=0)),
        "meanAnomalyC": round_flat(np.nanmean(anomalies, axis=0)),
        "hotFrequencyPercent": round_flat(np.nanmean(hot, axis=0) * 100, 1),
        "trendCPerYear": round_flat(linear_trend(anomalies, years), 3),
        "medianNdvi": round_flat(np.nanmedian(ndvi, axis=0), 3),
        "medianNdbi": round_flat(np.nanmedian(ndbi, axis=0), 3),
        "validSceneCount": np.sum(np.isfinite(lst), axis=0).astype(int).reshape(-1).tolist(),
    }
    inside_mean = lambda values: float(np.nanmean(np.asarray(values).reshape(GRID_H, GRID_W)[inside]))
    return {
        "schemaVersion": 1,
        "place": base["place"],
        "period": f"{scenes[0]['date']}–{scenes[-1]['date']} 여름철(6–9월)",
        "method": "Landsat 8/9 Collection 2 Level-2; QA_PIXEL 구름·권운·그림자 제거; 장면별 상위 20% 반복 고온 및 장면 평균 대비 편차",
        "sceneCount": len(scenes),
        "scenes": scenes,
        "summary": {
            "meanLstC": round(inside_mean(metrics["meanLstC"]), 2),
            "meanP90LstC": round(inside_mean(metrics["p90LstC"]), 2),
            "meanHotFrequencyPercent": round(inside_mean(metrics["hotFrequencyPercent"]), 1),
            "meanTrendCPerYear": round(inside_mean(metrics["trendCPerYear"]), 3),
        },
        "metrics": metrics,
        "sceneMaps": {
            "lstC": [round_flat(values, 2, float(np.nanmean(values[inside]))) for values in lst],
            "note": "구름·그림자로 빠진 셀은 해당 장면의 구월동 평균으로 중립 채움했습니다. 장면별 유효비율은 scenes.aoiValidPercent를 확인하세요.",
        },
        "provenance": {
            "source": "USGS Landsat Collection 2 Level-2 via Microsoft Planetary Computer",
            "stac": "https://planetarycomputer.microsoft.com/api/stac/v1",
            "usgsDocumentation": "https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "limitations": [
            "장면별 촬영시각은 약 11:10 KST이며 지표면온도(LST)는 1.5 m 대기온도가 아닙니다.",
            "열 추세는 기상 정규화된 장기 기후 추세가 아니라 장면 평균 대비 공간 편차의 선형 변화입니다.",
            "24×18 격자 합성은 원래 30 m 픽셀을 구월동 설계 셀로 집계한 탐색용 지표입니다.",
        ],
    }


def main() -> None:
    dataset = build()
    json_text = json.dumps(dataset, ensure_ascii=False, indent=2)
    (DATA_DIR / "guwol-history.json").write_text(json_text, encoding="utf-8")
    compact = json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))
    (DATA_DIR / "guwol-history.js").write_text(f"export const GUWOL_HISTORY = {compact};\n", encoding="utf-8")
    print(json.dumps({"sceneCount": dataset["sceneCount"], "period": dataset["period"], "summary": dataset["summary"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
