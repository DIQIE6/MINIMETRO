// Shared harness for adversarial verification. Never mutates src/.
import { Game, GameState } from '../src/game.js';

export { Game, GameState };

export const FRAME = 1 / 60;

/** Run frames; skips the weekly upgrade by simply not taking a reward, and
 *  returns early on game over. */
export function run(game, seconds, step = FRAME, guard = null) {
  const frames = Math.max(0, Math.round(seconds / step));
  for (let i = 0; i < frames; i++) {
    if (game.state === GameState.UPGRADE) {
      game.rewardOptions = [];
      game.state = GameState.PLAYING;
    }
    game.update(step);
    if (game.state === GameState.GAMEOVER) return i;
    if (guard && guard(i, game)) return i;
  }
  return frames;
}

export function runUntil(game, pred, maxSeconds = 200, step = FRAME) {
  const frames = Math.round(maxSeconds / step);
  for (let i = 0; i < frames; i++) {
    if (game.state === GameState.UPGRADE) {
      game.rewardOptions = [];
      game.state = GameState.PLAYING;
    }
    if (pred(game, i)) return i;
    game.update(step);
    if (game.state === GameState.GAMEOVER) return i;
  }
  return -1;
}

/**
 * Census: every passenger object is tracked from creation.
 * A passenger is "accounted" while it sits on a platform, rides a train, has
 * been delivered, or was deliberately cleared by an overcrowd incident.
 */
export class Census {
  constructor(game) {
    this.game = game;
    this.seen = new Set();
    this.delivered = new Set();
    this.cleared = new Set();
    this.lastLoc = new Map();
    this.events = [];
    const origDeliver = game.recordDelivery.bind(game);
    game.recordDelivery = (p, station) => {
      this.delivered.add(p);
      this.events.push(['delivered', p, station.id, game.time]);
      return origDeliver(p, station);
    };
    for (const st of game.stations) {
      const orig = st.clearPassengers.bind(st);
      st.clearPassengers = () => {
        for (const p of st.passengers) this.cleared.add(p);
        return orig();
      };
    }
  }

  watchNewStations() {
    for (const st of this.game.stations) {
      if (st.__wrapped) continue;
      st.__wrapped = true;
      const orig = st.clearPassengers.bind(st);
      st.clearPassengers = () => {
        for (const p of st.passengers) this.cleared.add(p);
        return orig();
      };
    }
  }

  live() {
    const live = new Set();
    for (const st of this.game.stations) for (const p of st.passengers) live.add(p);
    for (const l of this.game.lines) for (const t of l.trains) for (const p of t.passengers) live.add(p);
    return live;
  }

  scan(label) {
    this.watchNewStations();
    const live = this.live();
    for (const p of live) this.seen.add(p);
    for (const st of this.game.stations) for (const p of st.passengers) this.lastLoc.set(p, `st:${st.id}`);
    for (const l of this.game.lines) for (const t of l.trains) for (const p of t.passengers) this.lastLoc.set(p, `train:${t.id}`);
    const missing = [];
    for (const p of this.seen) {
      if (live.has(p)) continue;
      if (this.delivered.has(p)) continue;
      if (this.cleared.has(p)) continue;
      missing.push(p);
    }
    return { live, missing, label };
  }

  totals() {
    let waiting = 0;
    for (const st of this.game.stations) waiting += st.passengers.length;
    let onboard = 0;
    for (const l of this.game.lines) for (const t of l.trains) onboard += t.passengers.length;
    return { waiting, onboard, delivered: this.game.delivered, seen: this.seen.size };
  }
}

export function vehicleInvariants(game) {
  let locoOnLines = 0;
  for (const l of game.lines) locoOnLines += l.trains.length;
  let carrOnLines = 0;
  for (const l of game.lines) carrOnLines += l.carriages;
  return {
    locoTotal: game.locomotives.total,
    locoSum: game.locomotives.available + locoOnLines,
    locoAvailable: game.locomotives.available,
    locoOnLines,
    carrTotal: game.carriages.total,
    carrSum: game.carriages.available + carrOnLines,
    carrAvailable: game.carriages.available,
    carrOnLines,
  };
}

export function fmt(v) {
  return JSON.stringify(v);
}
