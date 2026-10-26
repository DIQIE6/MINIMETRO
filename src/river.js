import { CONFIG } from './config.js';

/** World size, for clipping questions answered outside the River class. */
const WORLD = CONFIG.world;
import {
  TAU,
  catmullRom,
  clamp,
  pointPolylineDistance,
  segmentsIntersect,
  buildArcTable,
  countPolylineCrossings,
} from './geometry.js';

/**
 * The map's water: not a single river but a small system of them.
 *
 * A `River` owns a list of open or closed polylines. They can run in any
 * direction, split into tributaries that rejoin elsewhere (a confluence), and
 * close into a ring so they enclose a piece of land. Lines may only cross any
 * of it by spending a tunnel per crossing.
 */
/** The knobs that decide what a map's water looks like. */
export const RIVER_PARAMS = {
  width: [30, 60],
  meander: [0.18, 0.7],
  wiggle: [0.05, 0.35],
  branchChance: [0, 1],
  confluenceChance: [0, 1],
  braidChance: [0, 1],
};

export class River {
  /**
   * @param {object} [params] overrides for CONFIG.river - this is what
   *   tools/river-lab.html and tools/river-tune.mjs explore.
   */
  constructor(rng, world = CONFIG.world, params = null) {
    const cfg = { ...CONFIG.river, ...(params || {}) };
    this.params = cfg;
    this.width = cfg.width;
    this.world = world;
    /** @type {{points: {x:number,y:number}[], table: object, closed: boolean, kind: string}[]} */
    this.segments = [];
    this.generate(rng);
    /** The first river, for consumers that only want one polyline. */
    this.points = this.segments[0]?.points ?? [];
    this.knobs = riverKnobs(this.params);
    this.table = this.segments[0]?.table ?? buildArcTable(this.points);
  }

  // ------------------------------------------------------------------ build

  /**
   * How many times stretch `index` crosses other stretches.
   *
   * Braids are excluded by default: a braid leaves and rejoins its own host, so
   * counting it would report two "crossings" that are really just the island.
   */
  crossingsWith(index, includeBraids = false) {
    const a = this.segments[index];
    if (!a) return 0;
    let n = 0;
    for (let i = 0; i < this.segments.length; i++) {
      if (i === index) continue;
      const other = this.segments[i];
      if (!includeBraids && (other.kind === 'braid' || a.kind === 'braid')) continue;
      n += countPolylineCrossings(a.points, other.points);
    }
    return n;
  }

  generate(rng) {
    const cfg = this.params;
    const count = rng.int(cfg.count[0], cfg.count[1]);
    // The first river always crosses the map, so the early game always has a
    // clear "two banks" problem to solve. A river drawn between two *adjacent*
    // edges only cuts a corner and leaves the map nearly waterless, so retry
    // until the system actually spans the map.
    const need = cfg.minSpan ?? 0.7;
    let accepted = false;
    for (let attempt = 0; attempt < 5 && !accepted; attempt++) {
      const mark = this.segments.length;
      // After a couple of failures, insist on opposite edges.
      this.addOpen(rng, attempt >= 2);
      if (this.systemSpan() >= need) accepted = true;
      else this.segments.length = mark;
    }
    if (!accepted) this.addOpen(rng, true, true);
    for (let i = 1; i < count; i++) {
      // Two trunk channels that cross each other are very expensive to bridge:
      // every crossing costs a tunnel. Re-roll a few times and keep the trunk
      // that crosses the least, preferring no crossing at all.
      let best = null;
      let bestCross = Infinity;
      for (let attempt = 0; attempt < 8; attempt++) {
        const mark = this.segments.length;
        this.addOpen(rng);
        const idx = this.segments.length - 1;
        const cross = this.crossingsWith(idx);
        if (cross < bestCross) {
          bestCross = cross;
          best = this.segments[idx];
        }
        this.segments.length = mark;
        if (bestCross === 0) break;
      }
      if (best) this.segments.push(best);
    }
    const branches = rng.next() < (cfg.branchChance ?? 0.5) ? 1 : 0;
    for (let i = 0; i < branches; i++) this.addBranch(rng);
    // River islands (a 江心洲 / eyot) come from a braided reach: the channel
    // splits and rejoins. A free-floating ring of water does not occur in
    // nature, so that generator is gone.
    // Zero islands is a perfectly good map; more than the cap is never wanted.
    const cap = Math.max(0, Math.min(3, Math.round(cfg.braidCount ?? 3)));
    const braids = cap > 0 && rng.next() < (cfg.braidChance ?? 0.6) ? rng.int(1, cap) : 0;
    for (let i = 0; i < braids; i++) this.addBraid(rng);
  }

  /**
   * How much of the map the water spans: the larger of (width covered / map
   * width, height covered / map height), measured on the visible part.
   * A bbox diagonal would unfairly reject a healthy vertical river, because
   * the map is wider than it is tall.
   */
  systemSpan() {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const { w, h } = this.world;
    for (const seg of this.segments) {
      for (const p of seg.points) {
        // Clip to the world: what matters is how much water is *on screen*, not
        // how far a river wanders outside it.
        const x = clamp(p.x, 0, w);
        const y = clamp(p.y, 0, h);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (!Number.isFinite(minX)) return 0;
    return Math.max((maxX - minX) / w, (maxY - minY) / h);
  }

  edgePoint(rng, edge) {
    const { w, h } = this.world;
    const t = rng.range(0.1, 0.9);
    if (edge === 0) return { x: -60, y: t * h };
    if (edge === 1) return { x: w + 60, y: t * h };
    if (edge === 2) return { x: t * w, y: -60 };
    return { x: t * w, y: h + 60 };
  }

  /** A river that enters on one edge and leaves on another. */
  addOpen(rng, straight = false, forceOpposite = false) {
    const { w, h } = this.world;
    const cfg = this.params;
    const from = rng.int(0, 3);
    // Edges are 0=left, 1=right, 2=top, 3=bottom, so the facing edge is
    // `from ^ 1` - not `from + 2`, which is a *corner* (left -> top) and only
    // clips the map. That off-by-one was why some maps came out almost empty.
    const roll = rng.next();
    const opposite = forceOpposite || straight || roll < 0.85;
    const to = opposite ? from ^ 1 : (from + (roll < 0.93 ? 2 : 3)) % 4;
    const a = this.edgePoint(rng, from);
    const b = this.edgePoint(rng, to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const amp = Math.min(w, h) * cfg.meander;
    // Two smooth waves - one long slow bend plus a shorter wiggle - rather than
    // per-point noise. Random offsets at every sample are what made the rivers
    // look like scribbles; a real river curves continuously.
    const f1 = rng.range(0.6, 1.3);
    const f2 = rng.range(1.9, 3.2);
    const p1 = rng.range(0, TAU);
    const p2 = rng.range(0, TAU);
    const w1 = amp * rng.range(0.7, 1);
    const w2 = amp * (cfg.wiggle ?? 0.18) * rng.range(0.7, 1.3);
    const steps = 16;
    const margin = 24;
    const ctrl = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const off = Math.sin(t * Math.PI * f1 + p1) * w1 + Math.sin(t * Math.PI * f2 + p2) * w2;
      // Ease the wander out at both ends so the river meets the edge cleanly.
      const taper = Math.sin(t * Math.PI) ** 0.3;
      let px = a.x + dx * t + nx * off * taper;
      let py = a.y + dy * t + ny * off * taper;
      // A vertical river would otherwise wander off the side of the map and
      // leave it nearly empty, so the middle of the stretch is clamped inside.
      // The two ends are deliberately left free - and so are the points just
      // inside them: clamping those while the end sits outside the world bends
      // the centreline into a sharp corner at the border, and a sharp corner
      // used to pinch the river to nothing there (a visible break).
      if (i >= 2 && i <= steps - 2) {
        px = clamp(px, margin, w - margin);
        py = clamp(py, margin, h - margin);
      }
      ctrl.push({ x: px, y: py });
    }
    const girth = rng.range(0.95, 1.25);
    // Nearly constant along its length. A river does widen downstream in
    // reality, but only because tributaries join it - and that is modelled
    // explicitly by the bump a confluence adds. An arbitrary taper just made
    // the visible end look swollen.
    this.push(ctrl, false, 'river', [girth * 0.98, girth * 1.06]);
  }

  /**
   * A braided (anabranching) reach: the river splits at one point and rejoins
   * itself further down, enclosing a piece of land. Both ends lie on the host,
   * so they are continuous with it - this is the "river around an island" that
   * real deltas and braided plains are full of.
   */
  addBraid(rng) {
    // Two braids on the same host weave into each other and read as a mess, so
    // `maxBraidsPerRiver` (default 1) caps how many a single river may take.
    const perRiver = Math.max(1, Math.round(cfgMax(this.params)));
    // An island only goes on a river that does not cross any other water. A
    // braided reach on a crossing trunk would force the player into several
    // tunnels at once, which is unplayable.
    const hosts = this.segments.filter(
      (s2, i) =>
        s2.kind === 'river' &&
        s2.points.length > 20 &&
        (s2.braidCount ?? 0) < perRiver &&
        this.crossingsWith(i) === 0,
    );
    if (!hosts.length) return false;
    const host = hosts[rng.int(0, hosts.length - 1)];
    host.braidCount = (host.braidCount ?? 0) + 1;
    // Keep the whole island inside the stretch you can actually see, so it
    // never straddles the edge of the map.
    const [v0, v1] = host.visibleRange();
    const span = v1 - v0;
    const t0 = v0 + span * rng.range(0.12, 0.42);
    const t1 = Math.min(v1 - span * 0.06, t0 + span * rng.range(0.26, 0.44));
    const A = pointAlong(host.points, t0);
    const B = pointAlong(host.points, t1);
    const dx = B.x - A.x;
    const dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const side = rng.next() < 0.5 ? 1 : -1;
    const hostHalf = host.halfAt((t0 + t1) / 2);
    const bulge = Math.max(rng.range(0.05, 0.11) * Math.min(this.world.w, this.world.h), hostHalf * 3.2);
    const ctrl = [{ ...A }];
    const steps = 4;
    for (let i = 1; i < steps; i++) {
      const u = i / steps;
      const bow = Math.sin(u * Math.PI);
      ctrl.push({
        x: clamp(A.x + dx * u + nx * side * bulge * bow, 24, this.world.w - 24),
        y: clamp(A.y + dy * u + ny * side * bulge * bow, 24, this.world.h - 24),
      });
    }
    ctrl.push({ ...B });
    // Each channel of a braid carries part of the flow, so both are narrower
    // than the undivided river - but not so thin that the split reads as a
    // scratch alongside the trunk.
    const each = rng.range(0.55, 0.72);
    this.push(ctrl, false, 'braid', [each, each]);
    // The main channel thins between the split and the rejoin for the same reason.
    host.addBump((t0 + t1) / 2, -hostHalf * 0.22, 0.18);
    return true;
  }

  /** A tributary that splits off a river, and often joins another one. */
  addBranch(rng) {
    const cfg = this.params;
    if (!this.segments.length) return;
    const host = this.segments[rng.int(0, this.segments.length - 1)];
    const t = rng.range(0.2, 0.8);
    const at = pointAlong(host.points, t);
    const side = rng.next() < 0.5 ? 1 : -1;
    // Leave at a *shallow* angle - real tributaries peel off at 15-35 degrees,
    // and a steep departure is what read as an abrupt, ugly fork.
    let heading = localHeading(host.points, t) + side * rng.range(0.26, 0.6);
    let p = { ...at };
    // Start a little upstream *on* the host and run along it before peeling
    // away, so the fork is a smooth Y instead of a corner.
    const peel = pointAlong(host.points, Math.max(0.02, t - 0.035));
    const ctrl = [{ ...peel }, { ...at }];
    // A creek is thinner than its trunk but never a hairline, and it stays
    // about that width: it is the *host* that grows when they merge.
    const from = rng.range(0.42, 0.55);
    const to = rng.range(0.5, 0.64);
    const step = Math.min(this.world.w, this.world.h) * rng.range(0.16, 0.26);
    const steps = rng.int(3, 4);
    const lo = -50;
    const hiX = this.world.w + 50;
    const hiY = this.world.h + 50;
    for (let i = 0; i < steps; i++) {
      heading += rng.range(-0.26, 0.26);
      let nx = p.x + Math.cos(heading) * step;
      let ny = p.y + Math.sin(heading) * step;
      // Reflect off the edge rather than clamping: clamping stacks samples on
      // top of each other and the spline turns them into a cusp.
      if (nx < lo || nx > hiX) {
        heading = Math.PI - heading;
        nx = clamp(nx, lo, hiX);
      }
      if (ny < lo || ny > hiY) {
        heading = -heading;
        ny = clamp(ny, lo, hiY);
      }
      p = { x: nx, y: ny };
      ctrl.push({ ...p });
    }
    // If it is not going to join another river, run it off the map instead:
    // a wide flat stump stopping in open land is what looked like a bulge.
    let joins = rng.next() < cfg.confluenceChance && this.segments.length > 0;
    if (!joins) {
      const lo = -30;
      const hiX = this.world.w + 30;
      const hiY = this.world.h + 30;
      let guard = 0;
      while (p.x > lo && p.x < hiX && p.y > lo && p.y < hiY && guard++ < 40) {
        heading += rng.range(-0.2, 0.2);
        p = { x: p.x + Math.cos(heading) * step, y: p.y + Math.sin(heading) * step };
        ctrl.push({ ...p });
      }
      // Still inside after all that? Walk it to the nearest edge, so a
      // tributary can never end in the middle of the map as a wide stump.
      if (p.x > 0 && p.x < this.world.w && p.y > 0 && p.y < this.world.h) {
        const opts = [
          { d: p.x, x: -30, y: p.y },
          { d: this.world.w - p.x, x: this.world.w + 30, y: p.y },
          { d: p.y, x: p.x, y: -30 },
          { d: this.world.h - p.y, x: p.x, y: this.world.h + 30 },
        ].sort((m, n) => m.d - n.d);
        const exit = opts[0];
        ctrl.push({ x: (p.x + exit.x) / 2, y: (p.y + exit.y) / 2 });
        ctrl.push({ x: exit.x, y: exit.y });
      } else {
        ctrl.push({ x: Math.max(lo, Math.min(hiX, p.x)), y: Math.max(lo, Math.min(hiY, p.y)) });
      }
      this.push(ctrl, false, 'branch', [from, to]);
      return;
    }

    // A confluence. The hard part is the join: simply ending the tributary on
    // another river leaves a T-shaped kink. Instead the last leg is swung
    // round to run *along* the receiving river, and a short stub carries on
    // past the meeting point, so the two read as one stream.
    if (joins) {
      const other = this.segments[rng.int(0, this.segments.length - 1)];
      const jt = rng.range(0.2, 0.8);
      // Approach and leave along the receiving river *itself*, not along a
      // straight tangent: a tangent drifts away from a curving trunk and left a
      // thin sliver floating past the junction.
      const approach = pointAlong(other.points, Math.max(0.02, jt - 0.07));
      const join = pointAlong(other.points, jt);
      const after = pointAlong(other.points, Math.min(0.98, jt + 0.06));
      // End the tributary clearly narrower than its host: the flat end then
      // sits inside the host's water and disappears, instead of poking out as a
      // blob at the junction.
      const hostWidth = other.halfAt(jt) * 2;
      const endScale = Math.min(to, (hostWidth * 0.55) / this.params.width);
      if (ctrl.length > 2) ctrl.pop();
      ctrl.push({ ...approach });
      ctrl.push({ ...join });
      ctrl.push({ ...after });
      this.push(ctrl, false, 'branch', [from, Math.max(0.25, endScale)]);
      // Downstream of a junction the host carries both flows, so it is wider.
      other.addBump(jt + 0.06, (hostWidth * 0.55) / 2, 0.16);
      return;
    }
    this.push(ctrl, false, 'branch', [from, to]);
  }

  /**
   * @param {[number, number]} [widths] absolute width at the start and the end
   *   of the stretch, as a multiple of CONFIG.river.width. Rivers widen
   *   downstream and tributaries are thinner than their trunk, which is what
   *   makes a confluence read as one stream.
   */
  push(ctrl, closed, kind, widths = [1, 1]) {
    // Coincident control points make the spline kink, so drop them first.
    const cleaned = [];
    for (const pt of ctrl) {
      const last = cleaned[cleaned.length - 1];
      if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1) continue;
      cleaned.push(pt);
    }
    ctrl = cleaned;
    if (ctrl.length < 2) return;
    // De-kink: any control point that doubles back is pulled halfway towards
    // the midpoint of its neighbours. This is what keeps tributaries and their
    // junctions from reading as stiff zig-zags.
    const from = closed ? 0 : 1;
    const to = closed ? ctrl.length : ctrl.length - 1;
    for (let pass = 0; pass < 4; pass++) {
      for (let i = from; i < to; i++) {
        const a = ctrl[(i - 1 + ctrl.length) % ctrl.length];
        const b = ctrl[i % ctrl.length];
        const c = ctrl[(i + 1) % ctrl.length];
        const a1 = Math.atan2(b.y - a.y, b.x - a.x);
        const a2 = Math.atan2(c.y - b.y, c.x - b.x);
        let turn = Math.abs(a1 - a2);
        if (turn > Math.PI) turn = TAU - turn;
        if (turn < 0.8) continue; // ~46 degrees
        b.x = b.x * 0.5 + ((a.x + c.x) / 2) * 0.5;
        b.y = b.y * 0.5 + ((a.y + c.y) / 2) * 0.5;
      }
    }
    let points = catmullRom(ctrl, CONFIG.river.samplesPerSegment);
    // A ring is built with its first control point repeated so the spline
    // closes; that leaves a duplicate sample and a zero-length edge at the
    // seam, which made the outline cross itself. The outline wraps by index,
    // so drop it.
    if (closed && points.length > 2) points = points.slice(0, -1);
    const base = this.params.width;
    const [s0, s1] = widths;
    const w0 = base * s0;
    const w1 = base * s1;
    this.segments.push({
      points,
      table: buildArcTable(points),
      closed,
      kind,
      w0,
      w1,
      /** Local widenings, e.g. just below a confluence. */
      bumps: [],
      /**
       * The fraction of this stretch that is inside the map. A widening placed
       * outside it (or right on the border) makes the river look swollen where
       * it meets the edge of the world.
       */
      visibleRange() {
        const pts = this.points;
        const n = pts.length;
        const w = WORLD.w;
        const h = WORLD.h;
        let first = -1;
        let last = -1;
        for (let i = 0; i < n; i++) {
          const p2 = pts[i];
          if (p2.x > 0 && p2.x < w && p2.y > 0 && p2.y < h) {
            if (first < 0) first = i;
            last = i;
          }
        }
        if (first < 0) return [0, 1];
        return [first / (n - 1), last / (n - 1)];
      },
      addBump(t, amount, span = 0.12) {
        // Keep widenings in the middle of the visible stretch: near either end
        // they read as the river fattening towards its end.
        const [v0, v1] = this.visibleRange();
        const span2 = (v1 - v0) * 0.18;
        const lo = v0 + span2;
        const hi = v1 - span2;
        const at = hi > lo ? Math.max(lo, Math.min(hi, t)) : (v0 + v1) / 2;
        this.bumps.push({ t: at, amount, span });
        this.maxHalf = Math.max(this.maxHalf ?? 0, (w0 + w1) / 4 + amount);
      },
      /** Half width at a fraction along this stretch. */
      halfAt(t) {
        const u = Math.max(0, Math.min(1, t));
        let h = (w0 + (w1 - w0) * u) / 2;
        for (const b of this.bumps) {
          const d = Math.abs(u - b.t);
          if (d < b.span) {
            const k = 1 - d / b.span;
            h += b.amount * k * k;
          }
        }
        return h;
      },
      maxHalf: Math.max(w0, w1) / 2,
    });
  }

  // ------------------------------------------------------------------ query

  distanceTo(x, y) {
    let best = Infinity;
    for (const seg of this.segments) {
      const d = pointPolylineDistance(x, y, seg.points);
      if (d < best) best = d;
    }
    return best;
  }

  /** Half width of the water nearest to a point (rivers are not uniform). */
  halfWidthAt(x, y) {
    let best = this.width / 2;
    let bestD = Infinity;
    for (const seg of this.segments) {
      const pts = seg.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2));
        const d = Math.hypot(x - (a.x + dx * t), y - (a.y + dy * t));
        if (d < bestD) {
          bestD = d;
          const u = seg.table.total > 0 ? (seg.table.cum[i] + (seg.table.cum[i + 1] - seg.table.cum[i]) * t) / seg.table.total : 0;
          best = seg.halfAt(u);
        }
      }
    }
    return best;
  }

  /** True while the point is on the water itself. */
  isWater(x, y, pad = 0) {
    return this.distanceTo(x, y) < this.halfWidthAt(x, y) + pad;
  }

  /**
   * Points where a polyline crosses any of the water. Crossings closer
   * together than the river is wide are treated as one, so a line crossing
   * right at a confluence is not charged for the same hole twice.
   */
  crossingPoints(points) {
    if (!points || points.length < 2) return [];
    const hits = [];
    const mergeDist = this.width * 0.9;
    for (const seg of this.segments) {
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i];
        const b = points[i + 1];
        for (let j = 0; j + 1 < seg.points.length; j++) {
          const c = seg.points[j];
          const d = seg.points[j + 1];
          if (!segmentsIntersect(a, b, c, d)) continue;
          const hit = segmentIntersection(a, b, c, d);
          if (!hit) continue;
          if (hits.some((h) => Math.hypot(h.x - hit.x, h.y - hit.y) < mergeDist)) continue;
          hits.push(hit);
        }
      }
    }
    return hits;
  }

  /** How many tunnels a line needs to follow this polyline. */
  crossings(points) {
    return this.crossingPoints(points).length;
  }

  /**
   * Whether the water separates two points. This replaces the old "which bank"
   * test: with branches and islands a global bank sign does not exist, but the
   * question that actually matters - "would a straight link need a tunnel?" -
   * is well defined for any topology.
   */
  separated(a, b) {
    if (!a || !b) return false;
    return this.crossings([a, b]) > 0;
  }
}

/**
 * Closed outline of a stretch of water, widened by \`pad\` (the bank).
 *
 * The sides are offset from the centreline using the stretch's own width
 * profile, so rivers taper. The result is wound consistently so overlapping
 * stretches can be filled as one union.
 */
function circumRadius(p0, p1, p2) {
  const a = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const b = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const c = Math.hypot(p2.x - p0.x, p2.y - p0.y);
  const area = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y)) / 2;
  if (area < 1e-6) return Infinity;
  return (a * b * c) / (4 * area);
}

export function stretchOutline(seg, pad = 0) {
  const pts = seg.points;
  const n = pts.length;
  if (n < 2) return [];
  const closed = !!seg.closed;
  const left = [];
  const right = [];
  // Wrap for a ring, clamp for an open stretch: an open river's first and
  // last points have no neighbour on one side.
  const step = (i) => (closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i)));
  for (let i = 0; i < n; i++) {
    const a = pts[step(i - 1)];
    const b = pts[step(i + 1)];
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Offsetting a curve tighter than its own width folds the inner side over
    // itself, and under the non-zero winding rule that fold cancels out - it
    // punched a small hole in the water at tight bends. Clamping the offset to
    // the local radius of curvature stops the fold from ever forming.
    const radius = circumRadius(a, pts[i], b);
    // Miter limit: never offset wider than the local radius of curvature, or
    // the inner side folds over itself and the non-zero winding rule fills the
    // fold as a gap. Floored at 45% of the intended width so a genuinely sharp
    // bend can narrow the channel but can never cut it in two.
    //
    // There used to be a second guard here - "never wider than half the sample
    // spacing" - which was catastrophic: the centreline is resampled densely
    // (about 7 px apart) while a river is ~54 px wide, so it clamped the whole
    // river down to ~16% of its width. The two ends, where the spacing measure
    // collapses to zero, escaped the clamp and drew at full width - which is
    // exactly the "the end suddenly gets wide" that kept being reported.
    const want = seg.halfAt(n > 1 ? i / (n - 1) : 0) + pad;
    const h = Math.min(want, Math.max(radius * 0.9, want * 0.45));
    left.push({ x: pts[i].x - dy * h, y: pts[i].y + dx * h });
    right.push({ x: pts[i].x + dy * h, y: pts[i].y - dx * h });
  }
  const poly = left.concat(right.reverse());

  // Keep the winding consistent, otherwise overlapping rivers would cancel out.
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area < 0 ? poly.reverse() : poly;
}

/** The six numbers a map's water is generated from. */
export function riverKnobs(source) {
  // Accept a River as well as a plain config: passing the instance by mistake
  // used to silently drop every knob the instance does not mirror as a field.
  const cfg = source && source.params ? source.params : source || {};
  return {
    width: cfg.width,
    meander: cfg.meander,
    wiggle: cfg.wiggle ?? 0.18,
    branchChance: cfg.branchChance ?? 0.5,
    confluenceChance: cfg.confluenceChance,
    braidChance: cfg.braidChance ?? 0.6,
    braidCount: Math.max(0, Math.min(3, Math.round(cfg.braidCount ?? 3))),
  };
}

/** Islands allowed on one river. */
function cfgMax(params) {
  return params?.maxBraidsPerRiver ?? 1;
}

/** Point at fraction `t` along a polyline. */
function pointAlong(points, t) {
  if (!points.length) return { x: 0, y: 0 };
  const table = buildArcTable(points);
  const target = table.total * clamp(t, 0, 1);
  let best = points[0];
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    const d = Math.abs(table.cum[i] - target);
    if (d < bestD) {
      bestD = d;
      best = points[i];
    }
  }
  return { x: best.x, y: best.y };
}

/** Direction of the polyline at fraction `t`. */
function localHeading(points, t) {
  const i = Math.min(points.length - 2, Math.max(0, Math.floor(t * (points.length - 1))));
  const a = points[i];
  const b = points[i + 1];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Intersection point of two segments known to cross. */
function segmentIntersection(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  return { x: a.x + r.x * t, y: a.y + r.y * t };
}
