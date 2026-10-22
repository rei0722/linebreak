// Tunable rules. Everything here must be plain integers so the simulation is
// bit-identical in every JS engine (V8 in Chrome, JSC in Safari/Bun, SpiderMonkey).

export const TICK_RATE = 60;
export const TICK_MS = 1000 / TICK_RATE;
export const BOARD_W = 10;
export const BOARD_H = 40;
/** Rows 0..19 are the hidden buffer zone, rows 20..39 are visible. */
export const VISIBLE_H = 20;
export const HIDDEN_H = BOARD_H - VISIBLE_H;
export const NEXT_COUNT = 5;

/** Fixed point: 65536 = one row per tick. Guideline curve (0.8-(L-1)*0.007)^(L-1) s/row. */
export const GRAVITY_FP = [
  0, 1092, 1377, 1768, 2311, 3075, 4169, 5759, 8107, 11634, 17026, 25416, 38709, 60169, 95483,
  154742, 256187, 433425, 749597, 1310720, 1310720,
];
export const MAX_LEVEL = GRAVITY_FP.length - 1;
export const FP_ONE = 65536;

export interface Handling {
  /** Delayed auto shift, ticks. */
  das: number;
  /** Auto repeat rate, ticks (0 = instant). */
  arr: number;
  /** Soft drop factor (41 = instant). */
  sdf: number;
}

export const DEFAULT_HANDLING: Handling = { das: 10, arr: 2, sdf: 20 };

export function clampHandling(h: Partial<Handling> | undefined): Handling {
  const n = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d;
  return {
    das: n(h?.das, 1, 20, DEFAULT_HANDLING.das),
    arr: n(h?.arr, 0, 5, DEFAULT_HANDLING.arr),
    sdf: n(h?.sdf, 5, 41, DEFAULT_HANDLING.sdf),
  };
}

export interface AttackTable {
  /** by lines cleared 0..4 */
  lines: number[];
  /** T-spin by lines 0..3 */
  tspin: number[];
  /** T-spin mini by lines 0..2 */
  mini: number[];
  b2bBonus: number;
  /** extra lines by combo count (index = combo, clamped to last entry) */
  combo: number[];
  perfectClear: number;
}

export interface Rules {
  lockDelay: number;
  maxLockResets: number;
  startLevel: number;
  linesPerLevel: number;
  /** In battle, gravity also rises every N ticks so matches always end. 0 = off. */
  levelUpTicks: number;
  /** Game finishes (cleared) once this many lines are cleared. 0 = endless. */
  goalLines: number;
  /** Max garbage rows inserted per lock. */
  garbageCap: number;
  attack: AttackTable;
}

export const DEFAULT_ATTACK: AttackTable = {
  lines: [0, 0, 1, 2, 4],
  tspin: [0, 2, 4, 6],
  mini: [0, 0, 1],
  b2bBonus: 1,
  combo: [0, 0, 1, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5],
  perfectClear: 10,
};

export const SOLO_RULES: Rules = {
  lockDelay: 30,
  maxLockResets: 15,
  startLevel: 1,
  linesPerLevel: 10,
  levelUpTicks: 0,
  goalLines: 150,
  garbageCap: 8,
  attack: DEFAULT_ATTACK,
};

export const BATTLE_RULES: Rules = {
  ...SOLO_RULES,
  levelUpTicks: 45 * TICK_RATE,
  goalLines: 0,
};
