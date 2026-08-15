import { GRID_W, GRID_H, CELL_COUNT, percentile } from "./engine.js";
import { byId } from "./materials.js";

const PALETTES = {
  thermal: ["#224d8a", "#4cb9cb", "#ffd166", "#ed5a5a"],
  frequency: ["#183b67", "#44b7b8", "#f4cf61", "#f25555"],
  trend: ["#4779c4", "#d4e8e8", "#ffd166", "#e25252"],
  cooling: ["#2e5d89", "#c8d7d8", "#69d998", "#14a46a"],
};

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const rgb = hex => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
const shade = (color, factor) => {
  const values = color.match(/\d+/g)?.map(Number) || rgb(color);
  return `rgb(${values.map(value => Math.round(clamp(value * factor, 0, 255))).join(",")})`;
};
const paletteColor = (value, min, max, palette) => {
  const q = clamp((value - min) / Math.max(1e-6, max - min));
  const scaled = q * (palette.length - 1), index = Math.min(palette.length - 2, Math.floor(scaled)), t = scaled - index;
  const a = rgb(palette[index]), b = rgb(palette[index + 1]);
  return `rgb(${a.map((value, channel) => Math.round(value + (b[channel] - value) * t)).join(",")})`;
};

export const HISTORY_METRICS = {
  mean: { label: "다년 평균 LST", key: "meanLstC", unit: "°C", palette: "thermal" },
  p90: { label: "다년 고온 P90", key: "p90LstC", unit: "°C", palette: "thermal" },
  frequency: { label: "반복 고온 빈도", key: "hotFrequencyPercent", unit: "%", palette: "frequency" },
  trend: { label: "상대 열추세", key: "trendCPerYear", unit: "°C/년", palette: "trend" },
  ndvi: { label: "중앙 NDVI", key: "medianNdvi", unit: "", palette: "cooling" },
  scene: { label: "개별 장면 LST", key: "scene", unit: "°C", palette: "thermal" },
};

export class CityScene3D {
  constructor(canvas, { city, history, getState, metricSelect, scenarioSelect, sceneSelect, exaggerationInput, detailElement }) {
    this.canvas = canvas;
    this.city = city;
    this.history = history;
    this.getState = getState;
    this.metricSelect = metricSelect;
    this.scenarioSelect = scenarioSelect;
    this.sceneSelect = sceneSelect;
    this.exaggerationInput = exaggerationInput;
    this.detailElement = detailElement;
    this.azimuth = -0.72;
    this.zoom = 1;
    this.drag = null;
    this.lastBoxes = [];
    this.bind();
  }

  bind() {
    for (const control of [this.metricSelect, this.scenarioSelect, this.sceneSelect, this.exaggerationInput]) control?.addEventListener("input", () => this.render());
    this.canvas.addEventListener("pointerdown", event => {
      this.drag = { x: event.clientX, azimuth: this.azimuth };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", event => {
      if (this.drag) {
        this.azimuth = this.drag.azimuth + (event.clientX - this.drag.x) * .008;
        this.render();
      } else {
        const rect = this.canvas.getBoundingClientRect(), px = (event.clientX - rect.left) / rect.width * this.logicalWidth, py = (event.clientY - rect.top) / rect.height * this.logicalHeight;
        let hit = null;
        for (let index = this.lastBoxes.length - 1; index >= 0 && !hit; index -= 1) {
          const box = this.lastBoxes[index];
          if (px >= box.minX && px <= box.maxX && py >= box.minY && py <= box.maxY) hit = box;
        }
        if (hit && this.detailElement) this.detailElement.textContent = this.describe(hit.index);
      }
    });
    this.canvas.addEventListener("pointerup", () => { this.drag = null; });
    this.canvas.addEventListener("pointercancel", () => { this.drag = null; });
    this.canvas.addEventListener("wheel", event => {
      event.preventDefault();
      this.zoom = clamp(this.zoom * (event.deltaY > 0 ? .92 : 1.08), .62, 1.75);
      this.render();
    }, { passive: false });
  }

  rotate(delta) { this.azimuth += delta; this.render(); }
  reset() { this.azimuth = -.72; this.zoom = 1; this.render(); }

  setup() {
    const rect = this.canvas.parentElement?.getBoundingClientRect() || this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1), width = Math.max(300, Math.floor(rect.width)), height = Math.max(340, Math.floor(rect.height));
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr; this.canvas.height = height * dpr;
    }
    const context = this.canvas.getContext("2d");
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.logicalWidth = width; this.logicalHeight = height;
    return { context, width, height };
  }

  projection(width, height) {
    const baseScale = Math.min(width / (GRID_W * 1.3), height / (GRID_H * .82)) * this.zoom;
    const cos = Math.cos(this.azimuth), sin = Math.sin(this.azimuth);
    return (x, y, z = 0) => {
      const dx = x - GRID_W / 2, dy = y - GRID_H / 2;
      const horizontal = dx * cos - dy * sin, depth = dx * sin + dy * cos;
      return {
        x: width / 2 + horizontal * baseScale,
        y: height * .57 + depth * baseScale * .47 - z * baseScale * .026 * +this.exaggerationInput.value,
        depth,
      };
    };
  }

  metricValues() {
    const metric = HISTORY_METRICS[this.metricSelect.value] || HISTORY_METRICS.frequency;
    if (metric.key === "scene") {
      const index = Math.max(0, Math.min(this.history.sceneCount - 1, +this.sceneSelect.value || 0));
      return { metric: { ...metric, label: `${this.history.scenes[index].date} LST` }, values: this.history.sceneMaps.lstC[index] };
    }
    return { metric, values: this.history.metrics[metric.key] };
  }

  describe(index) {
    const state = this.getState(), scenario = this.scenarioSelect.value === "optimized" ? "AI 설계" : "현재";
    const types = this.scenarioSelect.value === "optimized" && state?.optimizedTypes ? state.optimizedTypes : this.city.types;
    const { metric, values } = this.metricValues();
    return `${scenario} · ${byId(types[index]).name} · 건물높이 ${this.city.heights[index].toFixed(0)} m(OSM 태그·유형값 집계) · ${metric.label} ${values[index].toFixed(metric.key === "trendCPerYear" ? 3 : 1)}${metric.unit}`;
  }

  render() {
    const { context: ctx, width, height } = this.setup(), project = this.projection(width, height), state = this.getState();
    const optimized = this.scenarioSelect.value === "optimized" && state?.optimizedTypes;
    const types = optimized ? state.optimizedTypes : this.city.types;
    const { metric, values } = this.metricValues();
    const selected = values.filter((_, index) => this.city.insideBoundary[index]);
    let min = percentile(selected, .03), max = percentile(selected, .97);
    if (metric.key === "trendCPerYear") { const magnitude = Math.max(Math.abs(min), Math.abs(max), .01); min = -magnitude; max = magnitude; }
    const palette = PALETTES[metric.palette];
    ctx.clearRect(0, 0, width, height);
    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, "#0d2938"); background.addColorStop(1, "#061019");
    ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);

    const cells = [];
    for (let i = 0; i < CELL_COUNT; i += 1) {
      if (!this.city.insideBoundary[i]) continue;
      const x = i % GRID_W, y = Math.floor(i / GRID_W), center = project(x + .5, y + .5, 0);
      cells.push({ index: i, x, y, depth: center.depth });
    }
    cells.sort((a, b) => a.depth - b.depth);
    this.lastBoxes = [];
    for (const cell of cells) {
      const { index, x, y } = cell, baseColor = paletteColor(values[index], min, max, palette);
      const ground = [project(x, y), project(x + 1, y), project(x + 1, y + 1), project(x, y + 1)];
      this.polygon(ctx, ground, shade(baseColor, .62), "rgba(255,255,255,.055)");
      if (!this.city.buildings[index]) {
        if (byId(types[index]).green) {
          const point = project(x + .5, y + .5, 3.5);
          ctx.fillStyle = "rgba(78,221,144,.72)"; ctx.beginPath(); ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2); ctx.fill();
        }
        continue;
      }
      const buildingHeight = Math.max(3, this.city.heights[index]);
      const top = [project(x + .12, y + .12, buildingHeight), project(x + .88, y + .12, buildingHeight), project(x + .88, y + .88, buildingHeight), project(x + .12, y + .88, buildingHeight)];
      const bottom = [project(x + .12, y + .12), project(x + .88, y + .12), project(x + .88, y + .88), project(x + .12, y + .88)];
      const faces = [
        [bottom[0], bottom[1], top[1], top[0]], [bottom[1], bottom[2], top[2], top[1]],
        [bottom[2], bottom[3], top[3], top[2]], [bottom[3], bottom[0], top[0], top[3]],
      ];
      faces.forEach((face, faceIndex) => this.polygon(ctx, face, shade(baseColor, faceIndex % 2 ? .64 : .48), "rgba(0,0,0,.22)"));
      this.polygon(ctx, top, baseColor, "rgba(255,255,255,.35)");
      this.lastBoxes.push({ index, minX: Math.min(...top.map(p => p.x), ...bottom.map(p => p.x)), maxX: Math.max(...top.map(p => p.x), ...bottom.map(p => p.x)), minY: Math.min(...top.map(p => p.y)), maxY: Math.max(...bottom.map(p => p.y)) });
    }

    ctx.fillStyle = "rgba(6,16,25,.82)"; ctx.fillRect(14, 14, Math.min(340, width - 28), 57);
    ctx.fillStyle = "#edf8fb"; ctx.font = "700 13px system-ui"; ctx.fillText(`${optimized ? "AI 재배치" : "현재 도시"} · ${metric.label}`, 26, 36);
    ctx.fillStyle = "#a9c1ca"; ctx.font = "12px system-ui"; ctx.fillText(`${min.toFixed(metric.key === "trendCPerYear" ? 3 : 1)}–${max.toFixed(metric.key === "trendCPerYear" ? 3 : 1)} ${metric.unit} · 드래그 회전 / 휠 확대`, 26, 57);
  }

  polygon(ctx, points, fill, stroke) {
    ctx.beginPath(); points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = .65; ctx.stroke();
  }
}
