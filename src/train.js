import { CONFIG } from './config.js';
import { scanAhead } from './line.js';
import { samplePolyline, clamp } from './geometry.js';

const EPS = 1e-7;

/**
 * A single train per line. It shuttles back and forth (or loops forever),
 * exchanges passengers at every stop and reverses at the terminals.
 *
 * `s` is a signed arc distance along the line path; it is always snapped to a
 * station's own arc position when the train stops there, which keeps the
 * "have I reached the terminal?" test exact.
 */
export class Train {
  /** Fallback id sequence, used when a Game does not supply one. */
  static seq = 0;

  constructor(line, id = null) {
    this.line = line;
    this.id = id ?? `${line.id}T${++Train.seq}`;
    /** Carriages hanging off this locomotive (each adds capacity). */
    this.carriages = 0;
    this.s = 0;
    this.dir = 1;
    this.dwell = 0;
    /** @type {import('./passenger.js').Passenger[]} */
    this.passengers = [];
    this.v = 0;
    this.stopIndex = 0;
    this.arrivedThisFrame = false;
    this.travelled = 0;
    /** Set right after a reset: the station the train is parked on. */
    this.pendingArrival = null;
    /**
     * A frozen copy of the route this train is still finishing after its line
     * was edited or removed. While it is set the train runs the old geometry
     * and is drawn faded; a line that is simply being edited keeps serving
     * passengers on the old route until the trip is done.
     */
    this.frozen = null;
    this.freezeTimer = 0;
    /** Distance covered since the route was frozen. */
    this.freezeTravelled = 0;
  }

  /** The geometry the train is actually running on right now. */
  get route() {
    return this.frozen || this.line;
  }

  get capacity() {
    return CONFIG.train.baseCapacity + this.carriages * CONFIG.train.carriageCapacity;
  }

  get isFull() {
    return this.passengers.length >= this.capacity;
  }

  get position() {
    const path = this.route.path;
    return samplePolyline(path.points, path, this.s);
  }

  reset() {
    this.s = 0;
    this.dir = 1;
    this.v = 0;
    this.dwell = 0;
    this.stopIndex = 0;
    this.passengers = [];
    // A reset means "start over on the current line", so any ghost route it
    // was still finishing is dropped as well.
    this.frozen = null;
    this.freezeTimer = 0;
    this.freezeTravelled = 0;
    this.awaitStation = false;
    /** The train starts *at* a station, so that station is served first. */
    this.pendingArrival = 0;
  }

  /**
   * Keep the train where it is when the line's stations were merely extended
   * or shortened at an end. `delta` is how far its arc position moved, and
   * `indexDelta` how its station index shifted.
   */
  shiftS(delta = 0, indexDelta = 0) {
    const total = this.line.path.total;
    if (total <= 0) {
      this.s = 0;
      return;
    }
    this.s = Math.max(0, Math.min(total, this.s + delta));
    const n = Math.max(1, this.line.stations.length);
    this.stopIndex = Math.max(0, Math.min(n - 1, this.stopIndex + indexDelta));
    this.v = 0;
  }

  /** Finish the current run on `snapshot`, then rejoin the real line. */
  freeze(snapshot, seconds) {
    this.frozen = snapshot;
    this.freezeTimer = seconds;
    this.freezeTravelled = 0;
  }

  /**
   * Park the train at one of its stations. Used when a locomotive is dropped
   * onto a line: it settles at the station nearest where it was released.
   */
  placeAt(index, stationS, stationCount) {
    const i = Math.max(0, Math.min(stationCount - 1, index ?? 0));
    this.frozen = null;
    this.freezeTimer = 0;
    this.freezeTravelled = 0;
    this.stopIndex = i;
    this.s = stationS[i] ?? 0;
    this.dir = i >= stationCount - 1 ? -1 : 1;
    this.v = 0;
    this.dwell = 0;
    // The train appears *at* a platform, so that platform is served first.
    this.pendingArrival = i;
  }

  /**
   * Park the train at an arbitrary arc distance - where the player let go of
   * it - instead of on a platform, and point it at whichever neighbouring
   * station is closer.
   */
  placeAtArc(s, total) {
    this.frozen = null;
    this.freezeTimer = 0;
    this.freezeTravelled = 0;
    this.v = 0;
    this.dwell = 0;
    this.pendingArrival = null;
    const line = this.route;
    const n = line.stations.length;
    if (!n || total <= 0) {
      this.s = 0;
      this.stopIndex = 0;
      this.dir = 1;
      return;
    }
    this.s = Math.max(0, Math.min(total, s));

    // Which leg are we standing on?
    const S = line.stationS;
    let leg = 0;
    for (let i = 0; i + 1 < n; i++) if (this.s >= S[i] - 1e-6) leg = i;
    if (this.s > S[n - 1] && !line.isLoop) leg = Math.max(0, n - 2);
    const behind = this.s - S[leg];
    const ahead = (S[leg + 1] ?? total) - this.s;

    if (line.isLoop) {
      // A loop always runs forward, so just aim at the next station along.
      this.dir = 1;
      this.stopIndex = (leg + 1) % n;
      return;
    }
    // Facing the nearer platform means driving the shorter way.
    if (behind <= ahead) {
      this.dir = -1;
      this.stopIndex = leg;
    } else {
      this.dir = 1;
      this.stopIndex = Math.min(n - 1, leg + 1);
    }
  }

  /**
   * The line geometry just changed, so the old arc distance means nothing any
   * more. Park the train back on the last station it served rather than
   * leaving it stranded in the middle of a rebuilt path.
   */
  onLineChanged() {
    const line = this.route;
    const total = line.path.total;
    if (total <= 0 || !line.stations.length) {
      this.s = 0;
      return;
    }
    if (this.stopIndex >= line.stations.length) this.stopIndex = 0;
    const anchor = line.stationS[this.stopIndex];
    this.s = Number.isFinite(anchor) ? anchor : Math.max(0, Math.min(total, this.s));
    this.v = 0;
  }

  /** Distance from the train to the next platform in its direction of travel. */
  nextStopDistance() {
    const line = this.route;
    const S = line.stationS;
    const total = line.path.total;
    if (!S.length || total <= 0) return 0;
    const eps = 1e-6;
    let best = Infinity;
    if (line.isLoop) {
      for (let i = 0; i < S.length; i++) {
        let d = S[i] - this.s;
        if (d <= eps) d += total;
        if (d < best) best = d;
      }
    } else if (this.dir > 0) {
      for (let i = 0; i < S.length; i++) {
        const d = S[i] - this.s;
        if (d > eps && d < best) best = d;
      }
      if (best === Infinity) best = total - this.s;
    } else {
      for (let i = 0; i < S.length; i++) {
        const d = this.s - S[i];
        if (d > eps && d < best) best = d;
      }
      if (best === Infinity) best = this.s;
    }
    return Number.isFinite(best) ? Math.max(0, best) : 0;
  }

  /**
   * Speed for this instant: cruise in the middle of a run, easing down to a
   * walking pace over the last `brakeDistance` before the platform.
   */
  approachSpeed(game = null) {
    const { cruiseSpeed, minSpeed, brakeDistance } = CONFIG.train;
    const t = clamp(this.nextStopDistance() / brakeDistance, 0, 1);
    let speed = minSpeed + (cruiseSpeed - minSpeed) * Math.sqrt(t);
    // Track laid straight over a hill is a surface line and runs slowly. A
    // tunnel through that hill (bought for the line) removes the penalty.
    if (game && game.terrain && !this.frozen) {
      const pos = this.position;
      const hill = game.terrain.mountainAt(pos.x, pos.y);
      if (hill >= 0 && !this.line.isTunnelled(hill)) {
        speed *= CONFIG.terrain.surfaceSpeed;
      }
    }
    return speed;
  }

  update(dt, game) {
    this.arrivedThisFrame = false;
    const line = this.route;
    const total = line.path.total;
    if (!line.isActive || total <= 0) return;

    // Serve the station the train is standing on before its first departure.
    if (this.pendingArrival !== null && this.pendingArrival !== undefined) {
      const index = Math.min(this.pendingArrival, line.stations.length - 1);
      this.pendingArrival = null;
      if (index >= 0 && line.stations[index]) {
        this.s = line.stationS[index] || 0;
        this.arrive(index, game);
        return;
      }
    }

    if (this.dwell > 0) {
      this.dwell -= dt;
      if (this.dwell <= 0) this.dwell = 0;
      this.v = 0;
      return;
    }

    // Accelerate / brake smoothly towards the profile speed.
    const target = this.approachSpeed(game);
    const maxDelta = CONFIG.train.acceleration * dt;
    this.v += clamp(target - this.v, -maxDelta, maxDelta);

    const advance = this.v * dt;
    const prev = this.s;
    let hit = -1;

    if (line.isLoop) {
      this.s = (prev + advance) % total;
      this.travelled += advance;
      if (this.frozen) this.freezeTravelled += advance;
      hit = this.firstCrossedLoop(prev, this.s);
    } else {
      const movingDir = this.dir;
      let next = prev + movingDir * advance;
      if (next >= total) {
        next = total;
        hit = line.stations.length - 1;
      } else if (next <= 0) {
        next = 0;
        hit = 0;
      } else {
        hit = this.firstCrossedOpen(prev, next, movingDir);
      }
      this.travelled += Math.abs(next - prev);
      if (this.frozen) this.freezeTravelled += Math.abs(next - prev);
      this.s = next;
      if (hit >= 0 && movingDir > 0 && hit === line.stations.length - 1) this.dir = -1;
      else if (hit >= 0 && movingDir < 0 && hit === 0) this.dir = 1;
    }

    if (hit >= 0) {
      // Snap exactly onto the station: relying on the floating point value of
      // `s` lets the same terminal be "reached" twice in a row.
      this.s = line.stationS[hit] ?? this.s;
      this.arrive(hit, game);
    }
  }

  firstCrossedOpen(prev, now, dir) {
    const S = this.route.stationS;
    let bestIdx = -1;
    let bestVal = dir > 0 ? Infinity : -Infinity;
    for (let i = 0; i < S.length; i++) {
      if (dir > 0) {
        if (S[i] > prev + EPS && S[i] <= now + EPS && S[i] < bestVal) {
          bestVal = S[i];
          bestIdx = i;
        }
      } else if (S[i] < prev - EPS && S[i] >= now - EPS && S[i] > bestVal) {
        bestVal = S[i];
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  firstCrossedLoop(prev, now) {
    const S = this.route.stationS;
    const total = this.route.path.total;
    if (total <= 0) return -1;
    const limit = now >= prev ? now : now + total;
    let bestIdx = -1;
    let bestVal = Infinity;
    for (let i = 0; i < S.length; i++) {
      let v = S[i];
      if (v <= prev + EPS) v += total;
      if (v > prev + EPS && v <= limit + EPS && v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    return bestIdx;
  }

  arrive(index, game) {
    const line = this.route;
    const station = line.stations[index];
    if (!station) return;
    const unloaded = this.unload(station, game);
    const boarded = this.load(station, index, game);
    this.stopIndex = index;
    this.dwell = CONFIG.train.dwell + (unloaded + boarded) * CONFIG.train.boardTime;
    this.v = 0;
    this.arrivedThisFrame = true;
    game.onTrainStop(this, station, unloaded, boarded);
  }

  /** Drop off everyone whose journey ends - or continues - here. */
  unload(station, game) {
    const line = this.route;
    const keep = [];
    let events = 0;
    for (const p of this.passengers) {
      if (p.destShape === station.shape) {
        events++;
        game.recordDelivery(p, station);
      } else if (p.targetStationId === station.id || !p.targetStationId || !line.hasStation(p.targetStationId)) {
        p.lastLineId = line.id;
        p.targetStationId = null;
        station.passengers.push(p);
        events++;
      } else {
        keep.push(p);
      }
    }
    this.passengers = keep;
    if (events) station.flash = 0.45;
    return events;
  }

  /** Take on everyone this train can actually help right now. */
  load(station, stationIndex, game) {
    // A line that is being taken out of service only finishes its riders.
    if (this.frozen && this.line.retiring) return 0;
    let boarded = 0;
    const keep = [];
    const queue = station.passengers;
    for (const p of queue) {
      if (this.passengers.length >= this.capacity) {
        keep.push(p);
        continue;
      }
      const target = this.pickTarget(game, p, stationIndex);
      if (target >= 0) {
        p.targetStationId = this.route.stations[target].id;
        p.lastLineId = null;
        this.passengers.push(p);
        boarded++;
      } else {
        keep.push(p);
      }
    }
    station.passengers = keep;
    return boarded;
  }

  /**
   * Which stop ahead (in the current direction) serves this passenger?
   * -1 means "not this train, not this direction".
   */
  pickTarget(game, passenger, stationIndex) {
    const line = this.route;
    if (!line.isActive) return -1;
    const station = line.stations[stationIndex];
    if (!station || station.shape === passenger.destShape) return -1;

    const direct = scanAhead(line, stationIndex, this.dir, (s) => s.shape === passenger.destShape);
    if (direct >= 0) return direct;
    // While finishing an old route the train only takes people it can carry
    // straight there; transfers are planned against the live network.
    if (this.frozen) return -1;

    const plan = game.planRoute(station, passenger.destShape, passenger.lastLineId);
    if (!plan || plan.lineId !== line.id) return -1;
    const targetIndex = line.indexOfStation(plan.targetStationId);
    if (targetIndex < 0) return -1;
    return scanAhead(line, stationIndex, this.dir, (_s, i) => i === targetIndex);
  }
}
