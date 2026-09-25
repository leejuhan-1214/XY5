# XY5 — 실제 지도 기반 도시 열환경 탐색

XY5는 실제 지도 위에 위성 지표면 온도와 높이가 등록된 건물을 함께 표시해 도시 열환경을 살펴보는 웹 앱이다. [배포된 사이트](https://leejuhan-1214.github.io/XY5/)는 별도 서버 없이 GitHub Pages에서 실행된다. 이 문서는 다음 개발자나 Claude가 **현재 해결하려는 문제, 데이터의 의미, 구현 범위와 한계, 수정 지점**을 혼동하지 않도록 작성했다.

## 지금 해결하려는 문제

이 프로젝트의 출발점은 다음 세 가지 연구 질문이다.

1. 도시의 공간 구조와 지표 특성에 따라 열이 어디에 축적되고, 어떻게 확산·이동하는가?
2. 도시 열환경을 모델링했을 때 고온 지역의 분포와 열 이동 양상이 실제 자료와 어느 정도 일치하는가?
3. 제한된 범위에서 열섬 저감 요소의 위치와 배치를 어떻게 조정해야 효과적인가?

현재 사이트는 **첫 단계인 실제 관측 자료의 공간적 탐색**과 **두 번째 질문을 위한 첫 지점 단위 비교**를 구현했다. 사용자가 지도를 이동하면 현재 화면을 대상으로 Landsat 지표면 온도를 요청하고, 실제 OSM 높이 태그가 있는 건물을 3D로 표시한다. 화면 안 온도 분포(히스토그램)와 자료 품질을 함께 보여 주고, 지점 클릭으로 해당 위성 화소의 온도와 촬영일을 확인할 수 있다. 같은 지도에서 지면·지붕 재료를 바꾸는 시나리오를 **정상상태 표면 에너지수지 모델**로 계산하고, 그 지점의 **실제 촬영 시각 기상**으로 계산한 모델값을 위성 관측값과 나란히 비교할 수 있다.

다만 위 세 질문에 대한 과학적 답을 완성한 상태는 아니다. 지도 색은 관측 위성 영상이며, 시간에 따른 열의 이동을 계산한 결과가 아니다. 재료 모델의 °C는 가정한 재료 계수와 격자형 기상 추정값으로 푼 **모델 평형 표면온도**이지, 관측값이나 미래 온도 예측이 아니다. 모델–관측 비교는 한 화소 한 시각의 참고값이며 검증(여러 지점·시기의 MAE/RMSE)이 아니다. 최적 배치 계산도 아직 없다. 화면과 문서에서 이 구분을 유지해야 한다.

### 연구 질문별 현황과 다음 과제

| 연구 질문 | 현재 가능한 일 | 아직 해결되지 않은 부분 |
| --- | --- | --- |
| 열 축적·확산·이동 | 화면 내 실제 지표면 온도 분포(히스토그램·화면 맞춤 색 범위)와 높이 등록 건물의 위치를 함께 관찰 | 풍향·풍속, 일사·그늘, 지형, 재료·토양수분, 시간 변화 등을 포함한 열수지/이류·확산 모델이 없다. 지도 애니메이션을 열 이동의 증거로 해석하면 안 된다. |
| 모델과 실제 자료의 일치 | 선택 지점에서 촬영 시각 기상으로 푼 재료 모델 온도와 관측 LST의 차이(모델 − 관측)를 표시 | 화면 전체의 독립 예측 온도장이 없다(화소별 재료 분류가 없음). 여러 지점·시기의 MAE/RMSE, 공간 패턴 일치도, 현장 측정과의 비교가 필요하다. |
| 저감 요소의 최적 배치 | 선택한 한 지면 또는 지붕의 재료를 바꿨을 때 모델 평형 표면온도 변화(°C)와 에너지 유입 변화(W/m²)를 표시 | 복수 위치·면적의 배치, 예산·면적 제약, 주변으로 퍼지는 효과, 최적화 목적함수가 구현되지 않았다. 원의 반경은 시각화 범위이며 단위면적 결과는 바뀌지 않는다. |

**우선순위가 높은 실제 문제**는 관측 시점이 장소마다 다를 수 있다는 점, 결측/구름 때문에 화면 전체에 값이 없을 수 있다는 점, OSM 높이 태그가 없는 건물은 3D로 나타나지 않는다는 점(화면에 등록 비율을 표시한다), 재료의 실제 현장 상태를 알 수 없다는 점이다. 위성 지표면 온도와 사람이 체감하는 높이의 기온도 서로 다른 변수다. 연구용 결과를 주장하려면 이 문제를 먼저 다루고 출처·불확실성을 함께 보여줘야 한다.

## 사용자 요구사항과 현재 동작

- 모식도가 아닌 실제 지도를 바탕으로 하고, 특정 사각형 지역에 고정하지 않는다. 이동·확대·축소한 **현재 화면**의 관측 범위를 다시 요청한다. 이동 중에는 이미 받은 온도 영상을 지우지 않고(지리 좌표에 고정되어 있으므로) 그대로 둔 채 통계만 흐리게 표시한다.
- 지도에 등록된 높이가 있는 건물만 모든 지원 지역에서 3D로 나타낸다. 높이를 층수로 추정하거나 임의 높이를 채우지 않는다.
- 밝은 지도와 간결한 UI를 사용한다. 데스크톱은 왼쪽 패널 + 지도, 휴대폰은 지도 우선 + 아래쪽 시트로 배치한다. 전체 화면 버튼도 있다.
- 분석 기준일의 기본값은 사용자의 현재 날짜다. 이는 **자료 검색 기준일**이며 측정일과 같다는 뜻이 아니다. 각 픽셀에 실제로 사용한 위성 촬영일을 별도로 표시하고, 기준일과 7일 넘게 차이 나면 품질 메모로 알린다.
- 온도 색 범위의 기본값은 **화면에 맞춤**(현재 화면 유효 화소의 2~98 백분위)이다. 장소 간 비교에는 **고정 24–50°C**로 바꾼다. 두 모드 모두 범위 밖 값은 양 끝 색에 합쳐지며 범례에 ≤/≥로 표기한다.
- 관측 패널을 접어도 지도 클릭 온도를 볼 수 있도록 간단한 온도 카드가 남는다.
- 지면·지붕 재료 비교는 이전 별도 사이트로 이동하지 않고 현재 지도에서 실행한다.

## 데이터: 실제값, 등록 정보, 가정값

| 화면 요소 | 출처와 의미 | 주의점 |
| --- | --- | --- |
| 온도 색 지도·클릭 온도·분포 | Microsoft Planetary Computer의 Landsat 8/9 Collection 2 Level-2 지표면 온도 열 밴드에서 계산한 **촬영 시점의 지표면 온도(LST, °C)** | 현재 실시간 기온이 아니다. 열 적외선 원 해상도는 약 100m이며 제품은 30m 격자로 재표본되어 있다. 구름·품질 마스크에 걸린 곳은 결측이며 여러 장면을 합치면 픽셀마다 촬영일이 다를 수 있다. 화면을 확대해도 측정 해상도가 높아지지 않는다. |
| 배경 지도·3D 건물 | OpenFreeMap(positron 스타일)의 OSM 기반 지도와 Overpass에서 받은 OSM 건물 형상 및 `height` 태그 | 참여자가 등록한 지리정보다. 모든 건물에 높이가 있지 않고(화면에 "높이 등록 N / 전체 M채"로 표시) 등록값의 현장 정확도도 보증되지 않는다. |
| 재료 모델 조건(기상) | 선택 화소의 실제 촬영 시각에 맞춰 보간한 Open-Meteo 재분석(ERA5 기반)·예보 분석의 기온, 상대습도, 10m 풍속, 순간 일사량 | 약 10~25km 격자형 추정값이며 현장 관측이 아니다. 위성 관측이 없는 지점은 가정값(일사 800 W/m², 기온 30°C, 습도 60%, 풍속 2 m/s)을 쓰고 화면에 그렇게 표시한다. |
| 재료 변경 시나리오 | 코드에 둔 재료 반사율·방사율·전도·증발 계수와 위 조건 | 관측 온도도 예측 온도도 아니다. 재료의 실제 현장 상태를 측정하지 않았다. 결과는 모델 평형 표면온도(°C)와 에너지 유입 차이(W/m²)다. |

지도에서 관측 온도와 재료 계산 결과를 같은 색 또는 같은 변수처럼 취급하지 말 것. 재료 모델의 °C는 에너지수지를 푼 **모델값**이며 `-360 W/m²` 같은 에너지 차이를 단순히 °C로 환산한 것이 아니다. 지붕 아래 실내 온도, 보행자 기온, 체감 온도도 이 앱에서 측정하지 않는다.

## 빠른 실행과 배포

정적 HTML/CSS/JavaScript ES 모듈 프로젝트다. 테스트는 Node.js 22 이상(`node --test`)을 기준으로 하며 npm 패키지 설치가 필요하지 않다.

```bash
python -m http.server 8000
# 브라우저에서 http://localhost:8000/
```

`npm start`도 가능하지만 내부적으로 `npx serve .`를 실행하므로 로컬 환경에 따라 serve 설치/다운로드가 필요할 수 있다. `file://`로 직접 열면 ES 모듈이나 외부 요청이 동작하지 않을 수 있다. 지도·위성·건물·기상 데이터는 실행 중 외부 서비스에 요청하므로 네트워크가 필요하다. 주소에 `?debug`를 붙이면 브라우저 콘솔에서 `xy5`로 앱 상태를 볼 수 있다.

```bash
npm test
```

`.github/workflows/pages.yml`은 풀 리퀘스트마다 테스트를 실행하고, `main`에 푸시하거나 수동 실행하면 테스트 통과 후 GitHub Pages에 배포한다. 배포물은 런타임 파일만 모은 `_site`이며 `tests/`, `scripts/`, `python/`, `.github/`, 중복 사본 `urban-heat-potential-lab/`, 테스트 전용 `data/observations.json`·`data/buildings.geojson`은 제외한다(이전 `simulator.html`은 계속 열린다). 작업 전 `git status`와 배포 브랜치를 확인하고, 변경 후 테스트·브라우저 검증·Pages 실행 결과를 확인할 것.

## 파일 구조: 어디를 수정해야 하나

| 파일 | 역할 |
| --- | --- |
| `index.html` | 현재 서비스의 DOM(상단 모드 전환, 관측/재료 패널, 지도 오버레이, 출처 대화상자)과 스크립트 진입점 |
| `src/observed-app.js` | 지도·UI 상태, 화면 이동 시 데이터 재사용/요청, 가시 영역 통계·히스토그램·범례, 클릭 정보, 재료 모드와 전체 화면 연결 |
| `src/viewport-data.js` | 요청 격자 크기, Landsat STAC 검색·장면 순위, 병렬 NPY 수신, 품질 마스크, 온도 변환과 장면 합성 |
| `src/observed-data.js` | 투영 좌표, 관측 통계·백분위·히스토그램, 온도 색 램프, OSM 높이 파서 등 순수 계산 |
| `src/live-buildings.js` | Overpass 조회(서버 순서·예비 서버), OSM 형상·높이 파싱, 높이 등록 비율 집계, 3D 건물 피처 생성 |
| `src/weather.js` | 촬영 시각 기상(Open-Meteo) 조회와 시간 보간 |
| `src/footprint.js` | 건물 다각형과 클릭 지점의 공간 판정 |
| `src/materials.js` | 재료별 계수와 이름 |
| `src/material-scenario.js` | 재료 비교 에너지 산식, 정상상태 표면 에너지수지 풀이, 지면 원형 영역 |
| `src/fullscreen.js` | 전체 화면 전환 보조 |
| `src/observed.css` | 현재 UI 전체(밝은 테마, 휴대폰 아래쪽 시트 포함). 열 색은 데이터 전용이고 UI 강조색은 초록 계열이다. |
| `tests/test_*.mjs` | 관측값·장면 순위·병렬 합성·건물·기상·재료 모델·UI 보조 로직의 회귀 테스트 |
| `.github/workflows/pages.yml` | PR 테스트, 테스트 후 런타임 파일만 Pages 배포 |

`simulator.html`, `src/app.js`, `src/engine.js`, `src/atlas*`, `data/guwol*`, `data/observations.json`, `data/buildings.geojson` 등은 이전 구월동 교육용 시뮬레이터 관련 파일이다. **현재 `index.html`의 실시간 화면 관측 파이프라인이 아니다.** `urban-heat-potential-lab/`은 더 이전 버전의 사본이며 배포하지 않는다. 기존 자료가 현재 화면의 온도 측정값이나 검증된 예측 결과인 것처럼 연결하지 말 것. 과거 구현을 수정할 때는 현재 서비스와의 관계를 먼저 정해야 한다.

## 현재 지도와 관측 파이프라인

`src/observed-app.js`는 OpenFreeMap `https://tiles.openfreemap.org/styles/positron`(열 색이 잘 보이는 저채도 밝은 지도)을 사용한다. 초기 중심은 경도 126.7065, 위도 37.4479, 줌 15.35, 피치 55°, 방위 -24°이며 URL 해시로 카메라 상태가 저장된다. 줌 8 미만에서는 관측 요청을 하지 않는다.

**요청과 재사용.** 이동이 끝나고 약 450ms 뒤, 이미 받은 합성 영상 중 **현재 화면을 완전히 덮고 해상도가 충분한 것**(요구 격자 간격의 1.6배 또는 45m 이하)이 있으면 네트워크 없이 그 영상으로 통계만 다시 계산한다. 없으면 화면 경계를 **사방 20% 넓혀** 요청하므로 작은 이동, 패널 접기, 창 크기 변경, 확대는 보통 재요청 없이 처리된다. 새 요청이 생기면 이전 요청은 `AbortController`와 요청 번호로 무효화한다. 유효 장면이 있고 실패가 없는 결과만 최대 6개 기억하며, 빈 결과나 일부 실패 결과는 기억하지 않아 다시 시도하면 실제로 재요청한다. 기준일을 바꾸면 기존 영상을 지우고 즉시 다시 요청한다.

**격자.** `src/viewport-data.js`의 `frameFor`는 화면 경계를 Web Mercator(EPSG:3857)로 바꾸고, 지면 거리 기준 **30m 간격**(제품 격자)을 목표로 긴 변 48~256픽셀의 요청 격자를 만든다. 크게 확대하면 요청이 작아지고, 넓은 화면에서는 256픽셀 상한 때문에 격자가 30m보다 거칠어진다.

**장면 검색과 순위.** Microsoft Planetary Computer STAC에서 `landsat-c2-l2`를 분석 기준일 전후 32일 범위로 찾고, 장면 구름 비율 80% 미만, 최대 100개를 받은 후 Landsat 8/9 `L2SP`와 열 밴드·`QA_PIXEL`이 있는 장면을 고른다. 순위 점수는 `기준일과의 거리(일) + 장면 구름 비율(%) × 0.1`이다. 구름 10%포인트가 하루 차이와 같게 취급되므로, 어제 찍힌 구름 79% 장면보다 나흘 전의 구름 5% 장면이 앞선다. 이는 가능한 장면을 찾는 정책이지 당일 관측을 보장하는 정책이 아니다.

**수신과 합성.** 상위 최대 4개 장면을 **동시에** 요청하되, 도착 순서와 무관하게 **순위 순서대로** 합성한다. 앞 장면의 유효 픽셀을 보존하고 뒤 장면으로 결측만 채우며, 각 픽셀의 실제 장면 촬영일을 추적한다. 화면의 99.5%가 채워지면 남은 요청을 취소한다. 받지 못한 장면 수(`failedScenes`), 검색 결과가 100개를 넘어 잘렸는지(`partialSearch`), 후보 장면 수는 화면의 "자료 품질"과 출처 대화상자에 표시한다.

자료 응답은 열 밴드, 품질 비트, 유효 마스크로 구성된 uint16 NPY다. 유효 조건은 마스크 `> 0`, 열 DN `>= 293`, 그리고 `clearPixel(QA_PIXEL)`이다. `clearPixel`은 비트 0~5(채움·확장 구름·권운·구름·구름 그림자·눈)가 모두 0이고, **구름 신뢰도(비트 8~9)가 중간 미만**, **권운 신뢰도(비트 14~15)가 높음 미만**일 때만 참이다. 얇은 구름은 구름 비트 없이 중간 신뢰도로만 표시되는 경우가 많아, 이를 거르지 않으면 지표면 온도가 낮게 편향된다. 유효 DN을 다음 식으로 바꾼다.

```text
LST(°C) = DN × 0.00341802 + 149 − 273.15
```

결측 픽셀은 `null`로 남긴다. 래스터를 캔버스로 그려 지도 위에 기본 65% 불투명도(패널에서 20~90% 조절)로 올린다. 색 램프는 **단일 색상(주황 계열, OKLCH 색상각 약 45°)의 밝기 단조 순차 램프** 8단계(`TEMPERATURE_RAMP`)로, 낮은 값은 밝은 지도 쪽으로 물러나고 높은 값이 가장 진하게 보인다. 밝기가 단조롭기 때문에 색각 이상에서도 순서가 읽힌다(이전의 파랑→빨강 무지개형 대체). 통계와 히스토그램은 지도 화면(기울였을 때는 사다리꼴) 안에 중심이 들어오는 유효 화소에 대한 값이지 도시 전체의 대표 온도가 아니다.

## 건물 3D와 클릭 동작

배경 지도 건물 레이어 대신 Overpass에서 실제 `building`/`building:part` 형상과 `height` 태그를 조회한다. 같은 요청에서 조회 범위의 **전체 건물 수**(`out count`)도 받아, 높이가 등록된 건물(부분 제외) 비율을 "3D 높이 등록 N / M채 (x%)"로 표시한다. `height`는 미터 또는 피트로 명시된 값만 변환한다. `building:levels`에서 층고를 임의 추정하지 않는다. 닫힌 다각형과 멀티폴리곤의 내부 빈 공간도 처리한다. 3D 요청은 줌 13 이상, 조회 영역 160 km² 이하에서만 수행한다.

서버는 `overpass-api.de`(공식 주 서버) → `overpass.private.coffee` → `overpass.kumi.systems` 순서로 시도하고 서버당 22초 제한을 둔다. 오류 응답이나 JSON이 아닌 혼잡 안내 페이지는 다음 서버로 넘기지만, **429(요청 제한)는 다른 서버로 우회하지 않는다.** 요청 간격을 두고 제한적으로 캐시한다. 서버가 모두 느리거나 오류를 내면 건물이 일시적으로 나타나지 않을 수 있으며 재시도 버튼이 나온다. 높이 태그가 없는 건물은 3D로 보이지 않는 것이 현재 정책이다.

지도 소스·레이어 이름은 `recorded-buildings`, `building-footprints`, `recorded-heights`다. 건물 클릭은 건물 형상을 찾는 데 쓰이지만 표시하는 온도는 **건물 자체를 측정한 온도**가 아니라 그 위치에 대응되는 Landsat 지표면 픽셀 값이다. 관측 패널이 닫힌 경우에도 이 값을 간단한 카드에서 확인할 수 있어야 한다.

## 재료 변경 모드의 정확한 의미

현재 지도에서 재료 모드를 켜면 하나의 지면 지점이나 높이 등록 건물 지붕을 선택한다. 지면은 반경 10~100m의 원형 영역으로 표시하고, 지붕은 OSM 건물 형상 위의 얇은 층으로 표시한다. 기본 비교는 지면의 아스팔트→차열 포장, 지붕의 어두운 지붕→밝은 페인트다. 실제 기존 재료를 판독한 것이 아니므로 UI에도 **가정한 기존 재료**라고 표기한다.

계산은 `src/material-scenario.js`의 두 가지 단순 모델이다.

**1. 에너지 유입 차이(W/m², 이전과 같음).** 일사량 `I`, 수분 계수 `m = 0.4`에서 재료별 반사율 `α`와 증발 항을 이용한다.

```text
energy(material) = (1 − α) × I − evaporation × m
difference = energy(proposed) − energy(baseline)   [W/m²]
```

**2. 모델 평형 표면온도(°C).** 정상상태 표면 에너지수지를 이분법으로 풀어 표면온도 `Ts`를 구한다.

```text
(1 − α)·I + ε·L↓ = ε·σ·Ts⁴ + h·(Ts − Ta) + k·(Ts − Ta) + evaporation × m
L↓ = 1.24·(e_a / Ta)^(1/7)·σ·Ta⁴      (Brutsaert 맑은 하늘 대기 장파, e_a는 수증기압 hPa)
h  = 5.7 + 3.8·U                       (McAdams 대류 계수, U는 10m 풍속 m/s)
k  = 재료 전도 계수                      (기층 온도를 기온으로 가정)
```

조건(`I`, `Ta`, 습도, `U`)은 선택 화소의 **실제 촬영 시각**에 맞춰 Open-Meteo에서 보간한 값을 쓰고(`src/weather.js`), 관측이 없거나 기상 조회에 실패하면 가정값을 쓴다. 어느 쪽인지 화면에 표시한다. 기상 조건으로 계산한 경우에만 같은 화소의 위성 LST와 "모델 − 관측" 차이를 보여 준다. 이 차이는 한 화소(원 해상도 약 100m, 여러 재료 혼합)·한 시각의 참고값이다.

이 모델은 열 저장(시간 변화), 그늘, 바람길, 주변 표면·건물 벽의 복사 교환, 인공열을 풀지 않는다. 재료표의 증발 잠재량은 모델 가정이라 식생의 증발 냉각을 작게 잡을 수 있다(잔디·옥상녹화의 모델 온도가 실제보다 높게 나올 수 있음). 원의 반경은 선택 영역의 시각화이며 단위면적 결과는 변하지 않는다. 재료별 지도 색도 계산된 온도 색이 아니다.

## Claude 또는 다음 개발자의 수정 체크리스트

1. **먼저 변수의 의미를 정한다.** 위성 LST, 기온, 모델 평형 표면온도, 시나리오 W/m²를 서로 다른 상태·단위·범례로 유지한다. 연구 질문 2·3을 구현할 때 예측값·실측값·오차·불확실성을 분리한다.
2. **데이터 시점과 품질을 보존한다.** 기준일과 실제 촬영일을 함께 표기하고, 구름/결측을 임의 색이나 주변값으로 채우지 않는다. 혼합 장면이면 픽셀별 출처를 고려한다. 실패·잘린 검색은 숨기지 말고 "자료 품질"에 표시한다.
3. **현재 화면 기반 동작을 지킨다.** 카메라 이동 시 이전 요청 취소, 덮지 못하는 범위만 새로 요청, 이동 중 영상 유지, 화면 크기 변경/전체 화면 후 `map.resize()`와 오버레이 위치를 확인한다. 고정된 한 지역 자료로 되돌리지 않는다.
4. **건물 높이를 만들지 않는다.** 사용자 선택은 높이 태그가 있는 건물만 3D 표시하는 것이다. OSM에 없는 높이를 층수나 랜덤 값으로 채우려면 요구사항 변경과 명확한 표시가 먼저 필요하다.
5. **UI 상태를 함께 검사한다.** `index.html`의 요소 ID와 `src/observed-app.js` 조회 코드, `panel-collapsed`·`materials-mode`·`stats-stale`·`thermal-off` 클래스, 휴대폰 아래쪽 시트 CSS를 같이 확인한다. 지점 클릭 온도는 접힌 상태에서도 보이게 한다. 열 색 램프는 데이터에만 쓴다.
6. **새 모델을 만들면 검증한다.** 동일 시공간의 독립 관측 자료를 확보하고 학습·검증 시점을 분리해 MAE/RMSE와 고온 지역의 위치 일치도를 보고한다. 열 이동을 주장하려면 바람·일사·경계조건 및 시간 단계가 있는 모델과 검증이 필요하다. 최적 배치는 복수 개입, 면적/비용 제약, 목적함수와 공간적 영향 범위를 명시해야 한다.
7. **변경 후 확인한다.** `npm test`, 브라우저에서 지도 이동·확대·축소·건물 클릭·패널 접기·색 범위 전환·재료 변경·전체 화면·휴대폰 폭을 시험한다. 외부 API의 429/504 또는 무자료 상태에서도 화면이 오해를 유발하지 않는지 확인한다.

## 외부 자료 및 서비스

- [USGS Landsat Collection 2 Surface Temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature): 온도 제품과 스케일 계수·품질 정보
- [Landsat 8-9 Collection 2 Level-2 Science Product Guide](https://www.usgs.gov/landsat-missions/landsat-collection-2-level-2-science-products): `QA_PIXEL` 비트 정의(구름·권운 신뢰도 포함)
- [Microsoft Planetary Computer STAC](https://planetarycomputer.microsoft.com/dataset/landsat-c2-l2): 장면 검색과 자료 접근
- [OpenStreetMap](https://www.openstreetmap.org/), [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API): 지도 기반 건물 형상·높이 태그
- [OpenFreeMap](https://openfreemap.org/): 지도 스타일·타일
- [Open-Meteo](https://open-meteo.com/): 촬영 시각 기상(재분석·예보 분석)

외부 데이터의 사용 조건과 출처 표기는 서비스별 최신 문서를 확인한다. 코드나 UI에 새 자료를 추가할 때는 취득 시점, 공간 해상도, 측정/추정 여부, 결측 처리, 라이선스를 README와 화면에서 확인할 수 있게 남길 것.


### 데이터 출처·처리 기준

| 자료 | 확인할 내용 |
| --- | --- |
| [USGS Landsat Collection 2 Surface Temperature](https://www.usgs.gov/landsat-missions/landsat-collection-2-surface-temperature) · [Level-2 스케일 계수 FAQ](https://www.usgs.gov/faqs/how-do-i-use-a-scale-factor-landsat-level-2-science-products) | 현재 지도 LST의 원 제품과 DN→K 변환식(`DN × 0.00341802 + 149`). °C 표시는 여기서 273.15를 뺀다. 분석 기준일과 실제 장면 촬영일을 구분해야 한다. |
| [USGS Collection 2 QA 밴드](https://www.usgs.gov/landsat-missions/landsat-collection-2-quality-assessment-bands) · [Landsat 8–9 Level-2 제품 가이드](https://d9-wret.s3.us-west-2.amazonaws.com/assets/palladium/production/s3fs-public/media/files/LSDS-1619_Landsat8-9-Collection2-Level2-Science-Product-Guide-v5.pdf) | `QA_PIXEL`의 결측·구름·그림자·눈 비트와 신뢰도 정의. 코드의 `clearPixel` 처리 근거다. |
| [Microsoft Planetary Computer Landsat Collection 2](https://planetarycomputer.microsoft.com/dataset/group/landsat) · [STAC 문서](https://planetarycomputer.microsoft.com/docs/quickstarts/reading-stac-r/) | `landsat-c2-l2` 장면과 `lwir11`·`qa_pixel` 접근 경로. 온도 제품의 생산 출처는 USGS이고 Microsoft는 제공 플랫폼이다. |
| [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) · [Historical Forecast API](https://open-meteo.com/en/docs/historical-forecast-api) | 재료 모델에 쓰는 촬영 시각의 격자형 기온·습도·풍속·일사량. 재분석/예보 분석 자료이며 선택 지점의 현장 실측이 아니다. 실제 요청 모델과 해상도는 `src/weather.js` 및 화면 출처 표시를 확인한다. |
| [OpenStreetMap 저작권·ODbL](https://www.openstreetmap.org/copyright) · [OSM `height` 태그](https://wiki.openstreetmap.org/wiki/Key:height) · [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API) · [OpenFreeMap](https://openfreemap.org/) | 배경 지도, 건물 형상과 등록 높이의 출처 및 표시·재사용 조건. 건물 높이는 모든 객체에 있지 않고 현장 정확도도 보증되지 않는다. |

보고서에 온도값을 인용할 때는 위치·실제 촬영일·Landsat 장면 ID·품질 마스크·접근일을 함께 기록한다. 위성 지표면 온도(LST)는 실시간 기온이나 보행자 체감 온도가 아니다.

### 연구 배경과 모델 검토용 논문

아래 문헌은 연구 질문과 모델의 배경이다. 인용했다고 해서 이 앱이 각 논문의 방법을 모두 구현하거나 논문의 냉각 효과를 선택 지역에서 검증한 것은 아니다.

- Oke, T. R. (1982). [The energetic basis of the urban heat island](https://doi.org/10.1002/qj.49710845502). *Quarterly Journal of the Royal Meteorological Society*, 108, 1–24. 도시 열섬의 에너지수지 기초.
- Voogt, J. A., & Oke, T. R. (2003). [Thermal remote sensing of urban climates](https://doi.org/10.1016/S0034-4257(03)00079-8). *Remote Sensing of Environment*, 86(3), 370–384. 위성 표면온도와 도시 대기 열환경의 해석 차이.
- Weng, Q., Lu, D., & Schubring, J. (2004). [Estimation of land surface temperature–vegetation abundance relationship for urban heat island studies](https://doi.org/10.1016/j.rse.2003.11.005). *Remote Sensing of Environment*, 89(4), 467–483. 식생과 지표면 온도의 공간적 관계 분석 사례. 현재 앱은 이 논문의 식생 회귀 모델을 사용하지 않는다.
- Stewart, I. D., & Oke, T. R. (2012). [Local Climate Zones for Urban Temperature Studies](https://doi.org/10.1175/BAMS-D-11-00019.1). *Bulletin of the American Meteorological Society*, 93(12), 1879–1900. 도시 형태·피복별 비교와 관측 설계의 기준.
- Brutsaert, W. (1975). [On a derivable formula for long-wave radiation from clear skies](https://doi.org/10.1029/WR011i005p00742). *Water Resources Research*, 11(5), 742–744. 현재 표면 에너지수지 모델의 맑은 하늘 장파복사 근거.
- Santamouris, M. (2014). [Cooling the cities – A review of reflective and green roof mitigation technologies to fight heat island and improve comfort in urban environments](https://doi.org/10.1016/j.solener.2012.07.003). *Solar Energy*, 103, 682–703. 반사·녹화 지붕 저감 연구의 종합. 논문 속 평균 냉각 효과를 현재 앱의 온도 예측값으로 대입하면 안 된다.

재료별 숫자는 `src/materials.js`의 문헌 범주값·모델 가정을 확인한다. 개별 재료의 현장 물성, 모델의 이동·그늘 효과, 위치별 검증 오차를 위 참고문헌만으로 입증할 수는 없다.
