// Randomised adversarial fuzz over the line/vehicle/transfer API, with exact
// record/replay so any failure can be shrunk to a minimal op sequence.
//
// Invariants checked after every operation:
//   P1  no passenger object ever disappears (platform / train / delivered / cleared)
//   P2  locomotives.available + count(hasLocomotive) === locomotives.total
//   P3  carriages.available + sum(line.carriages) === carriages.total
//   P4  a station is never listed twice on the same line
//   P5  train.s stays finite and inside its route path
import { Game, GameState } from '../src/game.js';
import { Rng } from '../src/rng.js';
import { makePassenger } from '../src/passenger.js';
import { Census, vehicleInvariants, FRAME } from './lib.mjs';

const SHAPES = ['circle', 'triangle', 'square', 'diamond', 'star', 'gem', 'cross'];

/** Invariant breaks that end a run: passenger/vehicle loss and broken geometry.
 *  Softer state inconsistencies are counted but the run continues, so the
 *  downstream damage gets a chance to appear. */
const FATAL = new Set(['VANISH', 'loco', 'carr', 'duplicate-station', 'train-s-out-of-range', 'frozen-s-nan', 'stopIndex-out-of-range']);

function randIdx(rng, n) {
  return Math.floor(rng.next() * n);
}
function pick(rng, arr) {
  if (!arr.length) return null;
  return arr[randIdx(rng, arr.length)];
}

export function makeGame(seed, presets = {}) {
  const game = new Game({ seed, mode: 'endless' });
  const rng = new Rng((seed ^ 0x9e37) >>> 0);
  const wanted = presets.stations ?? 12;
  for (let i = 0; i < wanted * 3 && game.stations.length < 3 + wanted; i++) {
    const x = 120 + rng.next() * 1360;
    const y = 120 + rng.next() * 760;
    if (game.river.distanceTo(x, y) < 60) continue;
    game.addStation(x, y, SHAPES[randIdx(rng, SHAPES.length)]);
  }
  game.carriages.total = 8;
  game.carriages.available = 8;
  game.locomotives.total = 8;
  game.locomotives.available = 8;
  game.unlockedLines = 7;
  if (presets.stable !== false && game.stations.length >= 9) {
    // Three running lines so trains actually carry people while the fuzz hacks
    // at the rest of the network.
    for (let k = 0; k < 3; k++) {
      const line = game.startLine(game.stations[k * 3]);
      if (!line) break;
      game.extendLine(line, 1, game.stations[k * 3 + 1]);
      game.extendLine(line, 1, game.stations[k * 3 + 2]);
      for (const t of line.trains) t.reset();
    }
  }
  return game;
}

// ---------------------------------------------------------------- planning

const OPS = [
  'extend', 'extend', 'retract', 'clear', 'rerouteSeg',
  'detach', 'loop', 'locoDrop', 'locoDropPending', 'release', 'carriageDrop',
  'trainTransfer', 'trainTransfer', 'trainTransfer', 'lineDrag',
  'inject', 'inject', 'inject', 'update', 'update', 'update', 'update', 'update',
];

/** Pure choice of what to do next, based only on the current state. */
export function planOp(game, rng) {
  const op = OPS[randIdx(rng, OPS.length)];
  const st = game.stations[randIdx(rng, game.stations.length)];
  const active = game.activeLines();
  const line = pick(rng, active);
  const p = { op };
  switch (op) {
    case 'inject': {
      const dest = pick(rng, game.stations.filter((s) => s.shape !== st.shape));
      if (!dest) return { op: 'noop' };
      p.stationId = st.id;
      p.destShape = dest.shape;
      return p;
    }
    case 'locoDropPending': {
      const pend = pick(rng, game.lines.filter((l) => l.pendingLoco && l.isActive));
      if (!pend || game.locomotives.available <= 0) return { op: 'noop' };
      p.lineId = pend.id;
      p.stationIndex = 0;
      return p;
    }
    case 'extend': {
      if (!line) return { op: 'noop' };
      const cand = game.stations.filter((s) => !line.hasStation(s.id));
      const to = pick(rng, cand);
      if (!to) return { op: 'noop' };
      p.lineId = line.id;
      p.end = rng.next() < 0.5 ? 0 : 1;
      p.stationId = to.id;
      return p;
    }
    case 'newline': {
      if (game.lineSlotsAvailable() <= 0 || !game.nextFreeLine()) return { op: 'noop' };
      const cand = game.stations.filter((s) => s.id !== st.id);
      const b = pick(rng, cand);
      if (!b) return { op: 'noop' };
      p.aId = st.id;
      p.bId = b.id;
      return p;
    }
    case 'retract': {
      if (!line) return { op: 'noop' };
      p.lineId = line.id;
      p.end = rng.next() < 0.5 ? 0 : 1;
      return p;
    }
    case 'clear': {
      if (!line) return { op: 'noop' };
      p.lineId = line.id;
      return p;
    }
    case 'rerouteSeg': {
      if (!line) return { op: 'noop' };
      const last = line.isLoop ? line.stations.length - 1 : line.stations.length - 2;
      if (last < 0) return { op: 'noop' };
      const cand = game.stations.filter((s) => !line.hasStation(s.id));
      const via = pick(rng, cand);
      p.lineId = line.id;
      p.index = randIdx(rng, last + 1);
      p.viaId = via ? via.id : null;
      return p;
    }
    case 'detach': {
      if (!line) return { op: 'noop' };
      p.lineId = line.id;
      p.stationId = line.stations[randIdx(rng, line.stations.length)].id;
      return p;
    }
    case 'loop': {
      if (!line || line.isLoop) return { op: 'noop' };
      if (line.stations.length >= 3 && rng.next() < 0.5) {
        p.mode = 'close';
        p.end = rng.next() < 0.5 ? 0 : 1;
        p.lineId = line.id;
      } else {
        p.mode = 'break';
        p.lineId = line.id;
      }
      return p;
    }
    case 'locoDrop': {
      if (!line || game.locomotives.available <= 0) return { op: 'noop' };
      p.lineId = line.id;
      p.stationIndex = randIdx(rng, line.stations.length);
      return p;
    }
    case 'release': {
      const l2 = pick(rng, game.lines.filter((l) => l.hasLocomotive));
      if (!l2) return { op: 'noop' };
      p.lineId = l2.id;
      return p;
    }
    case 'carriageDrop': {
      if (!line || !line.hasLocomotive || game.carriages.available <= 0) return { op: 'noop' };
      p.lineId = line.id;
      return p;
    }
    case 'trainTransfer': {
      const src = pick(rng, game.lines.filter((l) => l.hasLocomotive));
      if (!src) return { op: 'noop' };
      const dst = pick(rng, game.lines.filter((l) => l.isActive && !l.retiring && !l.pendingLoco && l.id !== src.id));
      if (!dst) return { op: 'noop' };
      p.srcId = src.id;
      p.dstId = dst.id;
      return p;
    }
    case 'lineDrag': {
      const l2 = pick(rng, game.lines.filter((l) => l.isActive && !l.isLoop));
      if (!l2) return { op: 'noop' };
      p.lineId = l2.id;
      p.end = rng.next() < 0.5 ? 0 : 1;
      const cand = game.stations.filter((s) => !l2.hasStation(s.id));
      const over = pick(rng, cand);
      p.overId = over ? over.id : null;
      p.commit = rng.next() < 0.5;
      return p;
    }
    case 'update': {
      const frames = 1 + randIdx(rng, 40);
      p.dts = [];
      for (let i = 0; i < frames; i++) p.dts.push(FRAME * (rng.next() < 0.2 ? 3 : 1));
      return p;
    }
    default:
      return { op: 'noop' };
  }
}

const byId = (game, id) => game.lines.find((l) => l.id === id) || null;
const stById = (game, id) => game.stations.find((s) => s.id === id) || null;

/** Deterministic execution of a plan. Returns a human log line. */
export function execOp(game, p) {
  switch (p.op) {
    case 'noop':
      return 'noop';
    case 'extend': {
      const line = byId(game, p.lineId);
      const st = stById(game, p.stationId);
      if (!line || !st) return 'extend (stale)';
      return `extendLine(${line.id},${p.end},${st.id}) -> ${game.extendLine(line, p.end, st)}`;
    }
    case 'newline': {
      const a = stById(game, p.aId);
      const b = stById(game, p.bId);
      if (!a || !b) return 'newline (stale)';
      const free = game.nextFreeLine();
      if (!free) return 'newline (no slot)';
      const ok = game.beginLineDrag(a, null);
      if (!ok) return 'newline (rejected)';
      game.dragOverStation(b);
      game.endLineDrag(b);
      return `newline from ${a.id} via ${b.id} -> ${free.id} n=${free.stations.length}`;
    }
    case 'retract': {
      const line = byId(game, p.lineId);
      if (!line) return 'retract (stale)';
      return `retractEndpoint(${line.id},${p.end}) -> ${game.retractEndpoint(line, p.end)}`;
    }
    case 'clear': {
      const line = byId(game, p.lineId);
      if (!line) return 'clear (stale)';
      return `clearLine(${line.id}) -> ${game.clearLine(line)}`;
    }
    case 'rerouteSeg': {
      const line = byId(game, p.lineId);
      if (!line) return 'reroute (stale)';
      const last = line.isLoop ? line.stations.length - 1 : line.stations.length - 2;
      if (p.index > last) return 'reroute (stale index)';
      const via = p.viaId ? stById(game, p.viaId) : null;
      game.beginSegmentDrag(line, p.index);
      const ok = via ? game.endSegmentDrag(via) : (game.cancelSegmentDrag(), false);
      return `segmentDrag(${line.id},${p.index} via ${p.viaId}) -> ${ok}`;
    }
    case 'detach': {
      const line = byId(game, p.lineId);
      const st = stById(game, p.stationId);
      if (!line || !st) return 'detach (stale)';
      return `detachStation(${line.id},${st.id}) -> ${game.detachStation(line, st.id)}`;
    }
    case 'loop': {
      const line = byId(game, p.lineId);
      if (!line) return 'loop (stale)';
      if (p.mode === 'close') {
        const opposite = p.end === 0 ? line.stations[line.stations.length - 1] : line.stations[0];
        if (!opposite) return 'loop (stale)';
        return `closeLoop(${line.id}) -> ${game.extendLine(line, p.end, opposite)}`;
      }
      return `breakLoop(${line.id}) -> ${game.breakLoop(line)}`;
    }
    case 'locoDrop': {
      const line = byId(game, p.lineId);
      if (!line || game.locomotives.available <= 0) return 'locoDrop (stale)';
      game.beginVehicleDrag('loco');
      return `dropVehicle(loco->${line.id}) -> ${game.dropVehicle({ line, stationIndex: Math.min(p.stationIndex, line.stations.length - 1) })}`;
    }
    case 'release': {
      const line = byId(game, p.lineId);
      if (!line || !line.hasLocomotive) return 'release (stale)';
      return `releaseLocomotive(${line.id}) -> ${game.releaseLocomotive(line)}`;
    }
    case 'inject': {
      const st = stById(game, p.stationId);
      if (!st) return 'inject (stale)';
      st.passengers.push(makePassenger(p.destShape, 0));
      return `inject(${st.id}->${p.destShape})`;
    }
    case 'locoDropPending': {
      const line = byId(game, p.lineId);
      if (!line || !line.pendingLoco || game.locomotives.available <= 0) return 'locoDropPending (stale)';
      game.beginVehicleDrag('loco');
      return `dropVehicle(loco->PENDING ${line.id}) -> ${game.dropVehicle({ line, stationIndex: 0 })}`;
    }
    case 'carriageDrop': {
      const line = byId(game, p.lineId);
      if (!line || !line.hasLocomotive || game.carriages.available <= 0) return 'carriageDrop (stale)';
      game.beginVehicleDrag('carriage');
      return `dropVehicle(carriage->${line.id}) -> ${game.dropVehicle({ line, stationIndex: 0 })}`;
    }
    case 'trainTransfer': {
      const src = byId(game, p.srcId);
      const dst = byId(game, p.dstId);
      if (!src || !dst || !src.hasLocomotive || !dst.isActive || dst.pendingLoco) return 'trainTransfer (stale)';
      game.beginVehicleDrag('train', src);
      return `trainTransfer(${src.id}->${dst.id}) -> ${game.dropVehicle({ line: dst, stationIndex: 0 })}`;
    }
    case 'lineDrag': {
      const line = byId(game, p.lineId);
      if (!line || !line.isActive) return 'lineDrag (stale)';
      const endStation = p.end === 0 ? line.stations[0] : line.stations[line.stations.length - 1];
      if (!endStation) return 'lineDrag (stale)';
      const ok = game.beginLineDrag(endStation, { lineId: line.id, stationId: endStation.id, end: p.end });
      if (!ok) return 'lineDrag (rejected)';
      const over = p.overId ? stById(game, p.overId) : null;
      if (over) game.dragOverStation(over);
      if (p.commit) game.endLineDrag(over);
      else game.cancelLineDrag();
      return `lineDrag(${line.id} terminus=${endStation.id} over=${p.overId} commit=${p.commit})`;
    }
    case 'update': {
      for (const dt of p.dts) {
        if (game.state === GameState.UPGRADE) {
          game.rewardOptions = [];
          game.state = GameState.PLAYING;
        }
        game.update(dt);
        if (game.state === GameState.GAMEOVER) break;
      }
      return `update x${p.dts.length}`;
    }
    case 'injectPassenger': {
      const st = stById(game, p.stationId);
      if (!st) return 'inject (stale)';
      const { makePassenger } = p._mp;
      st.passengers.push(makePassenger(p.destShape, 0));
      return `injectPassenger(${st.id}, ${p.destShape})`;
    }
    default:
      return `unknown ${p.op}`;
  }
}

// ---------------------------------------------------------------- checking

export function checkInvariants(game, census, step, log) {
  const out = [];
  const { missing } = census.scan(`step${step}`);
  if (missing.length) {
    out.push({
      key: 'VANISH',
      count: missing.length,
      detail: missing.map((p) => ({ dest: p.destShape, last: census.lastLoc.get(p) || 'never-seen-live' })),
      history: log.slice(-30),
    });
  }
  const inv = vehicleInvariants(game);
  if (inv.locoSum !== inv.locoTotal) out.push({ key: 'loco', detail: inv, history: log.slice(-30) });
  if (inv.carrSum !== inv.carrTotal) out.push({ key: 'carr', detail: inv, history: log.slice(-30) });
  for (const l of game.lines) {
    if (l.retiring && l.claimed) out.push({ key: 'retiring-but-claimed', detail: l.id, history: log.slice(-30) });
    if (l.retiring && l.stations.length) out.push({ key: 'retiring-but-has-track', detail: `${l.id} n=${l.stations.length}`, history: log.slice(-30) });
    if (l.pendingLoco && l.stations.length === 0) out.push({ key: 'pending-on-free-object', detail: l.id, history: log.slice(-30) });
    if (l.pendingFromLineId) {
      const src = game.lines.find((x) => x.id === l.pendingFromLineId);
      if (!src || !src.hasLocomotive) out.push({ key: 'stale-pending-booking', detail: `${l.id}<-${l.pendingFromLineId}`, history: log.slice(-30) });
    }
    for (const t of l.trains) {
      if (t.frozen) {
        if (!Number.isFinite(t.s)) out.push({ key: 'frozen-s-nan', detail: l.id, history: log.slice(-30) });
      } else if (l.isActive) {
        if (!Number.isFinite(t.s) || t.s < -1e-6 || t.s > l.path.total + 1e-6) {
          out.push({ key: 'train-s-out-of-range', detail: { id: t.id, s: t.s, total: l.path.total }, history: log.slice(-30) });
        }
        if (!(t.stopIndex >= 0 && t.stopIndex < l.stations.length)) {
          out.push({ key: 'stopIndex-out-of-range', detail: { id: t.id, stopIndex: t.stopIndex, n: l.stations.length }, history: log.slice(-30) });
        }
      }
      if (t.carriages < 0 || t.carriages > l.maxCarriages) {
        out.push({ key: 'carriage-count', detail: { id: t.id, carriages: t.carriages }, history: log.slice(-30) });
      }
    }
    const ids = l.stations.map((s) => s.id);
    if (new Set(ids).size !== ids.length) out.push({ key: 'duplicate-station', detail: l.id, history: log.slice(-30) });
  }
  return out;
}

/** Replay a recorded plan on a fresh game; return the first violation found. */
export function replay(seed, plans, { presets, stopOn } = {}) {
  const game = makeGame(seed, presets);
  const census = new Census(game);
  const log = [];
  for (let i = 0; i < plans.length; i++) {
    log.push(execOp(game, plans[i]));
    const v = checkInvariants(game, census, i, log);
    for (const item of v) {
      if (!stopOn || stopOn.includes(item.key)) return { step: i, violation: item, log: log.slice(), game };
    }
  }
  return { step: -1, violation: null, log, game };
}

// ---------------------------------------------------------------- driver

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const seeds = process.argv[2] ? [Number(process.argv[2])] : [...Array(40).keys()].map((i) => i + 1);
  const steps = Number(process.argv[3] || 700);
  let vanishSeeds = 0;
  let otherSeeds = 0;
  const kindCounts = new Map();
  const opCounts = new Map();
  for (const seed of seeds) {
    const game = makeGame(seed);
    const rng = new Rng((seed * 2654435761) % 2147483647);
    const census = new Census(game);
    const log = [];
    let found = null;
    const stateFindings = new Map();
    for (let step = 0; step < steps; step++) {
      const p = planOp(game, rng);
      opCounts.set(p.op, (opCounts.get(p.op) || 0) + 1);
      log.push(execOp(game, p));
      const v = checkInvariants(game, census, step, log);
      // State-level findings are recorded but do not stop the run: the damage
      // they cause (vehicle leaks, deleted passengers) shows up later.
      const fatal = v.filter((x) => FATAL.has(x.key));
      for (const x of v) if (!FATAL.has(x.key)) stateFindings.set(x.key, (stateFindings.get(x.key) || 0) + 1);
      if (fatal.length) {
        found = { step, v: fatal };
        break;
      }
    }
    for (const [k, n] of stateFindings) kindCounts.set(k, (kindCounts.get(k) || 0) + n);
    const t = census.totals();
    const kinds = found ? found.v.map((x) => x.key).join(',') : '-';
    if (found) for (const k of found.v.map((x) => x.key)) kindCounts.set(k, (kindCounts.get(k) || 0) + 1);
    const nonzero = t.delivered || t.onboard || t.waiting;
    console.log(`seed ${seed}: seen=${t.seen} waiting=${t.waiting} onboard=${t.onboard} delivered=${t.delivered} | first=${kinds}`);
    if (found && found.v.some((x) => x.key === 'VANISH')) {
      vanishSeeds++;
      const item = found.v.find((x) => x.key === 'VANISH');
      console.log('   VANISH detail:', JSON.stringify(item.detail));
      console.log('   tail:', item.history.slice(-14).join(' | '));
    } else if (found) {
      otherSeeds++;
      console.log('   ', JSON.stringify(found.v[0].detail), '|', found.v[0].history.slice(-8).join(' | '));
    }
  }
  console.log(`\nseeds with VANISH=${vanishSeeds}, other invariant breaks=${otherSeeds}`);
  console.log('invariant kinds seen:', JSON.stringify([...kindCounts.entries()]));
  console.log('ops fired:', JSON.stringify([...opCounts.entries()].sort((a, b) => b[1] - a[1])));
}
