/** 2D helpers shared by the simulation and the renderer. Pure maths, no DOM. */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const dist2 = (ax, ay, bx, by) => {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
};
export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 > 0 ? (wx * vx + wy * vy) / len2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + vx * t;
  const cy = ay + vy * t;
  return { d: dist(px, py, cx, cy), t, cx, cy };
}

export function pointPolylineDistance(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const { d } = pointSegmentDistance(px, py, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
    if (d < best) best = d;
  }
  return best;
}

function orient(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** Strict proper segment intersection (shared endpoints do not count). */
export function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a.x, a.y, b.x, b.y, c.x, c.y);
  const o2 = orient(a.x, a.y, b.x, b.y, d.x, d.y);
  const o3 = orient(c.x, c.y, d.x, d.y, a.x, a.y);
  const o4 = orient(c.x, c.y, d.x, d.y, b.x, b.y);
  const eps = 1e-9;
  if (Math.abs(o1) < eps || Math.abs(o2) < eps || Math.abs(o3) < eps || Math.abs(o4) < eps) {
    return false; // touching/collinear: treat as "no crossing" to stay stable
  }
  return o1 > 0 !== o2 > 0 && o3 > 0 !== o4 > 0;
}

/** How many times a polyline crosses another polyline. */
export function countPolylineCrossings(a, b) {
  let n = 0;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) n++;
    }
  }
  return n;
}

export function catmullRom(points, samplesPerSegment = 12) {
  const n = points.length;
  if (n < 2) return points.slice();
  const out = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    for (let s = 0; s < samplesPerSegment; s++) {
      const t = s / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x:
          0.5 *
          (2 * p1.x +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y:
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push({ ...points[n - 1] });
  return out;
}

/** Arc-length table for a polyline: { cum[i], total }. */
export function buildArcTable(points) {
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  }
  return { cum, total: cum[cum.length - 1] || 0 };
}

/** Position + tangent at arc distance s along a polyline. */
export function samplePolyline(points, table, s) {
  const total = table.total;
  if (total <= 0 || points.length < 2) {
    const p = points[0] || { x: 0, y: 0 };
    return { x: p.x, y: p.y, angle: 0 };
  }
  // Clamp rather than wrap: on an open line, `s === total` means "parked at the
  // far terminal", and wrapping there would draw the train at the wrong end.
  s = clamp(s, 0, total);
  const cum = table.cum;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const segLen = cum[lo + 1] - cum[lo];
  const t = segLen > 0 ? (s - cum[lo]) / segLen : 0;
  const a = points[lo];
  const b = points[lo + 1];
  return {
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    angle: Math.atan2(b.y - a.y, b.x - a.x),
  };
}

export function polygonPoints(cx, cy, radius, sides, rotation = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + (i * TAU) / sides;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return pts;
}

export function starPoints(cx, cy, outer, inner, tips = 5, rotation = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < tips * 2; i++) {
    const a = rotation + (i * Math.PI) / tips;
    const r = i % 2 === 0 ? outer : inner;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

/**
 * A leg is the stretch of track between two stations. Two lines sharing that
 * track may traverse it in opposite directions, so the key is order-free.
 */
export function normLegKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Index of the leg that arc length `s` falls in, or -1. */
export function legIndexAt(stationS, s) {
  for (let i = 0; i + 1 < stationS.length; i++) {
    if (s >= stationS[i] && s <= stationS[i + 1]) return i;
  }
  return -1;
}
