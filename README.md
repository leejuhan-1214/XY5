# 위성 온도 지도 · v6

[배포 사이트](https://leejuhan-1214.github.io/XY5/)

지도를 이동·확대·회전하면 **현재 화면 전체의 실제 위성 자료를 새로 가져와 분석**합니다. 구월동 고정 사각형을 제거했습니다. 구월동은 초기 위치일 뿐이며 다른 지역으로 자유롭게 이동할 수 있습니다. 광역 이동을 위해 지도는 줌 3까지 축소되며, 실제 분석은 지역 규모인 줌 8 이상에서 실행합니다. 페이지는 PC와 모바일에서 스크롤 없이 지도와 핵심 정보를 표시합니다.

## 화면에 따라 바뀌는 관측자료

- 이동 중에는 이전 위치의 온도 표시와 통계를 비웁니다. 이동이 멈춘 뒤 450ms 후 현재 지도 경계로 STAC 검색과 온도/QA 요청을 수행합니다.
- 기준일 ±32일, 장면 구름 비율 80% 미만의 Landsat 8/9 Level-2 Surface Temperature 후보를 최대 100개 조회하고 날짜가 가까운 순서로 최대 4개 장면을 처리합니다. 현재 화면에서 먼저 확보한 유효 관측은 유지하고 빈 화소에만 다른 실제 촬영의 유효 관측을 연결합니다. 검색 한도·구름·원자료 결측으로 전체 화면의 관측이 확보되지 않을 수 있습니다.
- 화소별 원래 장면 ID와 촬영일을 보존합니다. 위치를 누르면 해당 화소의 촬영일이 표시되며 자료 출처에서 사용한 STAC 장면을 열 수 있습니다. 여러 촬영일이 섞인 화면은 하나의 순간을 촬영한 영상이 아닙니다.
- `DN × 0.00341802 + 149 − 273.15`로 지표면 온도를 °C로 변환합니다. QA_PIXEL bits 0–5(결측·팽창 구름·권운·구름·그림자·눈)와 원자료 마스크를 적용합니다. 관측이 없는 화소는 `null`/투명으로 남기며 추정값을 채우지 않습니다.
- 지도와 같은 EPSG:3857 투영의 최대 256×256 화면 격자로 온도와 QA를 동일하게 최근접 재표본화합니다. 열적 원해상도는 약 100m이며 확대 수준에 따라 표시 격자 간격이 달라집니다. 기온이나 개별 건물 측정값이 아닙니다.
- 평균·최저·최고와 유효 관측 비율은 실제 화면에 투영되는 표본만 계산합니다. 날짜·지역별 비교의 혼동을 줄이기 위해 색상 범례는 24–50°C로 고정하며 범위 밖은 끝 색으로 표시합니다. 수치는 잘라내지 않습니다.
- 빠른 연속 이동 시 이전 요청을 취소하고, 취소가 늦게 끝나도 요청 순서를 검사해 이전 위치의 결과가 덮어쓰지 못하게 합니다. 최근 6개 화면은 메모리에 캐시합니다. 연결 실패 시 이전 위치 값을 재사용하지 않고 재시도 버튼을 제공합니다.

## 실제 지도와 3D

배경 도로와 평면 건물은 OpenFreeMap/OpenStreetMap의 전 세계 지도입니다. 지도 이동 후 현재 화면의 OSM `height` 태그가 있는 건물과 건물 부분을 Overpass API에서 자동 조회합니다. 구월동 고정 파일을 사용하지 않으며 어느 지역이든 같은 방식으로 동작합니다.

- 등록된 m 높이를 그대로 사용하며 ft 표기는 정확한 단위 변환만 합니다. 층수 환산, 제공자의 `render_height`, 기본 높이를 사용하지 않습니다. 높이가 없는 건물은 평면으로 표시합니다. OSM 등록값은 현장 실측 여부를 보증하지 않습니다.
- 닫힌 way와 multipolygon relation을 지원하고 안뜰을 보존합니다. 형상이 불완전하거나 높이 값이 불명확한 객체는 입체로 만들지 않습니다.
- 줌 13 이상, 화면 외접 범위 160km² 이하에서 조회합니다. 이동 후 900ms를 기다리고 요청 간 최소 4.5초를 두며 최근 8개 화면을 캐시합니다. 서버 실패 시 공개 보조 서버를 사용하고 429 제한 응답에는 서버 전환을 하지 않습니다.
- 건물을 누르면 등록 높이와 원래 way/relation의 OSM 링크를 확인할 수 있습니다. 위성 온도는 해당 건물 지상 형상 안의 위치에서 조회합니다.

지도 오른쪽 위 **⛶ 전체 화면** 버튼은 전체 화면에 진입하고 같은 버튼 또는 Esc로 종료합니다. 전체 화면 API를 지원하지 않는 내장/모바일 브라우저에서는 지도만 창 전체로 확대하는 대체 화면을 제공합니다. 전환 후 지도 크기와 분석 범위도 갱신됩니다. 현재 지도 위치는 URL 해시에 저장됩니다.

## 출처와 구현

- [USGS Landsat Collection 2 Surface Temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature)
- [Microsoft Planetary Computer Landsat](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2)
- [STAC 검색 API](https://planetarycomputer.microsoft.com/api/stac/v1/docs)
- [범위별 온도·QA 데이터 API](https://planetarycomputer.microsoft.com/api/data/v1/docs)
- [OpenFreeMap](https://openfreemap.org/) · [© OpenStreetMap contributors / ODbL](https://www.openstreetmap.org/copyright)
- [Overpass API 및 공개 조회 서버](https://wiki.openstreetmap.org/wiki/Overpass_API)

현재 진입점은 `index.html` → `src/observed-app.js`이며 `src/viewport-data.js`가 화면 범위, NPY 원자료 해석, QA, 날짜별 관측 연결을 담당합니다. `src/live-buildings.js`는 전 지역 등록 높이 조회, `src/fullscreen.js`는 전체 화면을 담당합니다. GitHub Pages에서 브라우저가 공개 CORS API를 직접 호출하며 API 키나 서버는 필요하지 않습니다. 지도·건물·위성 API에는 인터넷 연결이 필요합니다.

`data/observations.json`과 `scripts/build_observations.py`는 v4에서 재현 가능한 고정 범위 자료를 보관한 기록이며 **현재 화면의 온도 소스로 사용하지 않습니다**. 이전 시뮬레이션 모듈도 현재 앱이 불러오지 않습니다. `data/buildings.geojson`도 이전 버전의 기록으로만 보존하며 현재 3D 레이어가 불러오지 않습니다.

```sh
npm start
npm test
```

테스트는 원자료 출처, 결측 유지, 등록 높이, 화면 범위 변경, NPY/QA 판독, 날짜별 관측 우선순위와 빈 검색 결과를 검증합니다. GitHub Actions가 main 변경 시 테스트 후 Pages에 배포합니다. MapLibre GL JS 5.6.2는 BSD-3-Clause이며 소스코드 MIT와 별도로 OSM 데이터에는 ODbL이 적용됩니다.
