import {MATERIAL} from './materials.js';

// Neither the existing surface material nor the incident sunlight is observed by this app.
// Two levels of model are offered and labelled separately in the UI:
//   1. materialEnergy  – absorbed-minus-evaporated input difference (W/m²), unchanged from v1.
//   2. surfaceTemperature – steady-state surface energy balance solved for the surface
//      temperature (°C). A modelled equilibrium, not an observation or a forecast.
export const ASSUMED_SUNLIGHT = 800; // W/m², illustrative sunny daytime condition
export const ASSUMED_MOISTURE = 0.4; // fraction of the material's evaporation potential
export const SIGMA = 5.670374419e-8;
export const ASSUMED_CONDITIONS = Object.freeze({
  sunlight: ASSUMED_SUNLIGHT, airTemperature: 30, humidity: 60, wind: 2, moisture: ASSUMED_MOISTURE, source: 'assumed',
});

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

// Clear-sky downwelling longwave from air temperature and humidity (Brutsaert 1975).
export function skyLongwave(airTemperature, humidity) {
  const kelvin = airTemperature + 273.15;
  const vapour = humidity / 100 * 6.112 * Math.exp(17.67 * airTemperature / (airTemperature + 243.5)); // hPa
  return 1.24 * (vapour / kelvin) ** (1 / 7) * SIGMA * kelvin ** 4;
}

// Forced + free convection over a flat surface (McAdams): h = 5.7 + 3.8·U, U in m/s.
export const convectionCoefficient = wind => 5.7 + 3.8 * Math.max(0, wind);

function validConditions(c) {
  return c && [c.sunlight, c.airTemperature, c.humidity, c.wind, c.moisture].every(Number.isFinite)
    && c.sunlight >= 0 && c.humidity >= 0 && c.humidity <= 100 && c.wind >= 0 && c.moisture >= 0 && c.moisture <= 1;
}

// Steady state:  (1−α)·S + ε·L↓  =  ε·σ·Ts⁴ + h·(Ts−Ta) + k·(Ts−Ta) + LE
// k is the material's conductance to a substrate assumed to sit at air temperature and
// LE = evaporation potential × moisture (the same term as materialEnergy). No storage,
// shading, advection or neighbouring surfaces: a sensitivity model, not a forecast.
export function surfaceTemperature(material, conditions = ASSUMED_CONDITIONS) {
  if (!material || !validConditions(conditions)) throw Error('Invalid surface energy balance input');
  const { sunlight, airTemperature: ta, humidity, wind, moisture } = conditions;
  const absorbed = (1 - material.albedo) * sunlight;
  const longwaveIn = material.emissivity * skyLongwave(ta, humidity);
  const latent = material.evap * moisture;
  const h = convectionCoefficient(wind), k = material.conductance;
  const residual = ts => absorbed + longwaveIn - latent - material.emissivity * SIGMA * (ts + 273.15) ** 4 - (h + k) * (ts - ta);
  let low = ta - 60, high = ta + 90;
  for (let i = 0; i < 80; i++) { const mid = (low + high) / 2; if (residual(mid) > 0) low = mid; else high = mid; }
  const temperature = (low + high) / 2;
  return {
    temperature,
    fluxes: {
      absorbed, longwaveIn, latent,
      emitted: material.emissivity * SIGMA * (temperature + 273.15) ** 4,
      convective: h * (temperature - ta),
      conductive: k * (temperature - ta),
    },
  };
}

export function materialTemperature(base, replacement, conditions = ASSUMED_CONDITIONS) {
  const before = surfaceTemperature(base, conditions), after = surfaceTemperature(replacement, conditions);
  return { before: before.temperature, after: after.temperature, change: after.temperature - before.temperature, fluxesBefore: before.fluxes, fluxesAfter: after.fluxes };
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
