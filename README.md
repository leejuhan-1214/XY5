# 구월동 관측 지도 · v4

[배포 사이트](https://leejuhan-1214.github.io/XY5/)

실제 도로·건물 지도 위에서 Landsat 지표면 온도를 확인합니다. 날짜 선택, 온도 표시, 위치 선택, 2D/3D 전환만 남긴 전체 화면 UI입니다. 가상 기상, 냉각 시나리오, AI 최적화 결과와 모델 기반 수치를 현재 화면에서 제거했습니다.

## 실제 자료와 해석

- **위성 지표면 온도**: USGS Landsat Collection 2 Level-2 ST. 2024-06-02, 2024-08-29, 2025-06-05 촬영 장면을 Microsoft Planetary Computer에서 2026-09-22 다시 수집했습니다. 실시간 기온이 아닙니다.
- **변환**: `ST_B10 DN × 0.00341802 + 149 − 273.15`. 동일 범위의 온도와 QA_PIXEL을 각각 최근접 재표본화했습니다. QA bits 0–5(결측·팽창 구름·권운·구름·그림자·눈) 및 유효하지 않은 온도 DN을 제외합니다. 제외된 값은 `null`로 유지하며 평균값이나 모델값을 채우지 않습니다.
- **해상도**: 96×108 표시 격자(약 27×28m). 원래 열적 해상도는 약 100m이고 제품은 30m 격자로 제공됩니다. 표시 격자 간격이 실제 관측 해상도를 개선하지 않으며 개별 건물 온도를 의미하지 않습니다.
- **건물**: OSM 읽기 API의 소지역 추출물에서 닫힌 building way 1,551개를 확보했습니다. 397개의 명시적 `height` 태그만 m 단위로 입체 표시합니다. 층수를 높이로 환산하거나 미등록 높이를 만들지 않습니다. 관계형 건물 등은 배경지도에 평면으로 남을 수 있으며 완전한 건축물대장이 아닙니다. OSM 등록값은 현장 실측 여부를 보증하지 않습니다.
- **공간 범위**: `[126.6925639,37.4340681,126.7218288,37.4610653]`. 점선은 구월동 일대의 직사각형 추출 범위이며 행정구역 경계가 아닙니다.
- 날짜별 기상 조건이 다르므로 3개 장면의 온도 차이는 장기 기후 추세나 정책 효과의 증거가 아닙니다. 기본 범례는 날짜 간 동일하며 24°C 미만/50°C 초과는 끝 색으로 표시합니다. 수치는 원래 값으로 표시합니다.

## 출처와 재현

`data/observations.json`에 장면 ID, 촬영 UTC 시각, STAC 원문 URL, 자산 요청 URL, 원본 TIFF SHA-256 및 결측을 보존한 값을 저장합니다. `data/buildings.geojson`은 OSM 객체 ID, 원래 높이 태그, 최종 수정 시각과 수집 출처를 포함합니다. 개인정보인 편집자 계정 정보는 포함하지 않습니다.

```sh
# numpy, Pillow 필요. 캐시 경로는 저장소 밖을 권장합니다.
python scripts/build_observations.py ../real-inputs
# 공식 OSM map.json 추출물을 내려받은 후:
node scripts/build_buildings.mjs ../real-inputs/osm-map.json
```

- [USGS Surface Temperature 제품 설명](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature)
- [Planetary Computer Landsat Collection 2](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2)
- [OSM 원자료 추출 URL](https://api.openstreetmap.org/api/0.6/map.json?bbox=126.6925639,37.4340681,126.7218288,37.4610653)
- [OpenStreetMap height 태그](https://wiki.openstreetmap.org/wiki/Key:height)
- [OpenFreeMap](https://openfreemap.org/) · [© OpenStreetMap contributors / ODbL](https://www.openstreetmap.org/copyright)

## 실행과 검증

정적 사이트이므로 루트 디렉터리를 HTTP 서버로 제공하면 됩니다. MapLibre GL JS는 저장소에 포함되어 있고 배경 타일·글꼴에는 네트워크 연결이 필요합니다.

```sh
npm start
npm test
```

현재 진입점은 `index.html` → `src/observed-app.js`입니다. 이전 모델 소스와 테스트는 이력 및 회귀 검증을 위해 보존했지만 현재 앱은 불러오지 않습니다. 관측자료 테스트는 결측 유지, 범위 밖 좌표, 실데이터 출처, 명시적 높이, 건물 지상 위치의 온도 대응을 검증합니다. GitHub Actions가 main 변경 시 테스트 후 GitHub Pages를 배포합니다.

지도 엔진: MapLibre GL JS 5.6.2 (BSD-3-Clause, `src/vendor/MAPLIBRE-LICENSE.txt`). 소스코드 MIT와 별도로 OSM 데이터에는 ODbL이 적용됩니다.
