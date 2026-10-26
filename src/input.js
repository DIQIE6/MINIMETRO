import { GameState } from './game.js';
import { dist, pointPolylineDistance, pointSegmentDistance, normLegKey, legIndexAt } from './geometry.js';

const STATION_PAD = 10;
const LINE_GRAB = 16;
/** How far off a station a drop still counts as landing on it. */
const DROP_PAD = 14;

/**
 * Map interaction.
 *
 *  - Building is a drag: press a station, a coloured anchor lights up on it,
 *    then drag outwards. The line follows the pointer, picks up every station
 *    it passes over, and lands on the one you release on. A plain click does
 *    nothing at all.
 *  - Pressing a *piece of track* instead grabs that segment: both neighbours
 *    stay put and the line is re-routed through whatever station you drop it
 *    on.
 *  - Right-clicking a station that is on a line removes it; the neighbours
 *    close up.
 */
export class InputController {
  constructor(canvas, game, renderer, hooks = {}) {
    this.canvas = canvas;
    this.game = game;
    this.renderer = renderer;
    this.hooks = hooks;
    this.pointer = null;
    this.hover = { station: null, lineId: null, segment: null };
    /** Pointer-down state for the current gesture. */
    this.press = null;
    this.pressEmpty = false;
    this.moved = false;

    this._onDown = (e) => this.pointerDown(e);
    this._onMove = (e) => this.pointerMove(e);
    this._onUp = (e) => this.pointerUp(e);
    this._onLeave = () => {
      this.pointer = null;
    };
    this._onContext = (e) => {
      e.preventDefault();
      this.contextMenu(e);
    };
    this._onKey = (e) => this.keyDown(e);
  }

  attach() {
    this.canvas.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
    this.canvas.addEventListener('pointerleave', this._onLeave);
    this.canvas.addEventListener('contextmenu', this._onContext);
    window.addEventListener('keydown', this._onKey);
  }

  detach() {
    this.canvas.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
    this.canvas.removeEventListener('contextmenu', this._onContext);
    window.removeEventListener('keydown', this._onKey);
  }

  setGame(game) {
    this.game = game;
    this.cancel();
  }

  cancel() {
    this.press = null;
    this.pressEmpty = false;
    this.moved = false;
    this.poolDrag = false;
    if (this.game) {
      this.game.cancelLineDrag();
      this.game.cancelSegmentDrag();
      this.game.cancelVehicleDrag();
      this.game.cancelPlacement();
    }
    this.hooks.onChange?.();
  }

  /** Convert a screen-pixel gesture threshold into world units. */
  screenPixels(px) {
    return px / Math.max(0.05, this.renderer.scale);
  }

  // --------------------------------------------------------------- picking

  hitStation(x, y, pad = 0) {
    let best = null;
    let bestD = Infinity;
    for (const station of this.game.stations) {
      const d = dist(x, y, station.x, station.y);
      if (d > station.radius + STATION_PAD + pad) continue;
      if (d < bestD) {
        bestD = d;
        best = station;
      }
    }
    return best;
  }

  hitLine(x, y) {
    let best = null;
    let bestD = LINE_GRAB;
    for (const line of this.game.activeLines()) {
      const d = pointPolylineDistance(x, y, line.path.points);
      if (d < bestD) {
        bestD = d;
        best = line;
      }
    }
    return best;
  }

  /** The T-shaped terminus marker under the pointer, if any. */
  hitTerminus(x, y) {
    let best = null;
    let bestD = 12;
    for (const line of this.game.lines) {
      if (!line.claimed || line.retiring || line.isLoop || line.stations.length < 2) continue;
      for (const end of [0, 1]) {
        const station = line.stations[end === 0 ? 0 : line.stations.length - 1];
        // Pressing the station body starts a NEW line from that station; only a
        // press outside the body grabs the T. Without this, a zoomed-in station
        // (which is drawn smaller) loses its body to the marker's reach.
        if (station && dist(x, y, station.x, station.y) <= station.radius) continue;
        const mark = this.renderer.terminusMarker(line, end, this.game);
        if (!mark) continue;
        const stem = pointSegmentDistance(x, y, mark.base.x, mark.base.y, mark.tip.x, mark.tip.y).d;
        const bar = pointSegmentDistance(x, y, mark.bar[0].x, mark.bar[0].y, mark.bar[1].x, mark.bar[1].y).d;
        const d = Math.min(stem, bar);
        if (d < bestD) {
          bestD = d;
          best = { lineId: line.id, end, station: mark.station };
        }
      }
    }
    return best;
  }

  /** The individual car under the pointer: head (0) or a carriage (>0). */
  hitCar(x, y) {
    let best = null;
    for (const line of this.game.lines) {
      for (const train of line.trains) {
        for (const car of this.renderer.trainCarPositions(line, train)) {
          const d = dist(x, y, car.x, car.y);
          if (d <= 20 && (!best || d < best.d)) best = { line, train, carIndex: car.carIndex, d };
        }
      }
    }
    return best;
  }

  /**
   * Where a dragged vehicle would land: the nearest line within grabbing
   * distance, and the station on it closest to the pointer (a locomotive
   * "leans" towards the nearest platform).
   */
  hitVehicleTarget(x, y) {
    const seg = this.hitSegment(x, y);
    const line = seg ? seg.line : this.hitLine(x, y);
    if (!line || !line.isActive || line.retiring) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.stations.length; i++) {
      const d = dist(x, y, line.stations[i].x, line.stations[i].y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return { line, stationIndex: best, distance: bestD, x, y };
  }

  /** Called by the HUD when the player drags a vehicle chip out of the tray. */
  beginVehicleDragFromPool(kind, event) {
    const drag = this.game.beginVehicleDrag(kind, null);
    if (!drag) return false;
    if (event) {
      this.pointer = this.renderer.toWorld(event.clientX, event.clientY);
      this.poolDrag = true;
    }
    this.hooks.onChange?.();
    return true;
  }

  /**
   * Which piece of track the pointer is over. Hit tests the drawn path (which
   * bulges away from the straight line between stations) and then maps the hit
   * back to the station pair it belongs to.
   */
  hitSegment(x, y) {
    let best = null;
    const offsets = this.game.legOffsets ? this.game.legOffsets() : null;
    for (const line of this.game.activeLines()) {
      const pts = line.path.points;
      if (pts.length < 2) continue;
      let bestD = LINE_GRAB;
      let bestArc = 0;
      // Where two lines share track they are drawn side by side, so the hit
      // test has to measure against the shifted track too - otherwise the lower
      // line would be visible but impossible to grab.
      const shift = offsets ? offsets.get(line.id) : null;
      for (let i = 0; i + 1 < pts.length; i++) {
        let ax = pts[i].x;
        let ay = pts[i].y;
        let bx = pts[i + 1].x;
        let by = pts[i + 1].y;
        if (shift && shift.size) {
          const leg = legIndexAt(line.stationS, (line.path.cum[i] + line.path.cum[i + 1]) / 2);
          // The normal follows the travel direction, so an order-free leg key
          // needs the sign flipped when the leg is traversed backwards.
          let off =
            leg >= 0 ? shift.get(normLegKey(line.stations[leg].id, line.stations[leg + 1].id)) || 0 : 0;
          if (off && line.stations[leg].id > line.stations[leg + 1].id) off = -off;
          if (off) {
            let tx = bx - ax;
            let ty = by - ay;
            const len = Math.hypot(tx, ty) || 1;
            tx /= len;
            ty /= len;
            ax -= ty * off;
            ay += tx * off;
            bx -= ty * off;
            by += tx * off;
          }
        }
        const hit = pointSegmentDistance(x, y, ax, ay, bx, by);
        if (hit.d < bestD) {
          bestD = hit.d;
          bestArc = line.path.cum[i] + (line.path.cum[i + 1] - line.path.cum[i]) * hit.t;
        }
      }
      if (bestD >= LINE_GRAB) continue;
      const S = line.stationS;
      const n = line.stations.length;
      let index = Math.max(0, n - 2);
      for (let i = 0; i + 1 < n; i++) {
        if (bestArc >= S[i] && bestArc <= S[i + 1]) {
          index = i;
          break;
        }
      }
      if (line.isLoop && bestArc >= S[n - 1]) index = n - 1;
      if (!best || bestD < best.d) best = { line, index, d: bestD };
    }
    return best;
  }

  // ---------------------------------------------------------------- events

  pointerDown(event) {
    if (event.button === 2) return;
    const world = this.renderer.toWorld(event.clientX, event.clientY);
    this.pointer = world;
    const game = this.game;
    if (game.state !== GameState.PLAYING) {
      this.cancel();
      return;
    }
    event.preventDefault();
    try {
      this.canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* synthetic events have no capture target; harmless */
    }

    // Placing a carriage / interchange takes priority over everything else.
    if (game.placement) {
      const station = this.hitStation(world.x, world.y, 6);
      const line = this.hitLine(world.x, world.y);
      if (game.placement.item === 'interchange' && station) game.placeInterchange(station);
      else game.cancelPlacement();
      this.hooks.onChange?.();
      return;
    }

    // A vehicle being dragged out of the tray lands on pointerup.
    if (game.vehicleDrag) return;

    this.press = { x: world.x, y: world.y };
    this.moved = false;
    this.pressEmpty = false;

    const terminus = this.hitTerminus(world.x, world.y);
    if (terminus) {
      game.beginLineDrag(terminus.station, terminus);
      this.hooks.onChange?.();
      return;
    }

    const station = this.hitStation(world.x, world.y);
    // A car sitting in open track is grabbed as a vehicle instead: the head
    // moves the whole train, a carriage can be pulled off on its own.
    if (!station) {
      const car = this.hitCar(world.x, world.y);
      if (car) {
        game.beginVehicleDrag(car.carIndex === 0 ? 'train' : 'carriage', {
          line: car.line,
          train: car.train,
          carIndex: car.carIndex,
        });
        this.hooks.onChange?.();
        return;
      }
    }
    if (station) {
      // Dragging the station body always opens a new line, even at a terminus.
      game.beginLineDrag(station, null);
      this.hooks.onChange?.();
      return;
    }
    const segment = this.hitSegment(world.x, world.y);
    if (segment) {
      game.beginSegmentDrag(segment.line, segment.index);
      this.hooks.onChange?.();
      return;
    }
    this.pressEmpty = true;
  }

  /** Right click removes a station from whatever line it is on. */
  contextMenu(event) {
    const world = this.renderer.toWorld(event.clientX, event.clientY);
    const game = this.game;
    const station = this.hitStation(world.x, world.y);
    const line = station ? game.lineOf(station.id) : null;
    if (line) {
      game.detachStation(line, station.id);
      this.hooks.onChange?.();
      return;
    }
    this.cancel();
  }

  pointerMove(event) {
    const world = this.renderer.toWorld(event.clientX, event.clientY);
    this.pointer = world;
    if (this.press && Math.hypot(world.x - this.press.x, world.y - this.press.y) > this.screenPixels(6)) {
      this.moved = true;
    }
    const game = this.game;
    if (game.drag) {
      const snap = this.hitStation(world.x, world.y, 10);
      if (snap) game.dragOverStation(snap);
    }
    this.updateHover(world.x, world.y);
  }

  pointerUp(event) {
    const world = event ? this.renderer.toWorld(event.clientX, event.clientY) : this.pointer;
    if (world) this.pointer = world;
    const game = this.game;
    const wasEmpty = this.pressEmpty;
    this.press = null;
    this.pressEmpty = false;
    this.poolDrag = false;

    if (game.vehicleDrag) {
      const target = world ? this.hitVehicleTarget(world.x, world.y) : null;
      game.dropVehicle(target);
    } else if (game.drag) {
      const snap = world ? this.hitStation(world.x, world.y, DROP_PAD) : null;
      game.endLineDrag(snap);
    } else if (game.segmentDrag) {
      const snap = world ? this.hitStation(world.x, world.y, DROP_PAD) : null;
      if (!game.endSegmentDrag(snap) && snap) game.cancelSegmentDrag();
    } else if (wasEmpty) {
      game.cancelLineDrag();
      game.cancelSegmentDrag();
    }

    this.updateHover(world?.x ?? 0, world?.y ?? 0);
    this.hooks.onChange?.();
  }

  updateHover(x, y) {
    const terminus = this.hitTerminus(x, y);
    if (terminus) {
      this.hover = { station: terminus.station, lineId: terminus.lineId, segment: null, terminus };
      return;
    }
    const station = this.hitStation(x, y);
    let lineId = null;
    let segment = null;
    if (station) {
      const line = this.game.lineOf(station.id);
      if (line) lineId = line.id;
    } else {
      const hit = this.hitSegment(x, y);
      if (hit) {
        lineId = hit.line.id;
        segment = { lineId: hit.line.id, index: hit.index };
      }
    }
    this.hover = { station, lineId, segment, terminus: null };
  }

  keyDown(event) {
    if (event.key === 'Escape') {
      this.cancel();
      this.hooks.onCancel?.();
    }
  }
}
