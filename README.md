# Urban Heat Potential Lab

인천광역시 남동구 **구월동**의 각 셀을 정보행렬로 표현하고, 열섬을 다년 위성 합성·3D 열지형·가상 열 추적자 흐름으로 설명하는 정적 웹 시뮬레이터입니다. DBSCAN, MCLP, 유전 알고리즘, 셀룰러 오토마타(CA), PyTorch 대응 텐서 구조를 하나의 재현 가능한 파이프라인으로 묶었습니다.

> 이 프로젝트는 연구·교육용 1차 스크리닝 모델입니다. 표시되는 입자는 실제 분자가 아니라 열에너지의 순전달을 시각화한 가상 추적자이며, 유효 열퍼텐셜 Φ는 여러 무차원화 전 항의 가중합인 비교용 지수입니다.

## 핵심 기능

- 동일한 도시형상·기상·초기조건에서 재료/배치만 변경하는 변인 통제
- 구월동 법정동 경계, OSM 건물·도로·녹지, Landsat 8·9 LST·NDVI·NDBI, 관측일 시간별 기상 내장
- 2018–2025년 여름 Tier 1 장면을 QA_PIXEL로 거른 다년 평균·P90·반복 고온빈도·상대 열추세
- 2024-08-29 11:10 KST Landsat LST(구월동 격자 평균 42.5°C)를 기준안 보정 앵커로 사용
- 건물 높이와 합성지표 또는 13개 개별 촬영일 LST를 함께 탐색하는 드래그 회전·휠 확대 3D 도시 모델
- 24×18 도시 격자와 10분 간격 24시간 에너지수지 계산
- 열퍼텐셜 등고선, 열유속 벡터, 가상 열 추적자 애니메이션
- 합법적으로 확보한 PNG/JPEG/WebP 위성·드론 영상을 브라우저에서 배경으로 불러오기
- 현재 도시, 동일 변경 셀 수의 재료-only 도시, AI 재배치 도시를 동일 색상범위로 비교
- 72개 보로노이 세부구역을 모든 시나리오에 동일하게 적용해 공간 차이를 추적
- DBSCAN 고온 군집 탐지
- MCLP 냉각 거점 선정
- 유전 알고리즘을 통한 쿨포장·투수포장·녹지·수목·쿨루프 배치
- 표면온도, 열퍼텐셜, 추적자 체류시간, 야간 현열, 취약인구 노출 평가
- PyTorch 참조 연산 구현(`python/torch_engine.py`)

## 바로 실행

브라우저 ES 모듈을 사용하므로 로컬 HTTP 서버로 여세요.

```bash
python -m http.server 8000
```

그런 다음 <http://localhost:8000>을 엽니다.

Node.js가 있다면 다음도 가능합니다.

```bash
npm run start
```

`index.html`을 `file://`로 직접 열면 브라우저의 ES 모듈 보안 정책 때문에 동작하지 않을 수 있습니다. 반드시 위 로컬 서버 또는 GitHub Pages URL로 접속하세요.

## 구월동 데이터

- 공간 범위: OSM 법정동 구월동 relation `8857846`, WGS84 `126.6925639–126.7218288°E`, `37.4340681–37.4610653°N`
- 토지·형상: OpenStreetMap 건물 1,550개, 도로 1,152개, 녹지 36개, 주차장 16개를 24×18 격자로 집계
- 원격탐사 앵커: Landsat 8 Collection 2 Level-2 `LC08_L2SP_116034_20240829_02_T1`; LST, NDVI, NDBI, QA_PIXEL
- 다년 합성: `data/guwol-history.json`에 기록된 2018–2025년 여름 Landsat 8·9 Tier 1 장면. 구름·권운·그림자 제거 후 장면별 상위 20% 빈도를 반복 고온지표로 사용
- 기상: Open-Meteo Historical Weather API의 2024-08-29 시간별 기온·습도·풍향·풍속·일사·토양수분
- 내장 파일: `data/guwol-data.json`, `data/guwol-history.json`, `data/guwol-boundary.geojson`, `data/guwol-osm-basemap.webp`

Landsat LST는 보행 높이 기온이 아닌 **지표면온도**입니다. 공개 공간자료에 없는 실제 지붕 재질, 일부 높이, 보행량·취약인구는 각각 재질 사전값과 대리변수를 사용하며 화면과 데이터 파일에 구분해 두었습니다.

### 다년 합성 재생성

Python의 NumPy·Pillow가 있는 환경에서 Microsoft Planetary Computer의 공개 STAC/Data API로 소형 분석 격자를 다시 만들 수 있습니다.

```bash
python scripts/build_multitemporal.py
```

스크립트는 원본 대용량 래스터를 저장소에 넣지 않고 장면 ID, 품질정보, 24×18 집계지표만 기록합니다. 상대 열추세는 기상 정규화된 장기 기후추세가 아니라 각 장면의 구월동 평균을 뺀 공간 편차의 선형 변화입니다.

## 테스트

외부 패키지 없이 엔진의 결정성, 유한값, 시간축, 최적화 면적 제약을 확인합니다.

```bash
npm test
```

PyTorch가 설치된 환경에서는 텐서 참조 구현을 확인할 수 있습니다.

```bash
python python/torch_engine.py
```

## GitHub에 올리기

새 GitHub 저장소를 만든 뒤 이 폴더에서 실행합니다.

```bash
git init
git add .
git commit -m "Initial urban heat potential simulator"
git branch -M main
git remote add origin https://github.com/USER/REPOSITORY.git
git push -u origin main
```

저장소의 **Settings → Pages → Source**를 **GitHub Actions**로 선택하면 포함된 워크플로가 정적 사이트를 배포합니다.

## 모델 개요

각 셀의 정보행렬은 다음과 같습니다.

```text
Sᵢⱼ = (T, M, u, v, H, W, α, ε, C)
```

- `T`: 표면온도
- `M`: 표면/지붕 재료
- `u, v`: 건물저항을 반영한 바람성분
- `H`: 건물높이
- `W`: 수분 가용도
- `α`: 태양반사율
- `ε`: 열방사율
- `C`: 열저장 변수

유효 열퍼텐셜은 설명과 최적화를 위한 비교지수입니다.

```text
Φ = wₜT + wₛS + wᵦB − wɢG − wₑE
J = −D∇Φ + λv
Eᵗ⁺¹ = Eᵗ − ∇·J + Qsource − Qsink
```

`J`의 첫 항은 퍼텐셜 감소 방향의 확산, 둘째 항은 바람에 의한 이류입니다.

## 재료 단순화와 근거

재료는 태양반사율, 열방사율, 표면/하부 열용량, 전도계수, 증발냉각계수로 단순화했습니다. 문헌값이 범위일 때 대표값을 사용했으며, 직접 측정값이 없는 열용량·투수·증발 계수는 화면과 코드에 `모델 가정`으로 표시했습니다. 화면의 `(Bad)`, `(Fair)`, `(Good)`, `(Very Good)`은 열섬 저감 관점의 상대적 읽기 보조값이며 구조성능이나 수명에 대한 종합 등급은 아닙니다.

재료-only 시나리오는 AI가 선택한 변경 셀 수와 동일한 수의 타일을 결정론적으로 고른 뒤, 아스팔트→쿨 포장, 콘크리트→투수 포장, 흑색 지붕→백색 EPDM으로 바꿉니다. 타일 위치와 도시 형상은 유지하므로 공간 최적화 효과와 물성 교체 효과를 분리해 볼 수 있습니다.

주요 공개 근거:

- [EPA: Cool Fixes for Hot Cities - common urban surface albedo](https://www.epa.gov/sites/production/files/2018-09/documents/2-heat-island-webcast-cool-fixes-part-2-2018-09-12.pdf)
- [DOE: Solar reflectance and emittance of roofing materials](https://www.energy.gov/sites/prod/files/2013/11/f5/nationalbestpracticesmanual31545.pdf)
- [EPA: Using Cool Pavements to Reduce Heat Islands](https://www.epa.gov/heatislands/using-cool-pavements-reduce-heat-islands)
- [EPA: Benefits of Trees and Vegetation](https://www.epa.gov/heatislands/benefits-trees-and-vegetation)

## 첨부 논문에서 반영한 연구 설계

Sharma, Singh, Yogeswaran (2026)의 글로벌 리뷰는 80편의 UHI 연구를 검토하고, 관측·위성 열원격탐사·기상자료·수치모델의 결합, 지역 기후별 전략, 현장 검증의 필요성을 강조합니다. 이 프로젝트에는 다음을 반영했습니다.

- 지표온도(LST)와 보행 높이 대기온도를 동일시하지 않음
- 바람, 수분, 재료, 건물형상, 취약인구를 함께 표현
- 녹지·반사표면·쿨루프·도시형상 전략을 한 예산에서 비교
- 상세 설계 전 현장측정과 CFD/WRF/ENVI-met 교차검증을 요구

논문: Pallavi Sharma, Ramkishore Singh, Nithiyanandam Yogeswaran, *Global review of urban heat island research across varied climatic regions*, Discover Environment 4, 84 (2026). [DOI 10.1007/s44274-026-00571-0](https://doi.org/10.1007/s44274-026-00571-0). 논문은 CC BY-NC-ND 4.0이며, 저장소에는 원문이나 변형 그림을 포함하지 않고 방법론적 시사점만 요약했습니다.

## 실제 지역에 적용할 때 필요한 데이터

1. Landsat/ECOSTRESS 지표온도와 NDVI/NDBI
2. 1.5–2 m 높이 기온·습도 이동측정 또는 센서망
3. 시간별 일사량, 풍향·풍속, 구름, 강수
4. 건물 footprint/높이, 도로, 수체, 수목 캐노피
5. 현장 표면의 `α`, `ε`, 함수율
6. 인구와 폭염 취약성 자료

실제 위성지도를 포함하려면 공개 타일을 캡처해 저장소에 넣기보다, 사용권을 확인한 GeoTIFF를 PNG/JPEG/WebP로 전처리해 화면의 **위성·드론 배경 영상**에서 불러오세요. 파일은 브라우저 메모리에서만 처리되며 서버로 전송되지 않습니다. 현재 프로토타입은 영상을 격자 전체에 맞추므로, 연구용 분석에서는 대상 범위·좌표계·공간해상도를 먼저 정확히 정합해야 합니다.

## 한계

- 브라우저 모델은 2차원 스크리닝이며 완전한 CFD가 아닙니다.
- Φ는 물리적 퍼텐셜에너지의 SI 단위가 아니라 해석용 합성지수입니다.
- 기본 지도는 실제 구월동 지도가 아닌 재현 가능한 합성 도시입니다.
- 반사 표면은 주변 건물·보행자에 복사 눈부심/열부하를 유발할 수 있습니다.
- 수분이 없는 투수포장은 증발냉각이 약해지며, 녹지는 관수·수종·계절에 민감합니다.

## 구조

```text
.
├─ index.html                 # 인터랙티브 시뮬레이터
├─ methodology.html           # 수식, 해석, 검증 사다리
├─ src/
│  ├─ app.js                  # UI, 캔버스, 입자, 차트
│  ├─ engine.js               # CA, 퍼텐셜, DBSCAN, MCLP, GA
│  ├─ materials.js            # 재료 열특성 및 출처 구분
│  └─ styles.css
├─ python/torch_engine.py      # PyTorch 텐서 참조 구현
├─ tests/test_engine.mjs
└─ .github/workflows/pages.yml
```

## License

코드는 MIT License입니다. 인용한 논문과 외부 자료의 저작권·라이선스는 각 원저작자에게 있습니다.
