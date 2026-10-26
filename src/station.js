import { CONFIG } from './config.js';
import { isSpecialShape } from './shapes.js';

let fallbackId = 1;

export class Station {
  constructor(x, y, shape, id = null) {
    this.id = id ?? `S${fallbackId++}`;
    this.x = x;
    this.y = y;
    this.shape = shape;
    this.isInterchange = false;
    /** @type {import('./passenger.js').Passenger[]} */
    this.passengers = [];
    /** Seconds left before the station gives up; null when it is not overcrowded. */
    this.overcrowdTimer = null;
    this.spawnTimer = 0;
    /** Animation helpers for the renderer. */
    this.pulse = 0;
    this.flash = 0;
    this.delivered = 0;
  }

  get capacity() {
    return this.isInterchange ? CONFIG.station.interchangeCapacity : CONFIG.station.capacity;
  }

  /**
   * Drawn radius. While the map is still zoomed in, stations are shrunk so they
   * do not swamp the screen - but never so far that they stop being readable.
   */
  get radius() {
    return (this.isInterchange ? 17.5 : 14) * (this.radiusScale ?? 1);
  }

  get special() {
    return isSpecialShape(this.shape);
  }

  get isOvercrowded() {
    return this.passengers.length > this.capacity;
  }

  get hasExpired() {
    return this.overcrowdTimer !== null && this.overcrowdTimer <= 0;
  }

  /** 0..1 progress of the overcrowd countdown (1 = just started). */
  get overcrowdProgress() {
    if (this.overcrowdTimer === null) return 0;
    return Math.max(0, Math.min(1, this.overcrowdTimer / CONFIG.station.overcrowdSeconds));
  }

  update(dt) {
    if (this.pulse > 0) this.pulse = Math.max(0, this.pulse - dt);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt);
    if (this.isOvercrowded) {
      if (this.overcrowdTimer === null) this.overcrowdTimer = CONFIG.station.overcrowdSeconds;
      this.overcrowdTimer -= dt;
    } else {
      this.overcrowdTimer = null;
    }
  }

  /** Panic relief for endless mode: the platform empties. */
  clearPassengers() {
    const n = this.passengers.length;
    this.passengers = [];
    this.overcrowdTimer = null;
    this.flash = 0.8;
    return n;
  }

  upgradeToInterchange() {
    if (this.isInterchange) return false;
    this.isInterchange = true;
    this.pulse = 1.2;
    return true;
  }
}
