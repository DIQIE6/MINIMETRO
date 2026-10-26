import { CONFIG } from './config.js';
import { TAU, clamp, pointPolylineDistance } from './geometry.js';

/**
 * Hills and mountains.
 *
 * A map is mostly plain with a couple of solid hills on it. Each one is a
 * single smooth blob - never a basin, never a scattering of fragments - and
 * none of them overlaps the water: hills sit *beside* a river, or well away
 * from it, which is what real terrain does.
 *
 * Track laid over a hill is a surface line and runs slowly; spending a tunnel
 * on that stretch makes it a tunnel and it runs at full speed. Crossing water
 * always spends a tunnel automatically, as before.
 */
export class Terrain {
  constructor(rng, world = CONFIG.world, river = null, params = null) {
    const cfg = { ...CONFIG.terrain, ...(params || {}) };
    this.params = cfg;
    this.world = world;
    this.river = river;
    /** @type {{points:{x:number,y:number}[], cx:number, cy:number, area:number, radius:number}[]} */
    this.mountains = [];
    this.generate(rng, cfg);
  }

  get count() {
    return this.mountains.length;
  }

  /** Index of the hill containing a point, or -1. */
  mountainAt(x, y) {
    for (let i = 0; i < this.mountains.length; i++) {
      if (pointInPolygon(x, y, this.mountains[i].points)) return i;
    }
    return -1;
  }

  contains(x, y) {
    return this.mountainAt(x, y) >= 0;
  }

  /** Distance to the nearest hill edge; negative inside. */
  distanceTo(x, y) {
    let best = Infinity;
    for (const m of this.mountains) {
      const d = pointPolylineDistance(x, y, m.points);
      const inside = pointInPolygon(x, y, m.points);
      const signed = inside ? -d : d;
      if (signed < best) best = signed;
    }
    return best;
  }

  generate(rng, cfg) {
    const target = rng.int(cfg.count[0], cfg.count[1]);
    if (target <= 0) return;
    const { w, h } = this.world;
    const river = this.river;
    const minArea = cfg.minArea;
    const maxArea = cfg.maxArea;

    for (let i = 0; i < target; i++) {
      // Pick a size first, then find somewhere that size actually fits.
      const want = rng.range(minArea, maxArea);
      const radius = Math.sqrt((want * w * h) / Math.PI);
      let placed = null;
      let bestScore = -Infinity;
      for (let attempt = 0; attempt < 220; attempt++) {
        const cx = rng.range(radius * 1.05, w - radius * 1.05);
        const cy = rng.range(radius * 1.05, h - radius * 1.05);
        // Never overlap the water, and keep a real gap from it.
        if (river) {
          const d = river.distanceTo(cx, cy);
          // Use the blob's *outermost* radius: the wobble pushes vertices beyond
          // the nominal radius, and those are what clipped the water.
          if (d < radius * (1 + cfg.wobble * 1.4) + cfg.riverGap + river.halfWidthAt(cx, cy)) continue;
        }
        // Don't sit on top of another hill.
        let clash = false;
        for (const other of this.mountains) {
          if (Math.hypot(other.cx - cx, other.cy - cy) < (other.radius + radius) * 1.15) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        // Prefer a spot that nestles up against the river, which is where real
        // hills tend to be, but never so close that they touch.
        let score = rng.next() * 0.4;
        if (river) {
          const d = river.distanceTo(cx, cy);
          const near = 1 - Math.min(1, Math.abs(d - (radius + cfg.riverGap + 60)) / 320);
          score += near;
        }
        if (score > bestScore) {
          bestScore = score;
          placed = { cx, cy, radius };
          if (score > 1.2) break;
        }
      }
      if (!placed) continue;
      let points = blob(rng, placed.cx, placed.cy, placed.radius, cfg.wobble);
      // Scale the blob about its centre so the finished shape really is the
      // requested share of the map (the wobble changes the area).
      const want2 = want * w * h;
      const have = polygonArea(points);
      if (have > 0) {
        const k = Math.sqrt(want2 / have);
        points = points.map((p) => ({ x: placed.cx + (p.x - placed.cx) * k, y: placed.cy + (p.y - placed.cy) * k }));
      }
      const area = polygonArea(points) / (w * h);
      this.mountains.push({
        points,
        cx: placed.cx,
        cy: placed.cy,
        radius: placed.radius,
        area,
      });
    }
  }
}

/** A single smooth, solid blob - two low-frequency waves, nothing finer. */
function blob(rng, cx, cy, radius, wobble) {
  const n = 40;
  const f1 = rng.range(1.6, 2.4);
  const f2 = rng.range(2.9, 4.1);
  const p1 = rng.range(0, TAU);
  const p2 = rng.range(0, TAU);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    const r = radius * (1 + Math.sin(a * f1 + p1) * wobble + Math.sin(a * f2 + p2) * wobble * 0.35);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i];
    const b = points[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
