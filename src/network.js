import { CONFIG } from './config.js';

/**
 * Routing helper.
 *
 * Passengers are not omniscient, but they are not stupid either: given a
 * station and a desired shape they pick the line that gets them closest, and
 * they are willing to change lines once. The result is cached per network
 * generation, which is invalidated whenever a line is edited.
 */
export class Network {
  constructor() {
    this.gen = 0;
    /** @type {Map<string, import('./line.js').Line[]>} */
    this.linesAt = new Map();
    this.cache = new Map();
  }

  rebuild(game) {
    this.gen++;
    if (game) game.invalidateGeometry();
    this.cache.clear();
    this.linesAt.clear();
    for (const line of game.liveLines()) {
      for (const st of line.stations) {
        let arr = this.linesAt.get(st.id);
        if (!arr) {
          arr = [];
          this.linesAt.set(st.id, arr);
        }
        if (!arr.includes(line)) arr.push(line);
      }
    }
  }

  linesAtStation(stationId) {
    return this.linesAt.get(stationId) || [];
  }

  /**
   * @returns {{lineId:string,targetStationId:string,cost:number,transfer:boolean}|null}
   */
  plan(game, station, destShape, excludeLineId = null) {
    if (station.shape === destShape) {
      return { lineId: null, targetStationId: station.id, cost: 0, transfer: false, done: true };
    }
    const key = `${station.id}|${destShape}|${excludeLineId || '-'}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const result = this.computePlan(station, destShape, excludeLineId);
    this.cache.set(key, result);
    return result;
  }

  computePlan(station, destShape, excludeLineId) {
    const linesHere = this.linesAtStation(station.id);
    let best = null;

    const consider = (skipExcluded) => {
      for (const line of linesHere) {
        if (skipExcluded && line.id === excludeLineId) continue;
        const from = line.indexOfStation(station.id);
        if (from < 0) continue;
        const n = line.stations.length;
        for (let i = 0; i < n; i++) {
          if (i === from) continue;
          const T = line.stations[i];
          const hops = line.hopsBetween(from, i);
          let cost = hops + 1;
          let transfer = false;
          if (T.shape !== destShape) {
            let reachable = false;
            for (const other of this.linesAtStation(T.id)) {
              if (other.id === line.id) continue;
              if (other.stations.some((s) => s.shape === destShape)) {
                reachable = true;
                break;
              }
            }
            if (!reachable) continue;
            cost += CONFIG.lines.transferPenalty;
            transfer = true;
          }
          if (!best || cost < best.cost) {
            best = { lineId: line.id, targetStationId: T.id, cost, transfer, hops };
          }
        }
      }
    };

    consider(true);
    if (!best && excludeLineId) consider(false);
    return best;
  }
}
