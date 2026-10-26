import { CONFIG, PALETTE } from './config.js';
import { normLegKey, legIndexAt } from './geometry.js';
import { shapeOutline, shapeFill, isSpecialShape } from './shapes.js';
import { TAU, samplePolyline, dist, pointSegmentDistance } from './geometry.js';
import { stretchOutline } from './river.js';

/** Car geometry, shared by the map and the drag ghost. */
const CAR_LEN = 27;
const CAR_W = 19;
const GAP = 3;
const PER_CAR = 6;
const COLS = 3;
/** Passenger glyphs are solid and deliberately chunky. */
const GLYPH_R = 4.6;
/** How far the pale bank sticks out around a river. */
const RIVER_BANK = 4;

const ROUND = (ctx, x, y, w, h, r) => {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x - w / 2 + rr, y - h / 2);
  ctx.lineTo(x + w / 2 - rr, y - h / 2);
  ctx.quadraticCurveTo(x + w / 2, y - h / 2, x + w / 2, y - h / 2 + rr);
  ctx.lineTo(x + w / 2, y + h / 2 - rr);
  ctx.quadraticCurveTo(x + w / 2, y + h / 2, x + w / 2 - rr, y + h / 2);
  ctx.lineTo(x - w / 2 + rr, y + h / 2);
  ctx.quadraticCurveTo(x - w / 2, y + h / 2, x - w / 2, y + h / 2 - rr);
  ctx.lineTo(x - w / 2, y - h / 2 + rr);
  ctx.quadraticCurveTo(x - w / 2, y - h / 2, x - w / 2 + rr, y - h / 2);
  ctx.closePath();
};

/** Position + tangent at an arc distance, wrapping around a loop. */
function samplePolylineRoute(route, s) {
  const path = route.path;
  if (!path || path.total <= 0) return null;
  const at = route.isLoop ? s : Math.max(0, Math.min(path.total, s));
  return samplePolyline(path.points, path, at);
}

function tracePath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
}

/**
 * Canvas renderer. The HUD lives in the DOM; everything on the map is drawn
 * here, in fixed world coordinates that get letterboxed into the viewport.
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.dpr = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.time = 0;
  }

  resize(cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.canvas.width = Math.max(1, Math.round(cssW * dpr));
    this.canvas.height = Math.max(1, Math.round(cssH * dpr));
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;

    // The transform depends on how much of the map is revealed, so it is
    // recomputed every frame in fit().
    this.fit(CONFIG.world);
  }

  /** Frame a rectangle of the world inside the viewport. */
  fit(rect) {
    const pad = 10;
    this.scale = Math.min((this.cssW - pad * 2) / rect.w, (this.cssH - pad * 2) / rect.h);
    this.ox = (this.cssW - rect.w * this.scale) / 2 - rect.x * this.scale;
    this.oy = (this.cssH - rect.h * this.scale) / 2 - rect.y * this.scale;
  }

  toWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.ox) / this.scale,
      y: (clientY - rect.top - this.oy) / this.scale,
    };
  }

  clear() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = PALETTE.bgAlt;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
  }

  draw(game, view, dt = 0) {
    this.time += dt;
    // Follow the reveal: whatever part of the map is currently visible is what
    // the canvas frames.
    if (game?.viewRect) this.fit(game.viewRect());
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.fillStyle = PALETTE.bgAlt;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    ctx.save();
    ctx.translate(this.ox, this.oy);
    ctx.scale(this.scale, this.scale);
    ctx.beginPath();
    ctx.rect(0, 0, CONFIG.world.w, CONFIG.world.h);
    ctx.clip();
    ctx.fillStyle = PALETTE.bg;
    ctx.fillRect(0, 0, CONFIG.world.w, CONFIG.world.h);

    this.drawTerrain(ctx, game);
    this.drawRiver(ctx, game);
    this.drawGhostRoutes(ctx, game);
    this.drawLines(ctx, game, 'casing');
    this.drawLines(ctx, game, 'color');
    this.drawDragPreview(ctx, game, view);
    this.drawSegmentPreview(ctx, game, view);
    this.drawStations(ctx, game, view);
    this.drawStationAnchors(ctx, game, view);
    this.drawPassThroughs(ctx, game);
    // Trains sit above the stations, otherwise a stopped train (and everyone
    // riding in it) would be completely hidden by the platform shape.
    this.drawTrains(ctx, game);
    this.drawVehicleDrag(ctx, game, view);
    this.drawGhost(ctx, game, view);

    ctx.restore();
  }

  // ---------------------------------------------------------------- pieces

  /**
   * Hills. Drawn before the water so a hill never sits on top of a river, as a
   * single flat green mass.
   */
  drawTerrain(ctx, game) {
    if (!game.terrain || !game.terrain.mountains.length) return;
    ctx.save();
    for (const m of game.terrain.mountains) {
      const pts = m.points;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      // One flat green mass. No stipple, no shading: the hill is simply a
      // solid block of ground.
      ctx.fillStyle = PALETTE.mountain;
      ctx.fill();
      ctx.strokeStyle = PALETTE.mountainEdge;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Trace a line's track, offsetting each shared leg sideways.
   *
   * Lines that share a stretch of track would otherwise be drawn on top of one
   * another. Each leg is traced separately with its own perpendicular offset,
   * so both lines are visible and both can be grabbed. The joints between legs
   * sit under the station discs, which are drawn on top.
   */
  traceLinePath(ctx, line, offsets) {
    const pts = line.path.points;
    ctx.beginPath();
    if (!pts.length) return;
    const off = offsets ? offsets.get(line.id) : null;
    if (!off || !off.size || !line.path.cum || !line.stationS || line.stationS.length < 2) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      return;
    }
    const cum = line.path.cum;
    const S = line.stationS;
    const st = line.stations;
    const legs = [];
    for (let i = 0; i + 1 < S.length; i++) {
      // `flip` matters: the perpendicular normal follows the direction of
      // travel, but the leg key is order-free. Two lines crossing the same leg
      // in opposite directions would otherwise shift to the same side.
      legs.push({
        s0: S[i],
        s1: S[i + 1],
        key: normLegKey(st[i].id, st[i + 1].id),
        flip: st[i].id > st[i + 1].id,
      });
    }
    if (line.isLoop && S.length >= 3) {
      const n = st.length;
      legs.push({
        s0: S[S.length - 1],
        s1: line.path.total,
        key: normLegKey(st[n - 1].id, st[0].id),
        flip: st[n - 1].id > st[0].id,
      });
    }
    for (const leg of legs) {
      const raw = off.get(leg.key) || 0;
      const shift = leg.flip ? -raw : raw;
      let from = -1;
      let to = -1;
      for (let i = 0; i < cum.length; i++) {
        if (cum[i] >= leg.s0 - 0.001) {
          if (from < 0) from = i;
          if (cum[i] <= leg.s1 + 0.001) to = i;
        }
      }
      if (from < 0 || to <= from) continue;
      for (let i = from; i <= to; i++) {
        const a = pts[Math.max(from, i - 1)];
        const b = pts[Math.min(to, i + 1)];
        let x = pts[i].x;
        let y = pts[i].y;
        if (shift) {
          let tx = b.x - a.x;
          let ty = b.y - a.y;
          const len = Math.hypot(tx, ty) || 1;
          tx /= len;
          ty /= len;
          x -= ty * shift;
          y += tx * shift;
        }
        if (i === from) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    }
  }

  drawRiver(ctx, game) {
    const river = game.river;
    const segs = river.segments?.length
      ? river.segments
      : [{ points: river.points, closed: false, halfAt: () => river.width / 2 }];

    // The water is drawn as tapered *strokes*, not as hand-built offset
    // polygons. A polygon offset folds over itself wherever the channel curves
    // tighter than it is wide; the non-zero winding rule then subtracts the
    // fold and punches a hole, which is what "the river has breaks in it"
    // looked like. Canvas joins strokes correctly, so a stroke cannot do that -
    // and splitting each stretch into chunks keeps the width varying.
    const CHUNKS = 16;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = PALETTE.river;
    for (const seg of segs) {
      const pts = seg.points;
      if (!pts || pts.length < 2) continue;
      const n = pts.length;
      for (let c = 0; c < CHUNKS; c++) {
        const t0 = c / CHUNKS;
        const t1 = (c + 1) / CHUNKS;
        const i0 = Math.max(0, Math.floor(t0 * (n - 1)));
        const i1 = Math.min(n - 1, Math.ceil(t1 * (n - 1)));
        if (i1 <= i0) continue;
        ctx.lineWidth = Math.max(1.5, seg.halfAt((t0 + t1) / 2) * 2);
        ctx.beginPath();
        ctx.moveTo(pts[i0].x, pts[i0].y);
        for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * The route a train is still finishing after its line was edited or removed,
   * drawn faded underneath the live track.
   */
  drawGhostRoutes(ctx, game) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const line of game.lines) {
      for (const train of line.trains) {
        const snap = train.frozen;
        if (!snap || !snap.path || snap.path.points.length < 2) continue;
        tracePath(ctx, snap.path.points);
        ctx.globalAlpha = 0.32;
        ctx.strokeStyle = line.color.stroke;
        ctx.lineWidth = 6;
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawLines(ctx, game, pass) {
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const offsets = game.legOffsets ? game.legOffsets() : null;
    for (const line of game.lines) {
      if (!line.isActive) continue;
      if (line.retiring) {
        // A line whose train is still delivering: ghosted until it is done.
        if (pass !== 'color') continue;
        this.traceLinePath(ctx, line, offsets);
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = line.color.stroke;
        ctx.lineWidth = 6;
        ctx.stroke();
        ctx.globalAlpha = 1;
        continue;
      }
      // A line with no locomotive is only a plan: draw it dashed and pale so
      // it never looks like it is carrying anybody.
      if (!line.hasLocomotive) {
        if (pass !== 'color') continue;
        this.traceLinePath(ctx, line, offsets);
        ctx.setLineDash([7, 7]);
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = line.color.stroke;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        continue;
      }
      this.traceLinePath(ctx, line, offsets);
      if (pass === 'casing') {
        ctx.strokeStyle = PALETTE.bg;
        ctx.lineWidth = 11.5;
      } else {
        ctx.strokeStyle = line.color.stroke;
        ctx.lineWidth = 7;
      }
      ctx.stroke();
      if (pass === 'color') this.drawTunnels(ctx, game, line);
    }
    ctx.restore();
  }

  /** Stretches of a line that run under the river, resampled finely. */
  tunnelStretches(game, line) {
    // The hill-tunnel set is part of the key: dragging a tunnel onto a hill
    // must repaint that stretch as dashed straight away.
    const hills = line.tunnelledHills ? [...line.tunnelledHills].sort().join('-') : '';
    const key = `${game.runId}:${line.id}:${line.generation}:${hills}`;
    if (this._tunnelKey === key) return this._tunnelStretches;
    const pts = line.path.points;
    const out = [];
    let run = null;
    // Rivers vary in width, so ask the nearest stretch how wide it is here.
    const halfHere = (x, y) => game.river.halfWidthAt(x, y) + 2;
    const consider = (x, y) => {
      // Water is always tunnelled automatically; a hill only counts once the
      // player has spent a tunnel on this line for it.
      const hill = game.terrain ? game.terrain.mountainAt(x, y) : -1;
      const bored = hill >= 0 && line.isTunnelled(hill);
      if (game.river.distanceTo(x, y) < halfHere(x, y) || bored) {
        if (!run) run = [];
        run.push({ x, y });
      } else if (run) {
        run.push({ x, y });
        out.push(run);
        run = null;
      }
    };
    // Sample along every segment: the river is usually between two vertices.
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(len / 5));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        consider(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
      }
    }
    if (pts.length) consider(pts[pts.length - 1].x, pts[pts.length - 1].y);
    if (run) {
      const last = pts[pts.length - 1];
      run.push({ x: last.x, y: last.y });
      out.push(run);
    }
    this._tunnelKey = key;
    this._tunnelStretches = out;
    return out;
  }

  /** Crossings are drawn as a dashed stretch: that is a tunnel, not a bridge. */
  drawTunnels(ctx, game, line) {
    const stretches = this.tunnelStretches(game, line);
    if (!stretches.length) return;
    ctx.save();
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    for (const stretch of stretches) {
      if (stretch.length < 2) continue;
      // A pale bed first, then dashes in the line colour on top.
      tracePath(ctx, stretch);
      ctx.setLineDash([]);
      ctx.strokeStyle = PALETTE.bg;
      ctx.lineWidth = 9;
      ctx.stroke();
      tracePath(ctx, stretch);
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = line.color.stroke;
      ctx.lineWidth = 7;
      ctx.stroke();
    }
    ctx.restore();
    ctx.setLineDash([]);
  }

  /** The rubber band that follows the pointer while a line is being drawn. */
  drawDragPreview(ctx, game, view) {
    const line = game.draggingLine;
    if (!line || !game.drag) return;
    const pts = game.dragPreviewPoints(view.pointer);
    if (pts.length < 2) return;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.8;
    tracePath(ctx, pts);
    ctx.strokeStyle = line.color.stroke;
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.restore();

    // Ring the station the drop would land on.
    const target = view.hover?.station;
    if (target && target.id !== game.drag.anchorId) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, target.radius + 11, 0, TAU);
      ctx.strokeStyle = line.color.stroke;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    // And pulse the anchor itself.
    const anchor = line.stations.find((s) => s.id === game.drag.anchorId);
    if (anchor) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * 6);
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, anchor.radius + 8 + pulse * 3, 0, TAU);
      ctx.strokeStyle = line.color.stroke;
      ctx.globalAlpha = 0.5 + pulse * 0.4;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /** The grabbed piece of track, bent out towards the pointer. */
  drawSegmentPreview(ctx, game, view) {
    const line = game.reroutingLine;
    if (!line || !game.segmentDrag) return;
    const pts = game.segmentPreviewPoints(view.pointer);
    if (pts.length !== 3) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([10, 8]);
    tracePath(ctx, pts);
    ctx.strokeStyle = line.color.stroke;
    ctx.lineWidth = 6;
    ctx.globalAlpha = 0.85;
    ctx.stroke();
    ctx.restore();

    const target = view.hover?.station;
    if (target && !line.hasStation(target.id)) {
      ctx.beginPath();
      ctx.arc(target.x, target.y, target.radius + 11, 0, TAU);
      ctx.strokeStyle = line.color.stroke;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  }

  /**
   * Turns a point into a rotated train body. Shared by the real trains, the
   * faded placeholder of a train that is on its way, and the one being dragged.
   */
  paintCar(ctx, x, y, angle, color, alpha, passengers, opts = {}) {
    const {
      carLen = CAR_LEN,
      carW = CAR_W,
      perCar = PER_CAR,
      cols = COLS,
      glyphRadius = GLYPH_R,
      windscreen = false,
    } = opts;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ROUND(ctx, 0, 0, carLen, carW, 4);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(40,40,42,0.85)';
    ctx.stroke();

    passengers.forEach((passenger, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      ctx.save();
      ctx.translate((col - 1) * 8.2, (row - 0.5) * 7.6);
      tracePath(ctx, shapeOutline(passenger.destShape, 0, 0, glyphRadius));
      ctx.closePath();
      ctx.fillStyle = PALETTE.ink;
      ctx.fill();
      ctx.restore();
    });

    if (windscreen) {
      ctx.beginPath();
      ctx.arc(carLen / 2 - 4.6, 0, 2.6, 0, TAU);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Arc position of a car trailing `offset` behind the head, wrapping loops. */
  carArc(route, s, dir, offset) {
    const total = route.path.total;
    if (total <= 0) return 0;
    let v = s - dir * offset;
    if (route.isLoop) return ((v % total) + total) % total;
    return Math.max(0, Math.min(total, v));
  }

  /**
   * A train is drawn car by car: each body sits *on* the track at its own arc
   * position and takes the local tangent, so a long train never sticks out
   * straight across a bend.
   */
  /** Where every car of a train currently sits, head first. */
  /** Perpendicular shift for this line at arc `s`: same numbers the track uses. */
  legShiftAt(line, s, offsets) {
    const off = offsets ? offsets.get(line.id) : null;
    if (!off || !off.size) return 0;
    const st = line.stations;
    let leg = legIndexAt(line.stationS, s);
    if (leg < 0) {
      // Past the last station on a loop: that is the closing leg.
      if (line.isLoop && st.length >= 3 && s > line.stationS[line.stationS.length - 1]) leg = st.length - 1;
      else return 0;
    }
    if (leg + 1 >= st.length && !line.isLoop) return 0;
    const a = st[leg].id;
    const b = (leg + 1 < st.length ? st[leg + 1] : st[0]).id;
    const raw = off.get(normLegKey(a, b)) || 0;
    if (!raw) return 0;
    return a > b ? -raw : raw;
  }

  trainCarPositions(line, train, game = null) {
    const route = train.frozen || line;
    if (!route.isActive || route.path.total <= 0) return [];
    const offsets = game && game.legOffsets ? game.legOffsets() : null;
    const total = 1 + train.carriages;
    const step = CAR_LEN + GAP;
    const dir = route.isLoop ? 1 : train.dir;
    const out = [];
    for (let car = 0; car < total; car++) {
      const arc = this.carArc(route, train.s, dir, car * step);
      const at = samplePolylineRoute(route, arc);
      if (!at) continue;
      // Travelling backwards along the arc means the nose points the other way.
      const angle = !route.isLoop && dir < 0 ? at.angle + Math.PI : at.angle;
      // Ride the same shifted track the line is drawn on.
      let x = at.x;
      let y = at.y;
      const shift = this.legShiftAt(route, arc, offsets);
      if (shift) {
        x -= Math.sin(at.angle) * shift;
        y += Math.cos(at.angle) * shift;
      }
      out.push({ x, y, angle, carIndex: car });
    }
    return out;
  }

  drawTrainCars(ctx, line, train, alpha, game = null) {
    const riders = train.passengers;
    const cars = this.trainCarPositions(line, train, game);
    for (let i = cars.length - 1; i >= 0; i--) {
      const car = cars[i];
      const slice = riders.slice(car.carIndex * PER_CAR, car.carIndex * PER_CAR + PER_CAR);
      this.paintCar(ctx, car.x, car.y, car.angle, line.color.stroke, alpha, slice, {
        windscreen: car.carIndex === 0,
      });
    }
  }

  /**
   * Trains are drawn large enough to show who is riding in them: each
   * passenger appears as a little glyph of the shape they are looking for.
   * A train running a frozen route is ghosted along with its track.
   */
  /**
   * Stations the track runs straight through without stopping there. The
   * octilinear route often has to pass exactly over an intermediate station;
   * a thin white bar across the track (its ends poking out past the station)
   * says "through, not stopping".
   */
  passThroughStations(game, line) {
    const key = `${game.runId}:${line.id}:${line.generation}:${game.stationVersion}`;
    if (this._passKey === key) return this._passList;
    const pts = line.path.points;
    const list = [];
    for (const station of game.stations) {
      if (line.hasStation(station.id)) continue;
      let best = Infinity;
      let index = -1;
      for (let i = 0; i + 1 < pts.length; i++) {
        const hit = pointSegmentDistance(station.x, station.y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (hit.d < best) {
          best = hit.d;
          index = i;
        }
      }
      if (index < 0 || best > station.radius * 0.85) continue;
      const a = pts[index];
      const b = pts[index + 1];
      list.push({ station, angle: Math.atan2(b.y - a.y, b.x - a.x) });
    }
    this._passKey = key;
    this._passList = list;
    return list;
  }

  drawPassThroughs(ctx, game) {
    for (const line of game.lines) {
      if (!line.isActive) continue;
      for (const { station, angle } of this.passThroughStations(game, line)) {
        // Show the track actually running across the station, so it reads as
        // "this line goes straight through here".
        ctx.save();
        ctx.beginPath();
        ctx.arc(station.x, station.y, station.radius + 2, 0, TAU);
        ctx.clip();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        tracePath(ctx, line.path.points);
        ctx.strokeStyle = PALETTE.bg;
        ctx.lineWidth = 11.5;
        ctx.stroke();
        ctx.strokeStyle = line.color.stroke;
        ctx.lineWidth = 7;
        ctx.stroke();
        ctx.restore();

        // No slash across it any more: the track simply being drawn over the
        // station is enough to say "this line passes through, it does not stop
        // here" - and it looks far better than a pale bar.
        void angle;
      }
    }
  }

  drawTrains(ctx, game) {
    for (const line of game.lines) {
      if (line.pendingLoco && line.isActive && !line.trains.length) {
        const at = line.stations[0];
        this.paintCar(ctx, at.x, at.y, 0, line.color.stroke, 0.3, [], { windscreen: true });
      }
      for (const train of line.trains) {

      this.drawTrainCars(ctx, line, train, train.frozen ? 0.45 : 1, game);
      }
    }
  }

  /**
   * The vehicle the player is dragging: grey while it is away from any track,
   * tinted with the target line's colour once it is over one.
   */
  drawVehicleDrag(ctx, game, view) {
    const drag = game.vehicleDrag;
    const pointer = view.pointer;
    if (!drag || !pointer) return;

    let target = null;
    if (view.hover?.station) {
      target = game.lineOf(view.hover.station.id);
      if (target && target.retiring) target = null;
    } else if (view.hover?.lineId) {
      target = game.lines.find((l) => l.id === view.hover.lineId) || null;
      if (target && (!target.isActive || target.retiring)) target = null;
    }

    const overLine = !!target;

    // A tunnel drag is shown as a dashed ring over the hill it would pierce.
    if (drag.kind === 'tunnel') {
      const hill = game.terrain ? game.terrain.mountainAt(pointer.x, pointer.y) : -1;
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.lineWidth = 3;
      ctx.strokeStyle = hill >= 0 ? (overLine ? target.color.stroke : '#9d9a95') : '#c0503f';
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, 22, 0, TAU);
      ctx.stroke();
      ctx.restore();
      ctx.setLineDash([]);
      return;
    }
    const color = overLine ? target.color.stroke : '#9d9a95';
    const alpha = overLine ? 0.55 : 0.75;
    let cars = 1;
    if (drag.kind === 'carriage') cars = 1;
    if (drag.kind === 'train') {
      const source = game.lines.find((l) => l.id === drag.fromLineId);
      cars = 1 + (source ? source.carriages : 0);
    }

    for (let i = 0; i < cars; i++) {
      this.paintCar(ctx, pointer.x - i * (CAR_LEN + GAP), pointer.y, 0, color, alpha, [], {
        windscreen: i === 0 && drag.kind !== 'carriage',
      });
    }

    if (drag.kind === 'carriage') {
      ctx.save();
      ctx.strokeStyle = overLine ? '#ffffff' : '#f0eeea';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(pointer.x - 4, pointer.y);
      ctx.lineTo(pointer.x + 4, pointer.y);
      ctx.moveTo(pointer.x, pointer.y - 4);
      ctx.lineTo(pointer.x, pointer.y + 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawStations(ctx, game, view) {
    for (const station of game.stations) {
      const r = station.radius;
      const special = isSpecialShape(station.shape);

      if (station.special || station.isInterchange) {
        const glow = ctx.createRadialGradient(station.x, station.y, r * 0.6, station.x, station.y, r * 2.6);
        glow.addColorStop(0, special ? 'rgba(240,190,80,0.35)' : 'rgba(255,255,255,0.5)');
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(station.x, station.y, r * 2.6, 0, TAU);
        ctx.fill();
      }

      if (station.flash > 0) {
        const p = 1 - station.flash / 0.45;
        ctx.beginPath();
        ctx.arc(station.x, station.y, r + 8 + p * 22, 0, TAU);
        ctx.strokeStyle = `rgba(74,168,92,${Math.max(0, 1 - p) * 0.8})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      const outline = shapeOutline(station.shape, station.x, station.y, r);
      tracePath(ctx, outline);
      ctx.closePath();
      ctx.fillStyle = shapeFill(station.shape, station.isInterchange);
      ctx.fill();
      ctx.lineWidth = station.isInterchange ? 4.4 : 3;
      ctx.strokeStyle = PALETTE.ink;
      ctx.lineJoin = 'round';
      ctx.stroke();

      this.drawPassengers(ctx, station);

      if (station.overcrowdTimer !== null) {
        const p = station.overcrowdProgress;
        const urgency = 1 - p;
        ctx.beginPath();
        ctx.arc(station.x, station.y, r + 27, 0, TAU);
        ctx.strokeStyle = 'rgba(226,86,74,0.18)';
        ctx.lineWidth = 4;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(station.x, station.y, r + 27, -Math.PI / 2, -Math.PI / 2 + TAU * p);
        ctx.strokeStyle = PALETTE.danger;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        ctx.stroke();

        const pulse = 0.5 + 0.5 * Math.sin(this.time * (4 + urgency * 8));
        ctx.beginPath();
        ctx.arc(station.x, station.y, r + 34, 0, TAU);
        ctx.strokeStyle = `rgba(226,86,74,${0.12 + urgency * 0.35 * pulse})`;
        ctx.lineWidth = 2 + urgency * 4;
        ctx.stroke();
      }
    }
  }

  /**
   * Waiting passengers sit in a neat row just above the station, two or three
   * at a time, so they are easy to count and never hide behind the track.
   */
  drawPassengers(ctx, station) {
    const list = station.passengers;
    if (!list.length) return;
    const cap = station.capacity;
    const r = 5.4;
    const stepX = 15.5;
    const stepY = 14;
    const perRow = Math.max(3, Math.min(5, cap));
    for (let i = 0; i < list.length; i++) {
      const extra = i >= cap;
      const index = extra ? i - cap : i;
      const cols = extra ? perRow + 1 : perRow;
      const row = Math.floor(index / cols);
      const col = index % cols;
      const count = Math.min(list.length - (extra ? cap : 0), cols);
      const gx = station.x + (col - (count - 1) / 2) * stepX;
      const gy = station.y - station.radius - 10 - row * stepY;
      const pts = shapeOutline(list[i].destShape, gx, gy, extra ? r * 0.82 : r);
      tracePath(ctx, pts);
      ctx.closePath();
      ctx.fillStyle = extra ? '#8a8a8f' : PALETTE.ink;
      ctx.fill();
    }
  }

  /**
   * Geometry of the T-shaped end marker on a line's terminus: a short stem
   * pointing away from the neighbour, capped by a bar. Dragging it extends
   * that line.
   */
  terminusMarker(line, end, game = null) {
    const n = line.stations.length;
    if (!line || line.isLoop || n < 2) return null;
    const station = line.stations[end === 0 ? 0 : n - 1];
    const neighbour = line.stations[end === 0 ? 1 : n - 2];
    if (!station || !neighbour) return null;
    let dx = station.x - neighbour.x;
    let dy = station.y - neighbour.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Several lines can end at the same station. Stacked T markers are
    // indistinguishable, so they are fanned out by a fixed angle.
    if (game) {
      const siblings = game.activeLines().filter((other) => {
        if (other === line || other.isLoop || other.stations.length < 2) return false;
        const oEnd = end === 0 ? other.stations[0] : other.stations[other.stations.length - 1];
        return oEnd && oEnd.id === station.id;
      });
      if (siblings.length) {
        const all = [line, ...siblings].sort((a, b) => String(a.id).localeCompare(String(b.id)));
        const fan = (all.indexOf(line) - (all.length - 1) / 2) * CONFIG.lines.terminusFan;
        const cs = Math.cos(fan);
        const sn = Math.sin(fan);
        const nx = dx * cs - dy * sn;
        const ny = dx * sn + dy * cs;
        dx = nx;
        dy = ny;
      }
    }
    const base = { x: station.x + dx * (station.radius + 2), y: station.y + dy * (station.radius + 2) };
    const tip = { x: station.x + dx * (station.radius + 19), y: station.y + dy * (station.radius + 19) };
    const px = -dy;
    const py = dx;
    const half = 8.5;
    return {
      station,
      end,
      color: line.color.stroke,
      base,
      tip,
      bar: [
        { x: tip.x - px * half, y: tip.y - py * half },
        { x: tip.x + px * half, y: tip.y + py * half },
      ],
    };
  }

  /**
   * A T on each terminus: "this is where the line ends, drag me to extend it".
   * Dragging the station body instead always starts a new line, so the two
   * gestures never fight.
   */
  drawStationAnchors(ctx, game, view) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const line of game.lines) {
      if (!line.claimed || line.retiring || line.isLoop || line.stations.length < 2) continue;
      for (const end of [0, 1]) {
        const mark = this.terminusMarker(line, end, game);
        if (!mark) continue;
        const hovered =
          view.hover?.terminus?.lineId === line.id && view.hover?.terminus?.end === end;
        ctx.strokeStyle = mark.color;
        ctx.globalAlpha = hovered ? 1 : 0.85;
        ctx.lineWidth = hovered ? 5.5 : 4.5;
        ctx.beginPath();
        ctx.moveTo(mark.base.x, mark.base.y);
        ctx.lineTo(mark.tip.x, mark.tip.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(mark.bar[0].x, mark.bar[0].y);
        ctx.lineTo(mark.bar[1].x, mark.bar[1].y);
        ctx.stroke();
        ctx.globalAlpha = 1;
        if (hovered) {
          ctx.beginPath();
          ctx.arc(mark.tip.x, mark.tip.y, 12, 0, TAU);
          ctx.strokeStyle = mark.color;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 3;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();
  }

  drawGhost(ctx, game, view) {
    if (!view.hover?.station || game.drag) return;
    const station = view.hover.station;
    ctx.beginPath();
    ctx.arc(station.x, station.y, station.radius + 9, 0, TAU);
    ctx.strokeStyle = 'rgba(57,57,59,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

}
