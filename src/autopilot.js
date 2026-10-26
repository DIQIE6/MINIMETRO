import { GameState } from './game.js';
import { CONFIG } from './config.js';
import { dist } from './geometry.js';

/**
 * A small greedy "player" used by `?demo=1` and by the animated menu
 * background. It is deliberately simple: connect what is not connected, close
 * loops when the two ends come close, then spend carriages and interchanges on
 * whatever is busiest.
 */
export class Autopilot {
  constructor(game, options = {}) {
    this.game = game;
    this.interval = options.interval ?? 3.2;
    this.timer = 1.2;
    this.reach = options.reach ?? 560;
  }

  update(dt) {
    const game = this.game;
    if (game.state === GameState.UPGRADE) {
      this.chooseReward();
      return;
    }
    if (game.state !== GameState.PLAYING) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.interval;
    this.step();
  }

  chooseReward() {
    const game = this.game;
    const kinds = game.rewardOptions.map((o) => o.kind);
    if (!kinds.length) return;
    const unconnected = this.unconnectedStations().length;
    // Take a new line slot when every slot is already in use, or when stations
    // are stranded; otherwise spend the reward on track and rolling stock.
    const wantLine =
      game.unlockedLines < CONFIG.lines.maxSlots &&
      (game.lineSlotsAvailable() === 0 || unconnected > 1 || game.activeLines().length < game.unlockedLines);
    const preference = [wantLine ? 'line' : null, 'tunnel', 'carriage', 'locomotive', 'interchange'].filter(Boolean);
    const pick = preference.find((k) => kinds.includes(k)) || kinds[0];
    game.chooseReward(pick);
  }

  unconnectedStations() {
    // A line with no locomotive carries nobody, so its stations still count
    // as unserved.
    const lines = this.game.liveLines();
    return this.game.stations.filter((s) => !lines.some((l) => l.hasStation(s.id)));
  }

  step() {
    const game = this.game;
    const lines = game.activeLines();
    const unconnected = this.unconnectedStations();

    // 1. Kick off the very first line between the two closest stations.
    if (!lines.length && game.lineSlotsAvailable() > 0 && game.stations.length >= 2) {
      let best = null;
      for (let i = 0; i < game.stations.length; i++) {
        for (let j = i + 1; j < game.stations.length; j++) {
          const d = dist(game.stations[i].x, game.stations[i].y, game.stations[j].x, game.stations[j].y);
          if (!best || d < best.d) best = { d, a: game.stations[i], b: game.stations[j] };
        }
      }
      if (best) {
        const line = game.startLine(best.a);
        if (line) game.extendLine(line, 1, best.b);
      }
      return;
    }

    // 2. Close a loop when the two ends of a long line are near each other.
    for (const line of lines) {
      if (line.isLoop || line.stations.length < 4) continue;
      const head = line.stations[0];
      const tail = line.stations[line.stations.length - 1];
      if (dist(head.x, head.y, tail.x, tail.y) < 240) {
        if (game.extendLine(line, 1, head)) return;
      }
    }

    // 3. Spend carriages on the line that needs them most.
    if (game.carriages.available > 0 && this.busiestLine()) {
      if (game.placeCarriage(this.busiestLine())) return;
    }

    // 3b. Any line that has no locomotive yet gets one from the pool.
    const idle = this.game.lines.find((l) => l.isActive && !l.hasLocomotive && !l.retiring);
    if (idle && game.locomotives.available > 0) {
      if (game.deployLocomotive(idle, 0)) return;
    }

    // 4. Open another line once the existing ones have grown long, or when
    //    stations are stranded - but only if a locomotive is free to run it.
    const canOpen =
      game.lineSlotsAvailable() > 0 && game.stations.length >= 4 && game.locomotives.available > 0;
    const linesAreLong = lines.some((l) => l.stations.length >= 5);
    if (canOpen && (unconnected.length > 0 || linesAreLong)) {
      const seedStation = unconnected.length ? unconnected[0] : this.stressedStation();
      if (seedStation) {
        const line = game.startLine(seedStation);
        if (line) {
          const next = this.nearestStation(seedStation, (s) => s.id !== seedStation.id && !line.hasStation(s.id));
          if (next) game.extendLine(line, 1, next);
          return;
        }
      }
    }

    // 5. Reach out to the nearest unconnected station. The reach grows with
    //    the map so that early sprawl stays connected.
    const reach = this.reach + Math.min(700, game.time * 3.5);
    if (unconnected.length) {
      let best = null;
      for (const station of unconnected) {
        for (const line of lines) {
          for (const end of [0, 1]) {
            const anchor = end === 0 ? line.stations[0] : line.stations[line.stations.length - 1];
            const d = dist(station.x, station.y, anchor.x, anchor.y);
            if (d > reach) continue;
            if (!best || d < best.d) best = { d, station, line, end };
          }
        }
      }
      if (best && game.extendLine(best.line, best.end, best.station)) return;
    }

    if (game.inventory.interchanges > 0) {
      const worst = this.stressedStation();
      if (worst && game.placeInterchange(worst)) return;
    }
  }

  /** The station that most needs help right now. */
  stressedStation() {
    const lines = this.game.activeLines();
    let best = null;
    let bestScore = -Infinity;
    for (const station of this.game.stations) {
      const served = lines.filter((l) => l.hasStation(station.id)).length;
      if (served > 1) continue;
      const score = station.passengers.length * 2 - served * 3;
      if (score > bestScore) {
        bestScore = score;
        best = station;
      }
    }
    return best;
  }

  nearestStation(from, predicate) {
    let best = null;
    let bestD = Infinity;
    for (const station of this.game.stations) {
      if (!predicate(station)) continue;
      const d = dist(from.x, from.y, station.x, station.y);
      if (d < bestD) {
        bestD = d;
        best = station;
      }
    }
    return best;
  }

  busiestLine() {
    const lines = this.game.activeLines();
    if (!lines.length) return null;
    return lines
      .slice()
      .sort(
        (a, b) =>
          b.stations.length + b.trains.reduce((n, t) => n + t.passengers.length, 0) * 2 -
          (a.stations.length + a.trains.reduce((n, t) => n + t.passengers.length, 0) * 2),
      )[0];
  }
}
