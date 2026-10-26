/**
 * Station / passenger shapes.
 *
 * Every shape is described once and used for three things: hit testing,
 * canvas rendering, and the small passenger glyphs. Shapes are normalised to a
 * unit radius so callers just pass a radius.
 */
import { TAU, starPoints, polygonPoints, clamp } from './geometry.js';

/**
 * Shapes carry a *role* as well as a look. The role decides how often that
 * district appears and, through CONFIG.passenger.flows, where its passengers
 * want to go:
 *
 *   circle   住宅区     by far the most common, and the busiest source
 *   triangle 商业区     common; its people almost all go home to a circle
 *   square   交通枢纽   uncommon, but the biggest destination on the map
 *   cross    医院       exclusive two-way traffic with circles
 *   star     码头       only circles and triangles travel here
 *   diamond  旅游集散   draws on circles and hubs
 *   pentagon 银行       quiet; only triangles go there, never circles
 *   fan      公园       quiet; circles only
 *   gem      公园       kept for older saves / tests
 */
export const SHAPES = {
  circle: { id: 'circle', label: '圆形', role: '住宅区', kind: 'circle', special: false, weight: 1 },
  triangle: { id: 'triangle', label: '三角', role: '商业区', kind: 'poly', sides: 3, rotation: -Math.PI / 2, special: false, weight: 0.62 },
  square: { id: 'square', label: '方形', role: '交通枢纽', kind: 'poly', sides: 4, rotation: Math.PI / 4, special: false, weight: 0.3 },
  cross: { id: 'cross', label: '十字', role: '医院', kind: 'cross', special: true, weight: 0.12 },
  star: { id: 'star', label: '星形', role: '码头', kind: 'star', special: true, weight: 0.12 },
  diamond: { id: 'diamond', label: '菱形', role: '旅游集散', kind: 'poly', sides: 4, rotation: 0, special: true, weight: 0.12 },
  pentagon: { id: 'pentagon', label: '五边', role: '银行', kind: 'poly', sides: 5, rotation: -Math.PI / 2, special: true, weight: 0.12 },
  fan: { id: 'fan', label: '扇形', role: '公园', kind: 'fan', special: true, weight: 0.12 },
  gem: { id: 'gem', label: '宝石', role: '公园', kind: 'poly', sides: 8, rotation: -Math.PI / 2 + Math.PI / 8, special: true, weight: 0.12 },
};

export const NORMAL_SHAPES = ['circle', 'triangle', 'square'];
/** Special districts: each one shows up at most once per map. */
export const SPECIAL_SHAPES = ['star', 'diamond', 'cross', 'pentagon', 'fan'];

export function shapeRole(id) {
  return SHAPES[id]?.role ?? '';
}

export function isSpecialShape(id) {
  return !!SHAPES[id]?.special;
}

/**
 * Every shape is described by a *circumradius*, which makes a circle look much
 * heavier than a triangle at the same radius. Each shape therefore carries a
 * scale factor, chosen so they all cover a similar area.
 */
function normaliseScales() {
  const areaOf = (id) => {
    const pts = rawOutline(id, 0, 0, 1);
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  };
  const target = areaOf('circle');
  for (const id of Object.keys(SHAPES)) {
    const area = areaOf(id) || target;
    // sqrt keeps areas equal; the clamp stops a triangle from turning into a
    // huge spike while still making it clearly bigger than before.
    SHAPES[id].scale = clamp(Math.sqrt(target / area), 1, 1.42);
  }
}

/** Outline in the shape's own units, before the size normalisation. */
function rawOutline(id, cx, cy, r) {
  const s = SHAPES[id] || SHAPES.circle;
  switch (s.kind) {
    case 'circle': {
      const pts = [];
      for (let i = 0; i < 32; i++) {
        const a = (i / 32) * TAU;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      return pts;
    }
    case 'poly':
      return polygonPoints(cx, cy, r, s.sides, s.rotation);
    case 'star':
      return starPoints(cx, cy, r, r * 0.45);
    case 'fan': {
      const pts = [{ x: cx, y: cy }];
      const from = -Math.PI / 2 - Math.PI / 3;
      const to = -Math.PI / 2 + Math.PI / 3;
      for (let i = 0; i <= 12; i++) {
        const a = from + ((to - from) * i) / 12;
        pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
      }
      return pts;
    }
    case 'cross': {
      const a = r * 0.36;
      const b = r;
      return [
        { x: cx - a, y: cy - b },
        { x: cx + a, y: cy - b },
        { x: cx + a, y: cy - a },
        { x: cx + b, y: cy - a },
        { x: cx + b, y: cy + a },
        { x: cx + a, y: cy + a },
        { x: cx + a, y: cy + b },
        { x: cx - a, y: cy + b },
        { x: cx - a, y: cy + a },
        { x: cx - b, y: cy + a },
        { x: cx - b, y: cy - a },
        { x: cx - a, y: cy - a },
      ];
    }
    default:
      return polygonPoints(cx, cy, r, 4, Math.PI / 4);
  }
}

/** Outline of a shape as a closed polygon (circles are approximated). */
export function shapeOutline(id, cx, cy, r) {
  const s = SHAPES[id] || SHAPES.circle;
  return rawOutline(id, cx, cy, r * (s.scale ?? 1));
}

/** How much bigger this shape is drawn than its nominal radius. */
export function shapeScale(id) {
  return SHAPES[id]?.scale ?? 1;
}

normaliseScales();

/** Fill colour for a station body. */
export function shapeFill(id, isInterchange) {
  if (isInterchange) return '#ffffff';
  return isSpecialShape(id) ? '#fff4dc' : '#ffffff';
}
