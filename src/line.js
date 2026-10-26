import { CONFIG, LINE_COLORS } from './config.js';
import { buildLinePath } from './track.js';

/**
 * A metro line: an ordered list of stations, optionally closed into a loop.
 * The path is rebuilt whenever the station list changes; trains hold an arc
 * distance `s` into that path.
 */
export class Line {
  constructor(index) {
    this.id = `L${index + 1}`;
    this.index = index;
    this.color = LINE_COLORS[index % LINE_COLORS.length];
    /** @type {import('./station.js').Station[]} */
    this.stations = [];
    this.isLoop = false;
    /** True while the player is spending one of their line slots on it. */
    this.claimed = false;
    /** True while the line is being taken out of service. */
    this.retiring = false;
    /**
     * Every locomotive deployed on this line brings its own train, and a line
     * can run several of them at once - in either direction, passing straight
     * through each other.
     * @type {import('./train.js').Train[]}
     */
    this.trains = [];
    /** @type {Set<number>} hills this line tunnels through */
    this.tunnelledHills = new Set();
    /** A locomotive is on its way here: draw a faded placeholder train. */
    this.pendingLoco = false;
    this.pendingFromLineId = null;
    this.path = { points: [], cum: [], total: 0 };
    this.stationS = [];
    this.generation = 0;
  }

  get colorHex() {
    return this.color.stroke;
  }

  get isActive() {
    return this.stations.length >= 2;
  }

  /** A line runs as soon as at least one locomotive is deployed on it. */
  get hasLocomotive() {
    return this.trains.length > 0;
  }

  /** Active *and* staffed with a locomotive: only then does it carry anyone. */
  get isRunning() {
    return this.isActive && this.hasLocomotive;
  }

  /** Total carriages across every train on the line (for the HUD). */
  get carriages() {
    return this.trains.reduce((n, t) => n + t.carriages, 0);
  }

  /** Hills this line has been given a tunnel through. */
  isTunnelled(hillIndex) {
    return !!this.tunnelledHills && this.tunnelledHills.has(hillIndex);
  }

  get maxCarriages() {
    return CONFIG.vehicles.maxCarriages;
  }

  /** The train whose body is nearest to a point, for drops and hit tests. */
  nearestTrain(x, y) {
    let best = null;
    let bestD = Infinity;
    for (const train of this.trains) {
      const pos = train.position;
      const d = Math.hypot(pos.x - x, pos.y - y);
      if (d < bestD) {
        bestD = d;
        best = train;
      }
    }
    return best;
  }

  indexOfStation(stationId) {
    return this.stations.findIndex((s) => s.id === stationId);
  }

  hasStation(stationId) {
    return this.indexOfStation(stationId) >= 0;
  }

  rebuild() {
    // Track is routed octilinearly (0 / 45 / 90 degrees) with rounded corners,
    // so the path is no longer just the station positions.
    const prevIds = this._builtIds;
    const prevStationS = this._builtStationS;
    const path = buildLinePath(this.stations, this.isLoop);
    this.path = path;
    this.stationS = path.stationS;
    const ids = this.stations.map((s) => s.id);

    // Trains are re-anchored by Game.tryLineEdit (which knows which leg each
    // one was on); rebuilding the path alone must not move them.
    void prevIds;
    void prevStationS;
    void ids;

    this._builtIds = ids;
    this._builtStationS = this.stationS.slice();
    this.generation++;
  }

  /**
   * Nearest point on the routed track to a world position.
   * @returns {{s: number, x: number, y: number, distance: number}}
   */
  projectPoint(x, y) {
    const pts = this.path.points;
    const cum = this.path.cum;
    let best = { s: 0, x, y, distance: Infinity };
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2)) : 0;
      const px = a.x + dx * t;
      const py = a.y + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best.distance) {
        best = { s: (cum[i] ?? 0) + (cum[i + 1] - cum[i]) * t, x: px, y: py, distance: d };
      }
    }
    return best;
  }

  /** Keys identifying every leg (pair of consecutive stations) on this line. */
  legKeys() {
    const keys = new Set();
    const n = this.stations.length;
    for (let i = 0; i + 1 < n; i++) keys.add(`${this.stations[i].id}|${this.stations[i + 1].id}`);
    if (this.isLoop && n >= 3) keys.add(`${this.stations[n - 1].id}|${this.stations[0].id}`);
    return keys;
  }

  /**
   * Map an arc distance taken from `snapshot` onto this line, or null when the
   * leg of track that distance sat on no longer exists.
   *
   * This is what keeps a re-route local: a train sitting on a piece of track
   * the edit did not touch simply keeps going, and only trains that were on
   * the changed track (or on the closing leg of a loop) need to be frozen.
   */
  remapArcFrom(snapshot, s) {
    if (!snapshot || !this.stations.length) return null;
    const S = snapshot.stationS;
    const old = snapshot.stations;
    const n = old.length;
    if (n < 2) return null;
    let i = -1;
    for (let k = 0; k + 1 < n; k++) {
      if (s >= S[k] - 1e-6 && s <= S[k + 1] + 1e-6) {
        i = k;
        break;
      }
    }
    if (i < 0 && snapshot.isLoop) i = n - 1;
    if (i < 0) i = n - 2;
    const a = old[i];
    const b = snapshot.isLoop && i === n - 1 ? old[0] : old[i + 1];
    if (!a || !b) return null;
    for (let k = 0; k + 1 < this.stations.length; k++) {
      if (this.stations[k].id === a.id && this.stations[k + 1].id === b.id) {
        return this.stationS[k] + (s - S[i]);
      }
    }
    if (this.isLoop) {
      const last = this.stations.length - 1;
      if (this.stations[last].id === a.id && this.stations[0].id === b.id) {
        return this.stationS[last] + (s - S[i]);
      }
    }
    return null;
  }

  /**
   * How a train's position maps onto a rebuilt path.
   *
   * When the old station list is a contiguous slice of the new one (an end
   * station was appended or prepended) the train's arc distance just moves by
   * the start of that slice - it is *not* snapped back to a station.
   */
  static shiftFor(prevIds, prevS, ids, stationS) {
    if (prevIds.length === ids.length && prevIds.every((id, i) => id === ids[i])) {
      return { delta: 0, indexDelta: 0 };
    }
    // Appended / prepended: the old list still appears in order.
    for (let k = 0; k + prevIds.length <= ids.length; k++) {
      let ok = true;
      for (let i = 0; i < prevIds.length; i++) {
        if (ids[k + i] !== prevIds[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { delta: k > 0 ? stationS[k] || 0 : 0, indexDelta: k };
    }
    // Truncated: the new list still appears in order inside the old one.
    for (let j = 0; j + ids.length <= prevIds.length; j++) {
      let ok = true;
      for (let i = 0; i < ids.length; i++) {
        if (prevIds[j + i] !== ids[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { delta: -(prevS[j] || 0), indexDelta: -j };
    }
    // The route really changed shape: leave it to the hand-over logic.
    return { delta: 0, indexDelta: 0 };
  }

  setStations(stations, isLoop = this.isLoop) {
    this.stations = stations.slice();
    this.isLoop = isLoop && this.stations.length >= 3;
    this.rebuild();
  }

  pushStation(station) {
    if (this.hasStation(station.id)) return false;
    this.stations.push(station);
    this.rebuild();
    return true;
  }

  unshiftStation(station) {
    if (this.hasStation(station.id)) return false;
    this.stations.unshift(station);
    this.rebuild();
    return true;
  }

  insertStationAt(station, index) {
    if (this.hasStation(station.id)) return false;
    const at = Math.max(0, Math.min(this.stations.length, index));
    this.stations.splice(at, 0, station);
    this.rebuild();
    return true;
  }

  removeStationAt(index) {
    if (index < 0 || index >= this.stations.length) return null;
    const [gone] = this.stations.splice(index, 1);
    if (this.stations.length < 3) this.isLoop = false;
    this.rebuild();
    return gone;
  }

  /** Which end of this line `stationId` sits on: 0 head, 1 tail, -1 not an end. */
  endOfStation(stationId) {
    if (this.isLoop || this.stations.length < 2) return -1;
    if (this.stations[0].id === stationId) return 0;
    if (this.stations[this.stations.length - 1].id === stationId) return 1;
    return -1;
  }

  clear() {
    this.stations = [];
    this.isLoop = false;
    this.rebuild();
  }

  crossingsWith(river) {
    if (!this.isActive) return 0;
    return river.crossings(this.path.points);
  }

  /** Shortest number of hops between two stations along this line. */
  hopsBetween(i, j) {
    const n = this.stations.length;
    if (i < 0 || j < 0) return Infinity;
    const d = Math.abs(i - j);
    return this.isLoop ? Math.min(d, n - d) : d;
  }
}

/** Walk outward from `fromIdx` in `dir` and return the first matching index. */
export function scanAhead(line, fromIdx, dir, predicate) {
  const n = line.stations.length;
  if (n < 2) return -1;
  if (line.isLoop) {
    for (let k = 1; k < n; k++) {
      const i = (((fromIdx + dir * k) % n) + n) % n;
      if (predicate(line.stations[i], i)) return i;
    }
    return -1;
  }
  for (let i = fromIdx + dir; i >= 0 && i < n; i += dir) {
    if (predicate(line.stations[i], i)) return i;
  }
  return -1;
}

/**
 * A frozen copy of a line's route.
 *
 * When a line is edited (or removed) while its train is still carrying people,
 * the train keeps running the old geometry so nobody is teleported or lost;
 * the old track is drawn faded underneath the new one until the train has
 * finished. This snapshot exposes just enough of the Line API for the train.
 */
export class RouteSnapshot {
  constructor(line) {
    this.id = line.id;
    this.color = line.color;
    this.stations = line.stations.slice();
    this.isLoop = line.isLoop;
    this.stationS = line.stationS.slice();
    this.path = { points: line.path.points, cum: line.path.cum, total: line.path.total };
    this.frozen = true;
  }

  get isActive() {
    return this.stations.length >= 2;
  }

  get capacity() {
    return 0;
  }

  get retiring() {
    return true;
  }

  /**
   * Is one station list a contiguous slice of the other (same order)?
   *
   * If so, the edit only appended or retracted an end station: the old route
   * is still part of the new one and the train can just keep going.
   */
  static covers(a, b, aIsLoop = false, bIsLoop = false) {
    if (aIsLoop !== bIsLoop) return false;
    if (a.length > b.length) return RouteSnapshot.covers(b, a, bIsLoop, aIsLoop);
    for (let start = 0; start + a.length <= b.length; start++) {
      let ok = true;
      for (let i = 0; i < a.length; i++) {
        if (b[start + i].id !== a[i].id) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  hasStation(stationId) {
    return this.stations.some((s) => s.id === stationId);
  }

  indexOfStation(stationId) {
    return this.stations.findIndex((s) => s.id === stationId);
  }

  endOfStation(stationId) {
    if (this.isLoop || this.stations.length < 2) return -1;
    if (this.stations[0].id === stationId) return 0;
    if (this.stations[this.stations.length - 1].id === stationId) return 1;
    return -1;
  }
}
