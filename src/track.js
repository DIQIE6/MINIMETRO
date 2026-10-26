import { CONFIG } from './config.js';
import { dist } from './geometry.js';

/**
 * Track geometry.
 *
 * Mini Metro style maps only use horizontal, vertical and 45 degree track, so
 * every leg between two stations is routed as at most two such segments: one
 * long straight run plus a 135 degree turn onto the diagonal. Corners are then
 * rounded off with a quadratic arc. Nothing steeper than 45 degrees is ever
 * produced, and no corner is ever acute.
 */

const ROUTE_EPS = 1e-6;

/**
 * Bend points needed to travel from `a` to `b` using only 0/45/90 degree
 * segments. Returns [] when the leg is already axis aligned or exactly 45.
 */
export function routeLeg(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < ROUTE_EPS || ady < ROUTE_EPS) return [];
  if (Math.abs(adx - ady) < ROUTE_EPS) return [];
  if (adx > ady) {
    // Long horizontal run first, then a 45 degree run into the station.
    return [{ x: b.x - Math.sign(dx) * ady, y: a.y }];
  }
  // Long vertical run first, then a 45 degree run into the station.
  return [{ x: a.x, y: b.y - Math.sign(dy) * adx }];
}

/** The angle (in degrees, 0 = horizontal) of a segment. */
export function segmentAngleDeg(a, b) {
  const deg = (Math.atan2(Math.abs(b.y - a.y), Math.abs(b.x - a.x)) * 180) / Math.PI;
  return deg;
}

function emitCorner(out, previous, corner, next, radius, samples) {
  const la = dist(previous.x, previous.y, corner.x, corner.y);
  const lb = dist(next.x, next.y, corner.x, corner.y);
  if (la < ROUTE_EPS || lb < ROUTE_EPS) {
    out.push({ x: corner.x, y: corner.y });
    return;
  }
  const r = Math.min(radius, la * 0.5, lb * 0.5);
  if (r < 2) {
    out.push({ x: corner.x, y: corner.y });
    return;
  }
  const p1 = {
    x: corner.x + ((previous.x - corner.x) / la) * r,
    y: corner.y + ((previous.y - corner.y) / la) * r,
  };
  const p2 = {
    x: corner.x + ((next.x - corner.x) / lb) * r,
    y: corner.y + ((next.y - corner.y) / lb) * r,
  };
  out.push(p1);
  for (let s = 1; s < samples; s++) {
    const t = s / samples;
    const mt = 1 - t;
    out.push({
      x: mt * mt * p1.x + 2 * mt * t * corner.x + t * t * p2.x,
      y: mt * mt * p1.y + 2 * mt * t * corner.y + t * t * p2.y,
    });
  }
  out.push(p2);
}

/**
 * Build the drawable path for a station list.
 *
 * @returns {{points:{x:number,y:number}[], cum:number[], total:number, stationS:number[], cornerCount:number}}
 *   `stationS[i]` is the arc position of station i along `points`, so trains
 *   and the renderer can both work in path space.
 */
export function buildLinePath(stations, isLoop, options = {}) {
  const radius = options.cornerRadius ?? CONFIG.track.cornerRadius;
  const samples = options.cornerSamples ?? CONFIG.track.cornerSamples;
  const n = stations.length;
  if (!n) return { points: [], cum: [], total: 0, stationS: [], cornerCount: 0 };

  /** Raw polyline: station positions plus un-rounded bend points. */
  const raw = [];
  for (let i = 0; i < n; i++) {
    raw.push({ x: stations[i].x, y: stations[i].y, stationIndex: i });
    if (i + 1 < n) {
      for (const bend of routeLeg(stations[i], stations[i + 1])) raw.push({ ...bend, corner: true });
    }
  }
  const loop = isLoop && n >= 3;
  if (loop) {
    for (const bend of routeLeg(stations[n - 1], stations[0])) raw.push({ ...bend, corner: true });
    raw.push({ x: stations[0].x, y: stations[0].y, stationIndex: 0, closing: true });
  }

  const points = [];
  const stationS = new Array(n).fill(0);
  const seen = new Array(n).fill(false);
  let cornerCount = 0;

  for (let i = 0; i < raw.length; i++) {
    const p = raw[i];
    const isCorner = p.corner === true && i > 0 && i < raw.length - 1;
    if (isCorner) {
      emitCorner(points, raw[i - 1], p, raw[i + 1], radius, samples);
      cornerCount++;
      continue;
    }
    if (p.stationIndex !== undefined && !seen[p.stationIndex]) {
      seen[p.stationIndex] = true;
      stationS[p.stationIndex] = points.length;
    }
    points.push({ x: p.x, y: p.y });
  }

  // Convert point indices into arc distances.
  const cum = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + dist(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
  }
  const total = cum[cum.length - 1] || 0;
  const arc = stationS.map((index) => cum[index] ?? 0);

  return { points, cum, total, stationS: arc, cornerCount };
}

