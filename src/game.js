import { CONFIG } from './config.js';
import { Rng } from './rng.js';
import { Station } from './station.js';
import { makePassenger } from './passenger.js';
import { Line, RouteSnapshot } from './line.js';
import { Train } from './train.js';
import { River } from './river.js';
import { Terrain } from './terrain.js';
import { Network } from './network.js';
import { NORMAL_SHAPES, SPECIAL_SHAPES, SHAPES, isSpecialShape } from './shapes.js';
import { clamp, dist, lerp, normLegKey } from './geometry.js';

export const GameState = Object.freeze({
  PLAYING: 'playing',
  UPGRADE: 'upgrade',
  GAMEOVER: 'gameover',
});

const MAX_STATIONS = 34;

/**
 * The whole simulation. Deliberately DOM-free: the renderer, the HUD and the
 * headless tests all drive this same object.
 */
export class Game {
  /** Number of Game instances created, used as a cache-key namespace. */
  static runs = 0;

  constructor(options = {}) {
    this.mode = CONFIG.modes[options.mode] || CONFIG.modes.normal;
    this.seed = options.seed ?? Math.floor(Math.random() * 1e9);
    this.rng = new Rng(this.seed);
    /** Station ids are owned by the game so two live games never collide. */
    this._stationSeq = 0;

    this.time = 0;
    /** @type {Station[]} */
    this.stations = [];
    /** TEMPORARY SCAFFOLDING (tools/RIVER-LAB.md): river parameter overrides. */
    this.riverParams = options.riverParams || null;
    this.terrainParams = options.terrainParams || null;
    this.river = new River(this.rng, CONFIG.world, this.riverParams);
    this.terrain = new Terrain(this.rng, CONFIG.world, this.river, this.terrainParams);
    this.network = new Network();

    /** @type {Line[]} */
    /**
     * How much of the map is revealed, as a linear fraction. Starts small and
     * opens out over one week; new stations only appear inside it.
     */
    this.viewFraction = CONFIG.view.startFraction;
    /** Point the reveal is centred on: a bend of the main river. */
    this.viewAnchor = null;
    /** Station radius multiplier for the current reveal step. */
    this.currentRadiusScale = CONFIG.view.stationScaleAtStart;
    /** Extra score cost for a site across the water; fades out over weeks. */
    this.acrossRiverPenalty = CONFIG.grid.acrossRiverPenalty;
    /** Train id sequence, so drags can name a specific train. */
    this._trainSeq = 0;
    this.lines = [];
    for (let i = 0; i < CONFIG.lines.maxSlots; i++) this.lines.push(new Line(i));

    this.unlockedLines = CONFIG.lines.startSlots;
    this.tunnelsOwned = CONFIG.tunnels.start;
    this.inventory = { interchanges: 0 };
    /** Vehicle pools: the bottom tray shows available/total for each. */
    this.locomotives = {
      available: CONFIG.vehicles.startLocomotives,
      total: CONFIG.vehicles.startLocomotives,
    };
    this.carriages = { available: CONFIG.vehicles.startCarriages, total: CONFIG.vehicles.startCarriages };
    /** A vehicle being dragged from the tray or off a line. */
    this.vehicleDrag = null;
    this.placement = null;
    /** Line-drag session: { lineId, end, anchorId, route, isNew } or null. */
    this.drag = null;
    /** Segment re-route session: { lineId, index } or null. */
    this.segmentDrag = null;

    this.score = 0;
    this.delivered = 0;
    this.overcrowdIncidents = 0;
    this.stats = { stops: 0, boardings: 0, deliveries: 0 };

    this.state = GameState.PLAYING;
    this.day = 1;
    this.week = 1;
    this.dayClock = 0;
    this.stationTimer = 0;
    this.specialBag = this.rng.shuffle(SPECIAL_SHAPES.slice());
    this.rewardOptions = [];
    this.rewardWeek = 0;
    this.toasts = [];
    this.gameOverStation = null;
    /** Identifies this run, so renderer caches can never leak between games. */
    this.runId = ++Game.runs;
    /** Bumped whenever a station's size or shape changes. */
    this.stationVersion = 0;
    /** Bumped whenever line geometry changes; invalidates the tunnel cache. */
    this.geometryGen = 0;
    this._tunnelCacheGen = -1;
    this._tunnelCache = 0;
    this.scorePulse = 0;

    this.init();
  }

  // ---------------------------------------------------------------- set-up

  /** Create (but do not place) a station with the next id in this game's run. */
  createStation(x, y, shape) {
    return new Station(x, y, shape, `S${++this._stationSeq}`);
  }

  /** Create a station and put it on the map. Handy for tests and scripted play. */
  addStation(x, y, shape) {
    const station = this.createStation(x, y, shape);
    this.stations.push(station);
    this.stationVersion++;
    this.network.rebuild(this);
    return station;
  }

  init() {
    // Anchor the reveal on the main river, halfway along it: the opening view
    // should already show a stretch of water.
    const main = this.river.segments.find((s2) => s2.kind === 'river') || this.river.segments[0];
    if (main && main.points.length) {
      this.viewAnchor = { ...main.points[Math.floor(main.points.length / 2)] };
    }
    const first = this.findSpot() || { x: CONFIG.world.w * 0.35, y: CONFIG.world.h * 0.6 };
    this.stations.push(this.createStation(first.x, first.y, 'circle'));
    // Keep the opening three on the same side of the water, so the very first
    // line never needs a tunnel.
    for (const shape of ['triangle', 'square']) {
      const spot = this.findSpot({ anchor: first }) || this.findSpot() || first;
      this.stations.push(this.createStation(spot.x, spot.y, shape));
    }
    this.network.rebuild(this);
    this.stationTimer = this.nextStationDelay();
    this.eventTimer = this.rng.range(CONFIG.passenger.eventInterval[0], CONFIG.passenger.eventInterval[1]);
    for (const st of this.stations) {
      st.spawnTimer = this.passengerIntervalFor(st) * this.rng.range(0.5, 1.1);
    }
  }

  /**
   * Pick a spot for a new station: on the grid, clear of the river, far enough
   * from every existing station and reasonably close to the network.
   */
  findSpot(options = {}) {
    const { world, grid } = CONFIG;
    const m = world.margin;
    const anchor = options.anchor ?? null;
    const peripheral = !!options.peripheral;
    const shapeHint = options.shapeHint ?? null;
    // Specials belong out towards the edges, away from the middle of the map.
    const centre = { x: world.w / 2, y: world.h / 2 };
    const maxReach = Math.hypot(centre.x, centre.y);
    let minGap = options.minGap ?? grid.minStationGap;
    // Search inside what the player can see, not the whole world: as the view
    // opens out, stations start appearing further and further afield.
    const v = this.viewRect();
    const vx = v.w * CONFIG.view.margin;
    const vy = v.h * CONFIG.view.margin;
    const inner = { x: v.x + vx, y: v.y + vy, w: Math.max(grid.size, v.w - vx * 2), h: Math.max(grid.size, v.h - vy * 2) };
    const cols = Math.max(1, Math.floor(inner.w / grid.size));
    const rows = Math.max(1, Math.floor(inner.h / grid.size));
    const target = (grid.preferredMinDist + grid.preferredMaxDist) / 2;

    for (let attempt = 0; attempt < 2; attempt++) {
      let best = null;
      let bestScore = -Infinity;
      for (let i = 0; i < grid.placementTries; i++) {
        // Stratify by grid cell for good spacing, but jitter inside the cell so
        // the map never looks like a lattice.
        const jitter = grid.jitter;
        const x =
          inner.x +
          (Math.floor(this.rng.next() * cols) + 0.5 + this.rng.range(-jitter, jitter)) * grid.size;
        const y =
          inner.y +
          (Math.floor(this.rng.next() * rows) + 0.5 + this.rng.range(-jitter, jitter)) * grid.size;
        if (!this.inView(x, y)) continue;
        // Keep clear of the bank, not of the centreline: rivers vary in width.
        if (
          this.river.distanceTo(x, y) <
          CONFIG.river.stationClearance + this.river.halfWidthAt(x, y)
        ) {
          continue;
        }
        if (anchor && this.river.separated(anchor, { x, y })) continue;
        // Hills stay empty for the first fortnight: early hillside housing
        // made the opening far too punishing.
        if (this.terrain) {
          const d = this.terrain.distanceTo(x, y);
          const margin = this.hillClearance();
          // A station may not straddle a hill's edge: wholly on it or wholly
          // off it, nothing in between.
          if (Math.abs(d) < margin) continue;
          const hill = this.terrain.mountainAt(x, y);
          if (hill >= 0) {
            if (this.time / CONFIG.clock.daySeconds < CONFIG.terrain.hillFromDay) continue;
            // And a hill only holds so many stations before it is full.
            if (this.stationsOnHill(hill) >= CONFIG.terrain.maxStationsPerHill) continue;
          }
        }

        let nearest = Infinity;
        let tooClose = false;
        for (const s of this.stations) {
          const d = dist(x, y, s.x, s.y);
          if (d < minGap) {
            tooClose = true;
            break;
          }
          if (d < nearest) nearest = d;
        }
        if (tooClose) continue;
        if (!this.stations.length) return { x, y };

        let score = -Math.abs(nearest - target);

        // ...and keep the network on one bank while the map is young.
        if (this.acrossRiverPenalty > 0 && this.stations.length) {
          if (this.river.separated(this.stations[0], { x, y })) {
            score -= this.acrossRiverPenalty;
          }
        }
        if (nearest < grid.preferredMinDist) score -= 220;
        if (nearest > grid.preferredMaxDist) score -= (nearest - grid.preferredMaxDist) * 0.6;

        // Push the candidate off the line through any two existing stations:
        // three stations in a neat row is the most predictable layout there is.
        let collinear = 0;
        for (let i = 0; i < this.stations.length; i++) {
          for (let j = i + 1; j < this.stations.length; j++) {
            const s1 = this.stations[i];
            const s2 = this.stations[j];
            const vx = s2.x - s1.x;
            const vy = s2.y - s1.y;
            const len = Math.hypot(vx, vy);
            if (len < 1) continue;
            const t = ((x - s1.x) * vx + (y - s1.y) * vy) / (len * len);
            if (t < -0.3 || t > 1.3) continue;
            const d = Math.abs((x - s1.x) * vy - (y - s1.y) * vx) / len;
            if (d < grid.collinearWindow) {
              collinear = Math.max(collinear, 1 - d / grid.collinearWindow);
            }
          }
        }
        score -= collinear * grid.collinearPenalty;

        // Still a mild pull towards sharing a row or column, but far weaker
        // than the penalty above, so lines stay drawable without the map
        // turning into a grid.
        let align = 0;
        for (const s of this.stations) {
          const dy = Math.abs(y - s.y);
          const dx = Math.abs(x - s.x);
          if (dy < grid.alignmentWindow && dx >= minGap) {
            align = Math.max(align, 1 - dy / grid.alignmentWindow);
          }
          if (dx < grid.alignmentWindow && dy >= minGap) {
            align = Math.max(align, 1 - dx / grid.alignmentWindow);
          }
        }
        score += align * grid.alignmentBias;

        if (peripheral) {
          const reach = Math.hypot(x - centre.x, y - centre.y) / maxReach;
          score += reach * CONFIG.station.specialPeripheralBias;
          // ...and never right on top of another district of the same kind.
          for (const s of this.stations) {
            if (s.shape === shapeHint && dist(x, y, s.x, s.y) < minGap * 1.6) score -= 400;
          }
        }
        score += this.rng.next() * 60;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
      if (best) return best;
      minGap *= 0.78;
    }
    return null;
  }

  // -------------------------------------------------------------- spawning

  nextStationDelay() {
    const t = clamp(this.time / CONFIG.station.spawnIntervalRamp, 0, 1);
    return lerp(CONFIG.station.spawnIntervalStart, CONFIG.station.spawnIntervalEnd, t) * this.rng.range(0.85, 1.2);
  }

  passengerInterval() {
    const t = clamp(this.time / CONFIG.passenger.intervalRamp, 0, 1);
    const [a0, a1] = CONFIG.passenger.intervalStart;
    const [b0, b1] = CONFIG.passenger.intervalEnd;
    return this.rng.range(lerp(a0, b0, t), lerp(a1, b1, t));
  }

  shapeCounts() {
    const counts = Object.create(null);
    for (const s of this.stations) counts[s.shape] = (counts[s.shape] || 0) + 1;
    return counts;
  }

  /**
   * How many stations may exist right now. The opening week only gets a few
   * beyond the three it starts with, so the map does not fill up before the
   * player has had a chance to build anything.
   */
  stationCap() {
    const days = this.time / Math.max(1, CONFIG.clock.daySeconds);
    if (days < CONFIG.station.firstWeekDays) {
      return CONFIG.station.initialCount + CONFIG.station.firstWeekExtra;
    }
    return MAX_STATIONS;
  }

  /**
   * Normal districts by rarity: housing (circles) most common, then commerce,
   * then the transport hubs, which are the rarest of the three.
   */
  pickNormalShape() {
    const counts = this.shapeCounts();
    const entries = NORMAL_SHAPES.map((shape) => {
      const base = SHAPES[shape]?.weight ?? 1;
      return { shape, weight: Math.max(0.05, base - (counts[shape] || 0) * base * 0.06) };
    });
    return this.rng.weighted(entries).shape;
  }

  /**
   * Special districts are dealt from a bag and never repeat: each one shows up
   * at most once per map. Once the bag is empty there are no more specials.
   */
  /** What grows on a hill: scenic spots and housing, nothing else. */
  pickHillShape() {
    if (this.rng.next() < CONFIG.terrain.hillScenicChance) {
      const scenic = this.nextSpecialShape();
      if (scenic) return scenic;
    }
    return 'circle';
  }

  nextSpecialShape() {
    if (!this.specialBag.length) return null;
    return this.specialBag.pop();
  }

  shouldSpawnSpecial() {
    const n = this.stations.length;
    return n >= CONFIG.station.specialFirstAfter && (n - CONFIG.station.specialFirstAfter) % CONFIG.station.specialEvery === 0;
  }

  spawnStation() {
    if (this.stations.length >= this.stationCap()) {
      // Re-check soon: the cap lifts the moment the opening week ends.
      this.stationTimer = this.stations.length >= MAX_STATIONS ? this.nextStationDelay() : 1.5;
      return null;
    }
    const wantsSpecial = this.shouldSpawnSpecial();
    const specialShape = wantsSpecial ? this.nextSpecialShape() : null;
    let shape = specialShape ?? this.pickNormalShape();
    const spot = this.findSpot(specialShape ? { peripheral: true, shapeHint: specialShape } : {});
    // A station that lands on a hill is a hill district: mostly scenic, some
    // housing, and never a hub or a commercial centre.
    if (spot && this.terrain && this.terrain.mountainAt(spot.x, spot.y) >= 0) {
      shape = this.pickHillShape();
    }
    this.stationTimer = this.nextStationDelay();
    if (!spot) return null;
    const station = this.createStation(spot.x, spot.y, shape);
    station.spawnTimer = this.passengerIntervalFor(station) * this.rng.range(0.5, 1.1);
    station.pulse = 1;
    station.radiusScale = this.currentRadiusScale ?? 1;
    this.stations.push(station);
    this.stationVersion++;
    return station;
  }

  /**
   * A burst of demand at one special district. Specials are quiet most of the
   * time; this is what makes them occasionally the busiest platform on the map.
   */
  triggerDistrictEvent() {
    // A sudden crowd at one station is a late-game pressure, not an opening
    // one: below this score there simply are no surges.
    if ((this.score ?? 0) < CONFIG.passenger.eventAfterScore) return null;
    const specials = this.stations.filter((st) => isSpecialShape(st.shape));
    if (!specials.length) return null;
    const station = specials[this.rng.int(0, specials.length - 1)];
    const [lo, hi] = CONFIG.passenger.eventSize;
    const n = this.rng.int(lo, hi);
    let added = 0;
    for (let i = 0; i < n; i++) {
      const dest = this.pickDestination(station);
      if (!dest) break;
      station.passengers.push(makePassenger(dest, this.time));
      added += 1;
    }
    if (added) {
      station.pulse = 1;
      this.activeEvent = { stationId: station.id, n: added, at: this.time };
      this.toast(`${SHAPES[station.shape]?.role || '特殊站点'}迎来一波客流`, 2.6);
    }
    return added || null;
  }

  /**
   * Choose a destination shape for someone leaving `station`.
   *
   * The direction of travel comes from the district the station belongs to:
   * housing sends people everywhere except the bank, commerce sends them home,
   * a hospital only ever swaps with housing, and so on. A district that has
   * more stations on the map attracts proportionally more of that traffic.
   */
  pickDestination(station) {
    const counts = this.shapeCounts();
    const flows = CONFIG.passenger.flows[station.shape] || null;
    const entries = [];

    if (flows) {
      for (const shape of Object.keys(flows)) {
        const w = flows[shape];
        if (!(w > 0) || !counts[shape] || shape === station.shape) continue;
        // More of that district on the map means more reason to go there.
        entries.push({ shape, weight: w * (1 + Math.sqrt(counts[shape]) * 0.4) });
      }
    }
    if (!entries.length) {
      // Nothing in the table is on the map yet: fall back to plain distance-free
      // choice among whatever exists, so early stations still generate demand.
      for (const shape of Object.keys(counts)) {
        if (shape === station.shape || !counts[shape]) continue;
        entries.push({ shape, weight: counts[shape] });
      }
    }
    if (!entries.length) return null;
    return this.rng.weighted(entries).shape;
  }

  /** Seconds until this particular station produces its next passenger. */
  passengerIntervalFor(station) {
    const weight = CONFIG.passenger.spawnWeight[station.shape] ?? 1;
    return this.passengerInterval() / Math.max(0.15, weight);
  }

  spawnPassengerAt(station) {
    const dest = this.pickDestination(station);
    station.spawnTimer = this.passengerIntervalFor(station);
    if (!dest) return null;
    const p = makePassenger(dest, this.time);
    station.passengers.push(p);
    if (this.rng.next() < CONFIG.passenger.burstChance) {
      const extra = this.pickDestination(station);
      if (extra) station.passengers.push(makePassenger(extra, this.time));
    }
    return p;
  }

  // ----------------------------------------------------------------- clock

  advanceClock(step) {
    this.dayClock += step;
    while (this.dayClock >= CONFIG.clock.daySeconds) {
      this.dayClock -= CONFIG.clock.daySeconds;
      this.day++;
      if (this.day > CONFIG.clock.daysPerWeek) {
        this.day = 1;
        this.week++;
        // The depot sends a locomotive every week, on the house. It is tied to
        // the rollover itself so it can never double up or be missed.
        this.grantWeeklyLocomotive();
        this.openUpgrade();
        return;
      }
    }
  }

  get dayNames() {
    return ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  }

  get clockLabel() {
    return `${this.dayNames[Math.min(this.day, 7) - 1]} · 第 ${this.week} 周`;
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    if (this.state !== GameState.PLAYING) return;
    if (!Number.isFinite(dt)) return;
    const step = Math.min(Math.max(dt, 0), 0.125);
    this.time += step;
    if (this.scorePulse > 0) this.scorePulse = Math.max(0, this.scorePulse - step);
    this.tickToasts(step);

    this.advanceClock(step);
    if (this.state !== GameState.PLAYING) return;

    // Reveal: smoothstep over one week, so the map opens out gradually rather
    // than jumping. stations shrink while it is still zoomed in.
    const ramp = Math.max(1, CONFIG.view.rampSeconds);
    const raw = Math.max(0, Math.min(1, this.time / ramp));
    // Ease-in, so the first week stays tight and the second opens it up.
    const eased = Math.pow(raw, Math.max(1, CONFIG.view.curve ?? 1));
    const start = CONFIG.view.startFraction;
    this.viewFraction = start + (1 - start) * eased;
    // Cross-river sites are discouraged at first and unlocked gradually:
    // nothing at all for the first week, then easing in over the next three.
    const days = this.time / Math.max(1, CONFIG.clock.daySeconds);
    const grid = CONFIG.grid;
    const across = Math.max(
      0,
      Math.min(1, (days - grid.acrossRiverFromDay) / Math.max(1, grid.acrossRiverFullDay - grid.acrossRiverFromDay)),
    );
    this.acrossRiverPenalty = grid.acrossRiverPenalty * (1 - across);

    // Lines whose last train has parked give their colour slot back here.
    this.releaseFinishedLines();

    const sStart = CONFIG.view.stationScaleAtStart;
    const radiusScale = sStart + (1 - sStart) * eased;
    this.currentRadiusScale = radiusScale;
    for (const st of this.stations) st.radiusScale = radiusScale;

    this.stationTimer -= step;
    if (this.stationTimer <= 0) this.spawnStation();

    // Every so often one special district has a rush: a tourist season, a match
    // day, a flu outbreak. Quiet most of the time, then a crowd all at once.
    this.eventTimer -= step;
    if (this.eventTimer <= 0) {
      this.eventTimer = this.rng.range(CONFIG.passenger.eventInterval[0], CONFIG.passenger.eventInterval[1]);
      this.triggerDistrictEvent();
    }

    for (const station of this.stations) {
      station.update(step);
      station.spawnTimer -= step;
      if (station.spawnTimer <= 0) this.spawnPassengerAt(station);
    }

    for (const line of this.lines) {
      for (const train of line.trains) train.update(step, this);
    }

    this.updateFrozenTrains(step);
    this.checkOvercrowding();
  }

  checkOvercrowding() {
    for (const station of this.stations) {
      // A station that a train relieved later in the same frame is safe: the
      // countdown only resets inside station.update, so re-test the queue here.
      if (!station.hasExpired || !station.isOvercrowded) continue;
      if (this.mode.overcrowdFatal) {
        this.gameOver(station);
        return;
      }
      const lost = station.clearPassengers();
      this.overcrowdIncidents++;
      this.score = Math.max(0, this.score - 4);
      this.toast(`${station.id} 站台超载，${lost} 名乘客流失`);
    }
  }

  gameOver(station) {
    if (this.state === GameState.GAMEOVER) return;
    this.state = GameState.GAMEOVER;
    this.gameOverStation = station || null;
    this.summary = {
      score: this.score,
      delivered: this.delivered,
      week: this.week,
      day: this.day,
      stations: this.stations.length,
      lines: this.activeLines().length,
      incidents: this.overcrowdIncidents,
    };
  }

  // --------------------------------------------------------------- routing

  planRoute(station, destShape, excludeLineId = null) {
    return this.network.plan(this, station, destShape, excludeLineId);
  }

  recordDelivery(_passenger, station) {
    this.delivered++;
    this.stats.deliveries++;
    this.score += CONFIG.score.perPassenger + (station.special ? CONFIG.score.specialBonus : 0);
    station.delivered++;
    this.scorePulse = 0.5;
  }

  onTrainStop(_train, _station, unloaded, boarded) {
    this.stats.stops++;
    this.stats.boardings += boarded;
    void unloaded;
    // A train that just stopped can change hands to the line waiting for it.
    this.completePendingTransfer(_train.line, _train);
  }

  // --------------------------------------------------------- vehicle moves

  /**
   * Vehicle pools and movement.
   *
   * A line can run several trains at once: every locomotive deployed on it
   * brings its own train, they may travel in opposite directions, and they
   * simply pass through each other. Carriages hang off a specific train and
   * can be detached again and moved elsewhere (or back to the tray).
   *
   * Drag kinds:
   *   { kind:'loco' }                     a locomotive, from the pool or a train
   *   { kind:'carriage' }                 a carriage, from the pool or a train
   *   { kind:'train' }                    a whole train, grabbed by its head
   *   { kind:'carriage', carIndex }       one carriage grabbed off a train
   */
  beginVehicleDrag(kind, options = {}) {
    const { line = null, train = null, carIndex = -1 } = options || {};
    if (train) {
      if (kind === 'train') {
        this.vehicleDrag = { kind: 'train', fromLineId: line.id, fromTrainId: train.id, carIndex: -1 };
        return this.vehicleDrag;
      }
      // Pulling a single carriage off a train.
      this.vehicleDrag = { kind: 'carriage', fromLineId: line.id, fromTrainId: train.id, carIndex };
      return this.vehicleDrag;
    }
    if (kind === 'loco' && this.locomotives.available <= 0) {
      this.toast('没有可用的车头');
      return null;
    }
    if (kind === 'carriage' && this.carriages.available <= 0) {
      this.toast('没有可用的车厢');
      return null;
    }
    this.vehicleDrag = { kind, fromLineId: null, fromTrainId: null, carIndex: -1 };
    return this.vehicleDrag;
  }

  cancelVehicleDrag() {
    const had = !!this.vehicleDrag;
    this.vehicleDrag = null;
    return had;
  }

  /** Add a locomotive to a line: it brings its own train. */
  /**
   * Put a locomotive on a line. `at` is either a station index or the point
   * the player released the pointer at; with a point, the train appears right
   * there on the track and points at the nearer platform.
   */
  deployLocomotive(line, at = 0) {
    if (!line) return false;
    if (this.locomotives.available <= 0) {
      this.toast('没有可用的车头');
      return false;
    }
    this.cancelBookings(line);
    this.locomotives.available--;
    const train = new Train(line, `${line.id}T${++this._trainSeq}`);
    line.trains.push(train);
    train.reset();
    this.placeTrain(train, at);
    this.network.rebuild(this);
    return true;
  }

  /** Withdraw one train: its riders go to a platform, its stock back to the pool. */
  removeTrain(line, train, dropAt = null) {
    if (!line || !train) return false;
    const index = line.trains.indexOf(train);
    if (index < 0) return false;
    if (train.passengers.length) {
      this.strandPassengers(train, dropAt ? [dropAt] : line.stations);
    }
    line.trains.splice(index, 1);
    this.locomotives.available = Math.min(this.locomotives.total, this.locomotives.available + 1);
    this.carriages.available = Math.min(this.carriages.total, this.carriages.available + train.carriages);
    train.carriages = 0;
    train.reset();
    this.network.rebuild(this);
    return true;
  }

  /** Withdraw every train on a line (the line is gone or no longer running). */
  releaseLocomotive(line, dropAt = null) {
    if (!line || !line.trains.length) return false;
    this.cancelBookings(line);
    for (const train of line.trains.slice()) this.removeTrain(line, train, dropAt);
    return true;
  }

  /**
   * Park a train. Pass a number to put it on that platform, or a `{x, y}`
   * point to drop it wherever the pointer was released.
   */
  placeTrain(train, at = 0) {
    const line = train && train.line;
    if (!line || !line.stations.length) return;
    if (at && typeof at === 'object' && Number.isFinite(at.x) && Number.isFinite(at.y)) {
      const hit = line.projectPoint(at.x, at.y);
      train.placeAtArc(hit.s, line.path.total);
      return;
    }
    const index = typeof at === 'number' ? at : 0;
    train.placeAt(index, line.stationS, line.stations.length);
  }

  /** Park every train of a line at the same platform. */
  placeTrainAt(line, stationIndex = 0) {
    if (!line || !line.trains.length) return;
    const index = Math.max(0, Math.min(line.stations.length - 1, stationIndex));
    for (const train of line.trains) this.placeTrain(train, index);
  }

  /** @returns {'applied'|'pending'|'repositioned'|'detached'|'rejected'|'none'} */
  dropVehicle(target) {
    const drag = this.vehicleDrag;
    this.vehicleDrag = null;
    if (!drag) return 'none';
    const sourceLine = drag.fromLineId ? this.lines.find((l) => l.id === drag.fromLineId) : null;
    const sourceTrain = drag.fromTrainId && sourceLine
      ? sourceLine.trains.find((t) => t.id === drag.fromTrainId) || null
      : null;

    // A carriage taken off a train and released over nothing goes back to the tray.
    if (!target || !target.line) {
      if (drag.kind === 'carriage' && sourceTrain && sourceTrain.carriages > 0) {
        sourceTrain.carriages--;
        this.carriages.available = Math.min(this.carriages.total, this.carriages.available + 1);
        this.toast('车厢已拆下，放回托盘');
        return 'detached';
      }
      return 'none';
    }

    const line = target.line;
    if (!line.isActive || line.retiring) {
      this.toast('请把车辆放到一条线路上');
      return 'rejected';
    }

    if (drag.kind === 'tunnel') {
      const hill = this.terrain ? this.terrain.mountainAt(target.x ?? 0, target.y ?? 0) : -1;
      if (hill < 0) {
        this.toast('隧道要放在山地上');
        return 'rejected';
      }
      if (line.isTunnelled(hill)) {
        this.toast('这一段已经是隧道了');
        return 'rejected';
      }
      // The line has to actually run over that hill. Sample *along* each
      // segment: a straight run between two stations has no vertex inside the
      // hill even though the track crosses it.
      let overHill = false;
      const pts = line.path.points;
      for (let i = 0; i + 1 < pts.length && !overHill; i++) {
        const a2 = pts[i];
        const b2 = pts[i + 1];
        const len = Math.hypot(b2.x - a2.x, b2.y - a2.y);
        const steps = Math.max(1, Math.ceil(len / 16));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          if (this.terrain.mountainAt(a2.x + (b2.x - a2.x) * t, a2.y + (b2.y - a2.y) * t) === hill) {
            overHill = true;
            break;
          }
        }
      }
      if (!overHill) {
        this.toast('把隧道放到线路翻过山地的那一段');
        return 'rejected';
      }
      if (this.freeTunnels() <= 0) {
        this.toast('没有可用的隧道');
        return 'rejected';
      }
      line.tunnelledHills.add(hill);
      this.toast(`${line.color.name} 打通了一条隧道`);
      this.network.rebuild(this);
      // The tray's free-tunnel figure is cached on geometryGen; without this the
      // count looks like it never went down.
      this.invalidateGeometry();
      return 'applied';
    }

    if (drag.kind === 'loco') {
      // Dragging a whole train by its head: move it, or re-position it.
      if (sourceTrain && sourceLine) {
        if (sourceLine.id === line.id) {
          this.placeTrain(sourceTrain, target);
          return 'repositioned';
        }
        return this.promiseTrain(sourceLine, sourceTrain, line) ? 'pending' : 'rejected';
      }
      // Land it where the player let go, aimed at the nearer station.
      const spot = Number.isFinite(target.x) && Number.isFinite(target.y) ? target : target.stationIndex;
      return this.deployLocomotive(line, spot) ? 'applied' : 'rejected';
    }

    if (drag.kind === 'carriage') {
      const host = line.nearestTrain(target.x ?? 0, target.y ?? 0) || line.trains[0] || null;
      if (!host) {
        this.toast('车厢只能接在已经有车头的线路上');
        return 'rejected';
      }
      if (host.carriages >= host.line.maxCarriages) {
        this.toast('这列车的车厢已达上限');
        return 'rejected';
      }
      if (sourceTrain) {
        if (sourceTrain === host) return 'none';
        if (sourceTrain.carriages <= 0) return 'none';
        sourceTrain.carriages--;
        host.carriages++;
        this.toast(`车厢转到 ${line.color.name}`);
        this.network.rebuild(this);
        return 'applied';
      }
      if (this.carriages.available <= 0) {
        this.toast('没有可用的车厢');
        return 'rejected';
      }
      this.carriages.available--;
      host.carriages++;
      this.toast(`${line.color.name} 增加一节车厢`);
      return 'applied';
    }

    if (drag.kind === 'train') {
      if (!sourceTrain || !sourceLine) return 'none';
      if (sourceLine.id === line.id) {
        this.placeTrain(sourceTrain, target);
        return 'repositioned';
      }
      return this.promiseTrain(sourceLine, sourceTrain, line) ? 'pending' : 'rejected';
    }
    return 'none';
  }

  /** Promise one train to another line; it changes hands at its next stop. */
  promiseTrain(sourceLine, train, targetLine) {
    if (!sourceLine || !train || !targetLine) return false;
    if (targetLine.id === sourceLine.id) return false;
    // A train can only be promised to one line: withdraw any earlier promise.
    for (const other of this.lines) {
      if (other === targetLine) continue;
      if (other.pendingFromLineId === sourceLine.id && other.pendingTrainId === train.id) {
        other.pendingLoco = false;
        other.pendingFromLineId = null;
        other.pendingTrainId = null;
      }
    }
    if (targetLine.pendingLoco && targetLine.pendingTrainId !== train.id) {
      this.toast(`${targetLine.color.name} 已经在等另一列车`);
      return false;
    }
    targetLine.pendingLoco = true;
    targetLine.pendingFromLineId = sourceLine.id;
    targetLine.pendingTrainId = train.id;
    this.toast(`${targetLine.color.name} 正在等待列车转线`, 2.4);
    return true;
  }

  /**
   * Drop every "a train is on its way here" booking that involves `line`,
   * either as the destination or as the source. Without this a line that stops
   * running leaves a booking behind that can never complete.
   */
  cancelBookings(line) {
    if (!line) return;
    if (line.pendingLoco) {
      line.pendingLoco = false;
      line.pendingFromLineId = null;
      line.pendingTrainId = null;
    }
    for (const other of this.lines) {
      if (other.pendingFromLineId === line.id) {
        other.pendingLoco = false;
        other.pendingFromLineId = null;
        other.pendingTrainId = null;
      }
    }
  }

  /** Called when a train stops: hand it over if another line is waiting. */
  completePendingTransfer(sourceLine, train) {
    if (!sourceLine || !train) return false;
    const target = this.lines.find(
      (l) => l.pendingLoco && l.pendingFromLineId === sourceLine.id && l.pendingTrainId === train.id,
    );
    if (!target) return false;
    target.pendingLoco = false;
    target.pendingFromLineId = null;
    target.pendingTrainId = null;

    // The booking may have gone stale: the destination could have been
    // retracted, cleared or re-staffed. In every such case the source keeps
    // its train and its passengers.
    if (!target.isActive || target.retiring) return false;

    if (target.trains.length) {
      // Something is already parked there; hand its riders to a platform.
      for (const other of target.trains.slice()) {
        if (other.passengers.length) this.strandPassengers(other, target.stations);
      }
    }

    const index = sourceLine.trains.indexOf(train);
    if (index < 0) return false;
    sourceLine.trains.splice(index, 1);
    train.line = target;
    train.id = `${target.id}T${++this._trainSeq}`;
    target.trains.push(train);
    this.placeTrain(train, 0);
    this.network.rebuild(this);
    this.toast(`${target.color.name} 接手了一列车`, 2.4);
    return true;
  }

  // ------------------------------------------------------- click-to-build

  /**
   * Drag-to-build.
   *
   * `terminus` is the T-shaped end marker the pointer grabbed, if any:
   * dragging a T extends *that* line. Dragging the station body itself always
   * opens a brand new line from that station, even at a terminus.
   */
  beginLineDrag(station, terminus = null) {
    if (!station) return null;
    this.segmentDrag = null;

    if (terminus) {
      const line = this.lines.find((l) => l.id === terminus.lineId);
      const end = line ? line.endOfStation(station.id) : -1;
      if (line && end >= 0) {
        this.drag = { lineId: line.id, end, anchorId: station.id, route: [], suppress: null, isNew: false };
        return this.drag;
      }
    }

    if (this.lineSlotsAvailable() <= 0) {
      this.toast('没有空闲的线路槽位');
      return null;
    }
    const line = this.nextFreeLine();
    if (!line) return null;
    line.claimed = true;
    line.setStations([station]);
    this.network.rebuild(this);
    this.drag = { lineId: line.id, end: 1, anchorId: station.id, route: [], suppress: null, isNew: true };
    return this.drag;
  }

  get draggingLine() {
    if (!this.drag) return null;
    return this.lines.find((l) => l.id === this.drag.lineId) || null;
  }

  /** The pointer moved over `station` while a line was being dragged. */
  dragOverStation(station) {
    const drag = this.drag;
    if (!drag || !station) return false;
    const line = this.draggingLine;
    if (!line) return false;
    if (drag.suppress && drag.suppress !== station.id) drag.suppress = null;

    const last = drag.route[drag.route.length - 1];
    if (last && last.id === station.id) return false;
    if (drag.anchorId === station.id) {
      if (drag.route.length) drag.suppress = drag.route.pop().id;
      return true;
    }
    const before = drag.route.length >= 2 ? drag.route[drag.route.length - 2] : null;
    if (before && before.id === station.id) {
      drag.suppress = drag.route.pop().id;
      return true;
    }
    if (drag.suppress === station.id) return false;
    if (drag.route.some((s) => s.id === station.id)) return false;
    if (line.hasStation(station.id)) return false;
    drag.route.push(station);
    return true;
  }

  /** Points for the in-progress rubber band: anchor, stations passed, pointer. */
  dragPreviewPoints(pointer) {
    const drag = this.drag;
    if (!drag) return [];
    const line = this.draggingLine;
    if (!line) return [];
    const anchor = line.stations.find((s) => s.id === drag.anchorId) || line.stations[0];
    if (!anchor) return [];
    const pts = [anchor, ...drag.route].map((s) => ({ x: s.x, y: s.y }));
    if (pointer) pts.push({ x: pointer.x, y: pointer.y });
    return pts;
  }

  /**
   * Release: splice the collected route onto the end of the line. Dropping the
   * end straight onto the opposite end closes the line into a loop instead.
   */
  endLineDrag(currentStation = null) {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return false;
    const line = this.lines.find((l) => l.id === drag.lineId);
    if (!line) return false;

    const route = drag.route.slice();
    if (currentStation && !route.some((s) => s.id === currentStation.id)) {
      const isAnchor = currentStation.id === drag.anchorId;
      if (!isAnchor && !line.hasStation(currentStation.id)) route.push(currentStation);
    }
    if (route.length) return this.applyRoute(line, route, drag.end);

    const opposite = drag.end === 0 ? line.stations[line.stations.length - 1] : line.stations[0];
    if (
      currentStation &&
      opposite &&
      currentStation.id === opposite.id &&
      line.stations.length >= 3 &&
      !line.isLoop
    ) {
      return this.extendLine(line, drag.end, currentStation);
    }

    // Dragging the T across a station that is already on this line takes that
    // station off the line. Drawing a *new* line and ending back where it
    // started is a cancel instead - there would be nothing left to keep.
    if (currentStation && line.hasStation(currentStation.id)) {
      const isAnchor = currentStation.id === drag.anchorId;
      if (!(drag.isNew && isAnchor)) {
        return this.detachStation(line, currentStation.id);
      }
    }

    // A brand new line that never reached a second station is thrown away,
    // which also gives its slot back.
    if (drag.isNew && !line.isActive) {
      this.tryLineEdit(line, () => line.clear());
    }
    return false;
  }

  cancelLineDrag() {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return false;
    const line = this.lines.find((l) => l.id === drag.lineId);
    if (line && drag.isNew && !line.isActive) this.tryLineEdit(line, () => line.clear());
    return true;
  }

  /** Splice a chain of stations, ordered outwards from one end, onto that end. */
  applyRoute(line, route, end) {
    if (!line || !route || !route.length) return false;
    return this.tryLineEdit(line, () => {
      if (end === 0) {
        for (const station of route) line.unshiftStation(station);
      } else {
        for (const station of route) line.pushStation(station);
      }
    });
  }

  // ------------------------------------------------- re-routing a segment

  /**
   * Grab the piece of track between stations `index` and `index + 1`. Dragging
   * it keeps both neighbours and routes the line through whatever station the
   * segment is dropped on.
   */
  beginSegmentDrag(line, index) {
    if (!line || !line.isActive) return null;
    const last = line.isLoop ? line.stations.length - 1 : line.stations.length - 2;
    if (index < 0 || index > last) return null;
    this.drag = null;
    this.segmentDrag = { lineId: line.id, index };
    return this.segmentDrag;
  }

  get reroutingLine() {
    if (!this.segmentDrag) return null;
    return this.lines.find((l) => l.id === this.segmentDrag.lineId) || null;
  }

  endSegmentDrag(station) {
    const seg = this.segmentDrag;
    this.segmentDrag = null;
    if (!seg || !station) return false;
    const line = this.lines.find((l) => l.id === seg.lineId);
    if (!line || !line.isActive) return false;
    const from = line.stations[seg.index];
    const to = line.isLoop && seg.index === line.stations.length - 1 ? line.stations[0] : line.stations[seg.index + 1];
    if (!from || !to) return false;
    // Dropping the dragged segment on a station that is already on this line
    // takes that station off the line; the track closes up behind it.
    if (line.hasStation(station.id)) return this.detachStation(line, station.id);
    return this.tryLineEdit(line, () => line.insertStationAt(station, seg.index + 1));
  }

  cancelSegmentDrag() {
    const had = !!this.segmentDrag;
    this.segmentDrag = null;
    return had;
  }

  /** The station a segment drag would splice in, for previewing. */
  segmentPreviewPoints(pointer) {
    const seg = this.segmentDrag;
    if (!seg || !pointer) return [];
    const line = this.reroutingLine;
    if (!line) return [];
    const from = line.stations[seg.index];
    const to = line.isLoop && seg.index === line.stations.length - 1 ? line.stations[0] : line.stations[seg.index + 1];
    if (!from || !to) return [];
    return [
      { x: from.x, y: from.y },
      { x: pointer.x, y: pointer.y },
      { x: to.x, y: to.y },
    ];
  }

  // ----------------------------------------------------------------- retire

  /**
   * Wipe a line. If its train still has passengers aboard the line is retired
   * instead: it fades, keeps running, delivers everyone, and only then goes
   * away and frees its slot.
   */
  clearLine(line) {
    if (!line) return false;
    if (this.drag?.lineId === line.id) this.drag = null;
    if (this.segmentDrag?.lineId === line.id) this.segmentDrag = null;
    if (this.vehicleDrag?.fromLineId === line.id) this.vehicleDrag = null;
    this.cancelBookings(line);

    // A train on the old route keeps running (faded) until the next station;
    // the track and the slot are released straight away.
    const busy = line.isRunning && line.trains.length > 0;
    if (busy) {
      const snapshot = new RouteSnapshot(line);
      line.retiring = true;
      for (const train of line.trains) {
        if (train.frozen) continue;
        train.freeze(snapshot, CONFIG.lines.retireSeconds);
        train.awaitStation = true;
      }
      line.stations = [];
      line.isLoop = false;
      line.claimed = false;
      line.rebuild();
      this.invalidateGeometry();
      this.network.rebuild(this);
      this.toast(`${line.color.name} 的列车到站后停运`);
      return true;
    }
    return this.tryLineEdit(line, () => line.clear());
  }

  /**
   * Trains finishing an old route.
   *
   * Two cases, both ending at the next station the train reaches:
   *  - the line is gone (cleared): the train hands its riders to the platform
   *    and the locomotive goes back to the pool;
   *  - the line was re-routed: if the arrival station is still on the new
   *    route the train carries on from there, otherwise it is withdrawn and
   *    its passengers are left standing on that platform.
   */
  updateFrozenTrains(dt) {
    for (const line of this.lines) {
      for (const train of line.trains.slice()) {
      if (!train.frozen) continue;
      train.freezeTimer -= dt;
      const snapshot = train.frozen;
      const arrived = train.arrivedThisFrame;
      if (!arrived && train.freezeTimer > 0) continue;

      const station = arrived ? snapshot.stations[train.stopIndex] || null : null;
      train.frozen = null;
      train.freezeTimer = 0;
      train.freezeTravelled = 0;
      train.awaitStation = false;
      train.v = 0;

      if (!line.isActive) {
        line.retiring = false;
        this.removeTrain(line, train, station);
        this.toast(`${line.color.name} 已停运`);
        continue;
      }

      const stillOnRoute = station ? line.hasStation(station.id) : false;
      if (stillOnRoute) {
        // Carry straight on along the new route from this station.
        const index = line.indexOfStation(station.id);
        train.placeAt(index, line.stationS, line.stations.length);
      } else {
        this.removeTrain(line, train, station);
        this.toast(`${line.color.name} 的列车已回收，乘客留在站台`, 2.6);
      }
      }
    }
  }

  /** The part of the world the player can currently see. */
  viewRect() {
    const { w, h } = CONFIG.world;
    const f = Math.max(0.05, Math.min(1, this.viewFraction));
    const vw = w * f;
    const vh = h * f;
    const a = this.viewAnchor || { x: w / 2, y: h / 2 };
    const cx = Math.max(vw / 2, Math.min(w - vw / 2, a.x));
    const cy = Math.max(vh / 2, Math.min(h - vh / 2, a.y));
    return { x: cx - vw / 2, y: cy - vh / 2, w: vw, h: vh };
  }

  /** How far a station must stay from a hill's edge to count as on/off it. */
  hillClearance() {
    return CONFIG.terrain.stationClearance * (this.currentRadiusScale ?? 1);
  }

  /** Stations sitting wholly inside this hill. */
  stationsOnHill(hill) {
    if (hill < 0 || !this.terrain) return 0;
    const margin = this.hillClearance();
    let n = 0;
    for (const st of this.stations) {
      if (this.terrain.distanceTo(st.x, st.y) <= -margin && this.terrain.mountainAt(st.x, st.y) === hill) {
        n += 1;
      }
    }
    return n;
  }

  /** Whether a world point is inside the revealed rectangle. */
  inView(x, y) {
    const v = this.viewRect();
    const mx = v.w * CONFIG.view.margin;
    const my = v.h * CONFIG.view.margin;
    return x >= v.x + mx && x <= v.x + v.w - mx && y >= v.y + my && y <= v.y + v.h - my;
  }

  /** True while some active line still has no locomotive to run it. */
  get locomotiveShortage() {
    return this.lines.some((l) => l.isActive && !l.hasLocomotive && !l.retiring);
  }

  /** The next unused line object; retiring lines and lines with a train on the
   *  way to them are still holding theirs. */
  nextFreeLine() {
    return (
      this.lines.find(
        (l) => !l.claimed && !l.retiring && !l.pendingLoco && l.stations.length === 0,
      ) || null
    );
  }

  /** The first active line that visits this station, if any. */
  lineOf(stationId) {
    for (const line of this.activeLines()) {
      if (line.hasStation(stationId)) return line;
    }
    return null;
  }

  // ---------------------------------------------------------------- lines

  activeLines() {
    return this.lines.filter((l) => l.isActive);
  }

  /** Lines that still accept passengers and can be routed through. A line with
   *  no locomotive draws but carries nobody, so nobody plans a trip on it. */
  liveLines() {
    return this.lines.filter((l) => l.isActive && !l.retiring && l.hasLocomotive);
  }

  /**
   * Lines that occupy a colour slot. A line that is still retiring counts:
   * its old train is still running in that colour, so handing the slot to a
   * new line would put more colours on the map than the player has unlocked.
   */
  claimedLines() {
    return this.lines.filter((l) => l.claimed || l.retiring);
  }

  /** Give back the slots of lines whose last train has finally parked. */
  releaseFinishedLines() {
    let freed = false;
    for (const line of this.lines) {
      if (!line.retiring || line.trains.length > 0) continue;
      // Reuse the very same object, so re-drawing a line here keeps its colour.
      line.retiring = false;
      line.claimed = false;
      line.tunnelledHills?.clear();
      freed = true;
    }
    return freed;
  }

  lineSlotsAvailable() {
    // Free line objects are finite too: a retiring line still occupies one.
    const freeObjects = this.lines.filter(
      (l) => !l.claimed && !l.retiring && !l.pendingLoco && l.stations.length === 0,
    ).length;
    return Math.max(0, Math.min(this.unlockedLines - this.claimedLines().length, freeObjects));
  }

  /**
   * Where each line's shared legs sit, perpendicular to the track.
   *
   * Returns Map<lineId, Map<legKey, offset>>. Two lines on the same stretch of
   * track would otherwise be drawn one on top of the other: only the top one
   * visible, and only the top one grabbable. Both the renderer and the hit test
   * read this, so what you see and what you can grab cannot disagree.
   */
  legOffsets() {
    if (this._legCacheGen === this.geometryGen) return this._legCache;
    const byLeg = new Map();
    const lines = this.activeLines();
    for (const line of lines) {
      for (let i = 0; i + 1 < line.stations.length; i++) {
        const key = normLegKey(line.stations[i].id, line.stations[i + 1].id);
        if (!byLeg.has(key)) byLeg.set(key, []);
        byLeg.get(key).push(line);
      }
      if (line.isLoop && line.stations.length >= 3) {
        const n = line.stations.length;
        const key = normLegKey(line.stations[n - 1].id, line.stations[0].id);
        if (!byLeg.has(key)) byLeg.set(key, []);
        byLeg.get(key).push(line);
      }
    }
    const out = new Map();
    for (const line of lines) out.set(line.id, new Map());
    for (const [key, shared] of byLeg) {
      if (shared.length < 2) continue;
      shared.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      shared.forEach((line, i) => {
        out.get(line.id).set(key, (i - (shared.length - 1) / 2) * CONFIG.lines.overlapGap);
      });
    }
    this._legCacheGen = this.geometryGen;
    this._legCache = out;
    return out;
  }

  /** Call after any change to which stations a line visits. */
  invalidateGeometry() {
    this.geometryGen++;
    return this.geometryGen;
  }

  tunnelsAllocated() {
    if (this._tunnelCacheGen === this.geometryGen) return this._tunnelCache;
    let n = 0;
    for (const line of this.activeLines()) {
      n += line.crossingsWith(this.river);
      // A tunnel bought for a hill counts against the same budget.
      n += line.tunnelledHills ? line.tunnelledHills.size : 0;
    }
    this._tunnelCacheGen = this.geometryGen;
    this._tunnelCache = n;
    return n;
  }

  freeTunnels() {
    return Math.max(0, this.tunnelsOwned - this.tunnelsAllocated());
  }

  /**
   * Hand a train's riders back to the network instead of deleting them.
   * Used when a line stops running and nobody can be delivered.
   */
  strandPassengers(train, stations) {
    const riders = train.passengers;
    if (!riders || !riders.length) return 0;
    const list = stations || [];
    let host = list[0] || null;
    if (!host && this.stations.length) {
      const from = train.route.path.total > 0 ? train.position : null;
      let best = null;
      let bestD = Infinity;
      for (const station of this.stations) {
        const d = from ? dist(from.x, from.y, station.x, station.y) : 0;
        if (d < bestD) {
          bestD = d;
          best = station;
        }
      }
      host = best;
    }
    if (!host) return 0;
    for (const passenger of riders) {
      passenger.targetStationId = null;
      passenger.lastLineId = null;
      host.passengers.push(passenger);
    }
    train.passengers = [];
    return riders.length;
  }

  strandRiders(line) {
    let n = 0;
    for (const train of line.trains) n += this.strandPassengers(train, line.stations);
    return n;
  }

  /** Apply an edit, then roll it back if it would need tunnels we do not have. */
  tryLineEdit(line, fn) {
    const snapshot = { stations: line.stations.slice(), isLoop: line.isLoop, claimed: line.claimed };
    const wasActive = line.isActive;
    /**
     * Does the *old* route need finishing off? Only when the stations the line
     * visits actually changed shape: appending or retracting an end station
     * leaves the old route as a contiguous slice of the new one, so the train
     * simply carries on. Splitting, re-routing or removing a middle station
     * does need the hand-over dance.
     */
    const movingTrains = line.trains.filter((t) => !t.frozen);
    const oldRoute = movingTrains.length && line.stations.length >= 2 ? new RouteSnapshot(line) : null;

    fn();
    line.rebuild();
    // The tunnel test must look at the *new* geometry, never a cached count.
    this.invalidateGeometry();

    if (this.tunnelsAllocated() > this.tunnelsOwned) {
      line.stations = snapshot.stations;
      line.isLoop = snapshot.isLoop;
      line.claimed = snapshot.claimed;
      line.rebuild();
      this.invalidateGeometry();
      this.toast('隧道不足：无法跨过河流');
      this.network.rebuild(this);
      return false;
    }

    if (line.stations.length === 0) line.claimed = false;

    // An edit only disturbs the trains that were actually on the track it
    // changed. Everything else is simply re-anchored onto the new geometry and
    // keeps running; only the affected trains finish their old route, faded.
    const stuck = [];
    for (const train of movingTrains) {
      const mapped = oldRoute ? line.remapArcFrom(oldRoute, train.s) : null;
      if (mapped === null) {
        stuck.push(train);
        continue;
      }
      train.s = mapped;
      train.v = 0;
      if (train.stopIndex >= line.stations.length) {
        train.stopIndex = Math.max(0, line.stations.length - 1);
      }
    }

    if (stuck.length && oldRoute) {
      for (const train of stuck) {
        train.freeze(oldRoute, CONFIG.lines.transitionSeconds);
        train.awaitStation = true;
      }
    } else if (wasActive && !line.isActive) {
      this.releaseLocomotive(line);
    } else if (!wasActive && line.isActive) {
      // A brand new line takes a locomotive with it; the tray is for adding
      // *more* trains to a line (or for replacing one that was withdrawn).
      this.deployLocomotive(line, 0);
    }
    this.network.rebuild(this);
    return true;
  }

  startLine(station) {
    if (!station) return null;
    if (this.lineSlotsAvailable() <= 0) {
      this.toast('没有空闲的线路槽位');
      return null;
    }
    const line = this.nextFreeLine();
    if (!line) return null;
    line.claimed = true;
    line.setStations([station]);
    this.network.rebuild(this);
    return line;
  }

  /**
   * Extend one end of a line to `station`.
   * `end` is 0 for the head of the station list, 1 for the tail.
   */
  extendLine(line, end, station) {
    if (!line || !station) return false;
    if (line.hasStation(station.id)) {
      const opposite = end === 0 ? line.stations[line.stations.length - 1] : line.stations[0];
      if (line.stations.length >= 3 && !line.isLoop && opposite && opposite.id === station.id) {
        return this.tryLineEdit(line, () => {
          line.isLoop = true;
        });
      }
      return false;
    }
    return this.tryLineEdit(line, () => {
      if (end === 0) line.unshiftStation(station);
      else line.pushStation(station);
    });
  }

  /** Retract an end of the line (drop it on empty space). */
  retractEndpoint(line, end) {
    if (!line || !line.stations.length) return false;
    if (line.stations.length <= 1) {
      return this.tryLineEdit(line, () => line.clear());
    }
    return this.tryLineEdit(line, () => {
      if (line.isLoop) {
        line.isLoop = false;
        line.rebuild();
      }
      line.removeStationAt(end === 0 ? 0 : line.stations.length - 1);
    });
  }

  /** Break a loop so it can be edited again. */
  breakLoop(line) {
    if (!line || !line.isLoop) return false;
    return this.tryLineEdit(line, () => {
      line.isLoop = false;
    });
  }

  /** Pull a station out of the middle of a line; the line heals up. */
  detachStation(line, stationId) {
    if (!line) return false;
    const index = line.indexOfStation(stationId);
    if (index < 0) return false;
    if (line.isLoop) {
      return this.tryLineEdit(line, () => {
        line.isLoop = false;
        line.removeStationAt(index);
      });
    }
    if (index === 0 || index === line.stations.length - 1) return this.retractEndpoint(line, index === 0 ? 0 : 1);
    return this.tryLineEdit(line, () => line.removeStationAt(index));
  }

  // ------------------------------------------------------------ placements

  beginPlacement(item) {
    if (item === 'interchange' && this.inventory.interchanges <= 0) return false;
    this.placement = { item };
    return true;
  }

  cancelPlacement() {
    this.placement = null;
  }

  /** Legacy path kept for the API and tests; the HUD drags carriages now. */
  placeCarriage(line) {
    if (!line || this.carriages.available <= 0) return false;
    const train = line.trains[0];
    if (!train) {
      this.toast('车厢只能接在已经有车头的线路上');
      return false;
    }
    if (train.carriages >= line.maxCarriages) {
      this.toast('这列车的车厢已达上限');
      return false;
    }
    train.carriages++;
    this.carriages.available--;
    this.toast(`${line.color.name} 增加一节车厢`);
    return true;
  }

  placeInterchange(station) {
    if (!station || this.inventory.interchanges <= 0) return false;
    if (!station.upgradeToInterchange()) {
      this.toast('该站已经是换乘站');
      return false;
    }
    this.inventory.interchanges--;
    this.stationVersion++;
    if (this.inventory.interchanges <= 0 && this.placement?.item === 'interchange') this.placement = null;
    this.toast(`${station.id} 升级为换乘站`);
    return true;
  }

  // ---------------------------------------------------------------- rewards

  buildRewardOptions() {
    const pool = [];
    if (this.unlockedLines < CONFIG.lines.maxSlots) {
      pool.push({ kind: 'line', label: '新线路', hint: '解锁一条新的地铁线路', weight: 1.5, icon: 'line' });
    }
    pool.push({ kind: 'tunnel', label: `隧道 ×${CONFIG.tunnels.perPick}`, hint: '让线路跨过河流', weight: 2.1, icon: 'tunnel' });
    if (this.activeLines().length > 0) {
      pool.push({ kind: 'carriage', label: '车厢', hint: '拖到有车头的线路上，载客量 +6', weight: 1.7, icon: 'carriage' });
    }
    pool.push({ kind: 'interchange', label: '换乘站', hint: '装到车站上，站台容量 +3', weight: 1.4, icon: 'interchange' });

    const wanted = this.week >= CONFIG.rewards.thirdOptionFromWeek ? 3 : CONFIG.rewards.optionsPerWeek;
    const picked = [];
    const remaining = pool.slice();
    while (picked.length < wanted && remaining.length) {
      const choice = this.rng.weighted(remaining);
      if (!choice) break;
      picked.push(choice);
      remaining.splice(remaining.indexOf(choice), 1);
    }
    return picked;
  }

  openUpgrade() {
    if (this.state === GameState.GAMEOVER) return;
    const options = this.buildRewardOptions();
    if (!options.length) return;
    this.rewardOptions = options;
    this.rewardWeek = this.week;
    this.state = GameState.UPGRADE;
  }

  /** The automatic weekly locomotive: not part of the reward choice. */
  grantWeeklyLocomotive() {
    this.locomotives.total += 1;
    this.locomotives.available += 1;
    this.toast('新车头已送到托盘');
    return true;
  }

  chooseReward(kind) {
    if (this.state !== GameState.UPGRADE) return false;
    switch (kind) {
      case 'line':
        if (this.unlockedLines >= CONFIG.lines.maxSlots) return false;
        this.unlockedLines++;
        // A new line slot comes with a locomotive, otherwise the extra line
        // would be dead track until a second reward showed up.
        this.locomotives.total++;
        this.locomotives.available++;
        this.toast('解锁了一条新线路，并附带一个车头');
        break;
      case 'tunnel':
        this.tunnelsOwned += CONFIG.tunnels.perPick;
        this.toast(`获得 ${CONFIG.tunnels.perPick} 条隧道`);
        break;
      case 'locomotive':
        this.locomotives.total++;
        this.locomotives.available++;
        this.toast('获得一个车头，拖到线路上即可运营');
        break;
      case 'carriage':
        this.carriages.total++;
        this.carriages.available++;
        this.toast('获得一节车厢，拖到有车头的线路上');
        break;
      case 'interchange':
        this.inventory.interchanges++;
        this.toast('获得一个换乘站，点击后装到车站上');
        break;
      default:
        return false;
    }
    this.rewardOptions = [];
    this.state = GameState.PLAYING;
    return true;
  }

  // ----------------------------------------------------------------- misc

  toast(text, ttl = 2.6) {
    this.toasts.push({ text, ttl, max: ttl, id: Math.random().toString(36).slice(2) });
    if (this.toasts.length > 4) this.toasts.shift();
  }

  tickToasts(dt) {
    for (const t of this.toasts) t.ttl -= dt;
    this.toasts = this.toasts.filter((t) => t.ttl > 0);
  }
}
