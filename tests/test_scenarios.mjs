import assert from "node:assert/strict";
import { MATERIAL, byId, materialOnlyTypes } from "../src/materials.js";
import { createCity } from "../src/engine.js";

const city = createCity();
const retrofit = materialOnlyTypes(city.types);
assert.equal(retrofit.length, city.types.length);

let changed = 0;
for (let i = 0; i < city.types.length; i += 1) {
  const before = city.types[i], after = retrofit[i];
  if (before === after) continue;
  changed += 1;
  assert.equal(city.buildings[i], byId(after).building ? 1 : 0, "재료 교체가 건물/지면 형상을 바꾸면 안 됩니다");
  assert.ok(after === MATERIAL.coolPave.id || after === MATERIAL.permeable.id || after === MATERIAL.epdm.id);
}

assert.ok(changed > 0, "재료 전환 대상이 있어야 합니다");
assert.equal(materialOnlyTypes(Uint8Array.from([MATERIAL.asphalt.id, MATERIAL.concrete.id, MATERIAL.blackRoof.id])).join(","), [MATERIAL.coolPave.id, MATERIAL.permeable.id, MATERIAL.epdm.id].join(","));
const limited = materialOnlyTypes(city.types, 36);
const limitedChanged = limited.reduce((sum, id, index) => sum + Number(id !== city.types[index]), 0);
assert.equal(limitedChanged, 36, "재료-only 시나리오는 AI 시나리오와 같은 변경 셀 수를 써야 합니다");
console.log(JSON.stringify({ materialOnlyChangedCells: changed, controlledChangedCells: limitedChanged, spatialOptimization: false }));
