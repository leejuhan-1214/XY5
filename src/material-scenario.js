import {MATERIAL} from './materials.js';

// This deliberately reports an energy-budget sensitivity, not a temperature forecast.
// Neither the existing surface material nor the incident sunlight is observed by this app.
export const ASSUMED_SUNLIGHT = 800; // W/m², illustrative sunny daytime condition
export const ASSUMED_MOISTURE = 0.4; // fraction of the material's evaporation potential

export const MATERIAL_CHOICES = {
  ground: [MATERIAL.asphalt, MATERIAL.concrete, MATERIAL.coolPave, MATERIAL.permeable, MATERIAL.grass],
  roof: [MATERIAL.blackRoof, MATERIAL.epdm, MATERIAL.whitePaint, MATERIAL.greenRoof, MATERIAL.whiteMetal],
};

export function materialEnergy(base, replacement, sunlight=ASSUMED_SUNLIGHT, moisture=ASSUMED_MOISTURE){
  if(!base||!replacement||![sunlight,moisture].every(Number.isFinite)||sunlight<0||moisture<0||moisture>1)throw Error('Invalid material scenario');
  const absorbed=m=>(1-m.albedo)*sunlight;
  const evaporative=m=>m.evap*moisture;
  const before=absorbed(base)-evaporative(base);
  const after=absorbed(replacement)-evaporative(replacement);
  return {before,after,change:after-before,absorbedBefore:absorbed(base),absorbedAfter:absorbed(replacement),evaporativeBefore:evaporative(base),evaporativeAfter:evaporative(replacement)};
}

export function circleAt([lng,lat],radiusMeters,segments=48){
  if(!Number.isFinite(lng)||!Number.isFinite(lat)||Math.abs(lat)>=89||!Number.isFinite(radiusMeters)||radiusMeters<=0)throw Error('Invalid patch location');
  const latStep=radiusMeters/111320,lonStep=latStep/Math.cos(lat*Math.PI/180);
  const ring=Array.from({length:segments},(_,i)=>{
    const angle=i*2*Math.PI/segments;
    return [lng+Math.cos(angle)*lonStep,lat+Math.sin(angle)*latStep];
  });
  ring.push(ring[0]);
  return {type:'Polygon',coordinates:[ring]};
}
