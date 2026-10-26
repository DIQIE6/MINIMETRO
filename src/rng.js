/**
 * Small deterministic PRNG (mulberry32) so a run can be replayed from a seed.
 */
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
    this.state = this.seed;
  }

  /** float in [0, 1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** float in [min, max) */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** integer in [min, max] */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  pick(arr) {
    if (!arr.length) return undefined;
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Pick one entry of `entries` ([{weight, ...}]) proportionally to weight. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += Math.max(0, e.weight || 0);
    if (total <= 0) return entries.length ? entries[0] : undefined;
    let r = this.next() * total;
    for (const e of entries) {
      r -= Math.max(0, e.weight || 0);
      if (r <= 0) return e;
    }
    return entries[entries.length - 1];
  }

  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Gaussian-ish value in [-1, 1], clustered near 0. */
  bell() {
    return (this.next() + this.next() + this.next()) / 1.5 - 1;
  }
}
