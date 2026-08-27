export const MATERIALS = [
  { id: 0, key: "asphalt", name: "신규 아스팔트", rating: "Bad", albedo: 0.05, emissivity: 0.93, surfaceCapacity: 190000, bulkCapacity: 900000, conductance: 8.0, evap: 0, storage: "높음", permeability: "없음", source: "EPA 알베도; ε 가정", color: "#424b55", ground: true },
  { id: 1, key: "concrete", name: "포틀랜드 콘크리트", rating: "Fair", albedo: 0.35, emissivity: 0.90, surfaceCapacity: 220000, bulkCapacity: 1000000, conductance: 9.0, evap: 0, storage: "매우 높음", permeability: "없음", source: "EPA 알베도; ε 가정", color: "#9aa4a8", ground: true },
  { id: 2, key: "blackRoof", name: "흑색 아스팔트 슁글", rating: "Bad", albedo: 0.04, emissivity: 0.91, surfaceCapacity: 90000, bulkCapacity: 260000, conductance: 4.0, evap: 0, storage: "낮음", permeability: "없음", source: "DOE 측정표", color: "#20262b", building: true },
  { id: 3, key: "coolPave", name: "쿨 포장 코팅", rating: "Good", albedo: 0.50, emissivity: 0.90, surfaceCapacity: 150000, bulkCapacity: 680000, conductance: 6.5, evap: 0, storage: "중간", permeability: "없음", source: "EPA 범주값; ε 가정", color: "#d8d1a5", ground: true },
  { id: 4, key: "permeable", name: "투수 포장", rating: "Good", albedo: 0.25, emissivity: 0.94, surfaceCapacity: 150000, bulkCapacity: 650000, conductance: 5.2, evap: 85, storage: "중간", permeability: "수분 의존", source: "모델 가정", color: "#79a9a1", ground: true },
  { id: 5, key: "grass", name: "잔디·녹지", rating: "Good", albedo: 0.25, emissivity: 0.95, surfaceCapacity: 125000, bulkCapacity: 500000, conductance: 3.2, evap: 150, storage: "낮음", permeability: "높음", source: "EPA 알베도; ε 가정", color: "#4c9a61", ground: true, green: true },
  { id: 6, key: "tree", name: "수목 그늘", rating: "Very Good", albedo: 0.18, emissivity: 0.96, surfaceCapacity: 120000, bulkCapacity: 480000, conductance: 3.0, evap: 190, storage: "낮음", permeability: "높음", source: "모델 가정", color: "#1f7049", ground: true, green: true, tree: true },
  { id: 7, key: "epdm", name: "백색 EPDM 지붕", rating: "Good", albedo: 0.69, emissivity: 0.87, surfaceCapacity: 85000, bulkCapacity: 240000, conductance: 3.5, evap: 0, storage: "낮음", permeability: "없음", source: "DOE 측정표", color: "#e8edf0", building: true },
  { id: 8, key: "whitePaint", name: "백색 도장 지붕", rating: "Very Good", albedo: 0.85, emissivity: 0.96, surfaceCapacity: 80000, bulkCapacity: 235000, conductance: 3.5, evap: 0, storage: "낮음", permeability: "없음", source: "DOE 측정표", color: "#f7f3db", building: true },
  { id: 9, key: "greenRoof", name: "옥상녹화", rating: "Very Good", albedo: 0.25, emissivity: 0.95, surfaceCapacity: 155000, bulkCapacity: 520000, conductance: 3.0, evap: 145, storage: "중간", permeability: "높음", source: "모델 가정", color: "#62b47a", building: true, green: true },
  { id: 10, key: "whiteMetal", name: "백색 금속 지붕", rating: "Good", albedo: 0.59, emissivity: 0.85, surfaceCapacity: 70000, bulkCapacity: 210000, conductance: 3.0, evap: 0, storage: "낮음", permeability: "없음", source: "DOE 측정표", color: "#bcd5db", building: true }
];

export const MATERIAL = Object.fromEntries(MATERIALS.map(item => [item.key, item]));
export const byId = id => MATERIALS[id];
export const materialLabel = material => `${material.name} (${material.rating})`;

// Fixed, non-optimized retrofit: geometry and tile locations remain unchanged.
export function materialOnlyTypes(types, changeLimit = Infinity) {
  const swaps = new Map([
    [MATERIAL.asphalt.id, MATERIAL.coolPave.id],
    [MATERIAL.concrete.id, MATERIAL.permeable.id],
    [MATERIAL.blackRoof.id, MATERIAL.epdm.id],
  ]);
  const output = Uint8Array.from(types);
  const candidates = Array.from(types, (id, index) => ({ id, index }))
    .filter(item => swaps.has(item.id))
    .sort((a, b) => (((a.index * 2654435761) >>> 0) - ((b.index * 2654435761) >>> 0)) || a.index - b.index);
  for (const { id, index } of candidates.slice(0, Math.max(0, Math.min(candidates.length, changeLimit)))) output[index] = swaps.get(id);
  return output;
}
