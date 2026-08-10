/**
 * Seeded PRNG used by Style 2 tools so a fixed `seed` reproduces
 * an identical scene roll across process restarts. Math.random()
 * would break every regression test the moment the harness runs
 * on a new machine.
 *
 * mulberry32 is uniform enough for this — we only ever call it to
 * pick an integer index from a small array. Do not use it for
 * anything security-sensitive.
 */

export interface Rng {
  next(): number;
  /** Uniform integer in [0, n). Throws if n <= 0. */
  int(n: number): number;
  /** Pick one element from a non-empty array. Throws on empty. */
  pick<T>(items: readonly T[]): T;
}

/** Create a PRNG from a numeric seed. */
export function makeRng(seed: number): Rng {
  // mulberry32 — 32-bit state, single-multiply step.
  let state = (seed >>> 0) || 0x9e3779b9;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int(n: number): number {
      if (n <= 0) throw new Error(`Rng.int(n) requires n > 0 (got ${n})`);
      return Math.floor(next() * n);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) throw new Error("Rng.pick called on empty array");
      const idx = Math.floor(next() * items.length);
      // Defensive: index is in-range by construction, but noUncheckedIndexedAccess
      // still surfaces T | undefined without the assertion.
      return items[idx] as T;
    },
  };
}

/**
 * When the caller doesn't pass a seed we still want the roll to
 * be logged with a stable identifier — return a randomly-generated
 * one that's fed straight back into makeRng.
 */
export function randomSeed(): number {
  return (Math.random() * 0xffff_ffff) >>> 0;
}
