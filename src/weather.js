// Near-surface weather at a Landsat acquisition time, used only to drive the material
// energy-balance model. Open-Meteo serves ERA5-based reanalysis (archive, ~5 day lag) and
// recent model analyses (forecast API); both are gridded (~10–25 km) estimates, not station data.
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const RECENT = 'https://api.open-meteo.com/v1/forecast';
const VARIABLES = ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m', 'shortwave_radiation_instant'];

// Linear interpolation of instantaneous hourly values at an exact UTC time.
export function interpolateHourly(hourly, datetime) {
  const at = Date.parse(datetime);
  const times = hourly?.time?.map(t => Date.parse(t + 'Z')) || [];
  const after = times.findIndex(t => t >= at);
  if (!Number.isFinite(at) || after < 0 || (after === 0 && times[0] !== at)) return null;
  const before = times[after] === at ? after : after - 1;
  const f = times[after] === times[before] ? 0 : (at - times[before]) / (times[after] - times[before]);
  const value = key => {
    const a = hourly[key]?.[before], b = hourly[key]?.[after];
    return Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * f : null;
  };
  const result = {
    sunlight: value('shortwave_radiation_instant'),
    airTemperature: value('temperature_2m'),
    humidity: value('relative_humidity_2m'),
    wind: value('wind_speed_10m'),
  };
  return Object.values(result).every(Number.isFinite) ? result : null;
}

export function weatherURL(base, lng, lat, datetime) {
  const day = datetime.slice(0, 10), next = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const params = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lng.toFixed(4), start_date: day, end_date: next, hourly: VARIABLES.join(','), wind_speed_unit: 'ms', timezone: 'GMT' });
  return `${base}?${params}`;
}

export async function fetchWeather(lng, lat, datetime, signal) {
  const recent = Date.now() - Date.parse(datetime) < 6 * 86400000;
  for (const [base, label] of recent ? [[RECENT, 'Open-Meteo 예보 분석']] : [[ARCHIVE, 'Open-Meteo 재분석(ERA5)'], [RECENT, 'Open-Meteo 예보 분석']]) {
    try {
      const response = await fetch(weatherURL(base, lng, lat, datetime), { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
      if (!response.ok) continue;
      const values = interpolateHourly((await response.json()).hourly, datetime);
      if (values) return { ...values, time: datetime, source: 'weather', label };
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  return null;
}
