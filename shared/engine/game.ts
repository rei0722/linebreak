// Deterministic, tick-based block puzzle simulation.
// The same code runs in the browser (instant local feedback) and on the server
// (authoritative replay of the player's input log). Only integer math is used.

import { BOX_SIZE, GARBAGE, SHAPES, kicks } from './pieces';
import {
  BOARD_H,
  BOARD_W,
  FP_ONE,
  GRAVITY_FP,
  HIDDEN_H,
  MAX_LEVEL,
  NEXT_COUNT,
  type Handling,
  type Rules,
} from './rules';

/** Input codes. Kept numeric so the wire format stays tiny. */
export const Input = {
  LeftDown: 0,
  LeftUp: 1,
  RightDown: 2,
  RightUp: 3,
  SoftDown: 4,
  SoftUp: 5,
  RotateCW: 6,
  RotateCCW: 7,
  HardDrop: 8,
  Hold: 9,
  /** Garbage acknowledgement: arg = garbage id. Applied via receiveGarbage. */
  Garbage: 10,
} as const;
export type InputCode = (typeof Input)[keyof typeof Input];
export const MAX_INPUT_CODE = 10;

export interface ActivePiece {
  p: number;
  x: number;
  y: number;
  r: number;
}

export interface GarbageChunk {
  id: number;
  lines: number;
  hole: number;
}

export type SpinKind = 'none' | 'mini' | 'full';

export type GameEvent =
  | { k: 'move' }
  | { k: 'rotate' }
  | { k: 'hold' }
  | { k: 'lock'; hard: boolean; dist: number }
  | {
      k: 'clear';
      rows: number[];
      lines: number;
      spin: SpinKind;
      b2b: boolean;
      combo: number;
      pc: boolean;
      attack: number;
      sent: number;
    }
  | { k: 'garbageIn'; lines: number }
  | { k: 'level'; level: number }
  | { k: 'over'; reason: 'topout' | 'finish' };

export type OverState = false | 'topout' | 'finish';

export interface GameConfig {
  seed: number;
  rules: Rules;
  handling: Handling;
}

/** Everything that changes during play. Serializable for resync / reconnect. */
export interface GameState {
  tick: number;
  board: string;
  rng: number;
  queue: number[];
  cur: ActivePiece | null;
  hold: number;
  holdUsed: boolean;
  gravAcc: number;
  lockTimer: number;
  lockResets: number;
  lowestY: number;
  lastRotate: boolean;
  lastKick: number;
  left: boolean;
  right: boolean;
  soft: boolean;
  dir: number;
  dasTimer: number;
  arrTimer: number;
  score: number;
  lines: number;
  level: number;
  combo: number;
  b2b: number;
  pieces: number;
  attackSent: number;
  garbageIn: number;
  pending: GarbageChunk[];
  over: OverState;
}

const SPAWN_Y = HIDDEN_H - 2;

function nextRandom(s: number): [number, number] {
  // mulberry32
  const state = (s + 0x6d2b79f5) | 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [state, (t ^ (t >>> 14)) >>> 0];
}

export class Game {
  readonly rules: Rules;
  readonly handling: Handling;
  board = new Uint8Array(BOARD_W * BOARD_H);
  tick = 0;
  rng: number;
  queue: number[] = [];
  cur: ActivePiece | null = null;
  hold = 0;
  holdUsed = false;
  gravAcc = 0;
  lockTimer = 0;
  lockResets = 0;
  lowestY = 0;
  lastRotate = false;
  lastKick = 0;
  left = false;
  right = false;
  soft = false;
  dir = 0;
  dasTimer = 0;
  arrTimer = 0;
  score = 0;
  lines = 0;
  level = 1;
  combo = -1;
  b2b = -1;
  pieces = 0;
  attackSent = 0;
  garbageIn = 0;
  pending: GarbageChunk[] = [];
  over: OverState = false;
  /** Drained by the consumer (renderer/audio on the client, match logic on the server). */
  events: GameEvent[] = [];

  constructor(cfg: GameConfig, state?: GameState) {
    this.rules = cfg.rules;
    this.handling = cfg.handling;
    this.rng = cfg.seed | 0;
    if (state) {
      this.load(state);
    } else {
      this.level = this.computeLevel();
      this.fillQueue();
      this.spawn(this.queue.shift()!);
    }
  }

  // ---------------------------------------------------------------- queue

  private fillQueue() {
    while (this.queue.length < NEXT_COUNT + 2) {
      const bag = [1, 2, 3, 4, 5, 6, 7];
      for (let i = bag.length - 1; i > 0; i--) {
        const [s, r] = nextRandom(this.rng);
        this.rng = s;
        const j = r % (i + 1);
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
      this.queue.push(...bag);
    }
  }

  get next(): number[] {
    return this.queue.slice(0, NEXT_COUNT);
  }

  // ---------------------------------------------------------------- geometry

  cell(x: number, y: number): number {
    return this.board[y * BOARD_W + x];
  }

  fits(p: number, x: number, y: number, r: number): boolean {
    for (const [cx, cy] of SHAPES[p][r]) {
      const bx = x + cx;
      const by = y + cy;
      if (bx < 0 || bx >= BOARD_W || by < 0 || by >= BOARD_H) return false;
      if (this.board[by * BOARD_W + bx] !== 0) return false;
    }
    return true;
  }

  private onGround(): boolean {
    const c = this.cur!;
    return !this.fits(c.p, c.x, c.y + 1, c.r);
  }

  dropDistance(): number {
    const c = this.cur;
    if (!c) return 0;
    let d = 0;
    while (this.fits(c.p, c.x, c.y + d + 1, c.r)) d++;
    return d;
  }

  // ---------------------------------------------------------------- spawning

  private spawn(p: number) {
    const x = p === 2 ? 4 : 3;
    let y = SPAWN_Y;
    if (!this.fits(p, x, y, 0)) {
      this.cur = { p, x, y, r: 0 };
      this.end('topout');
      return;
    }
    // Guideline: drop one row immediately when the path is clear.
    if (this.fits(p, x, y + 1, 0)) y++;
    this.cur = { p, x, y, r: 0 };
    this.fillQueue();
    this.gravAcc = 0;
    this.lockTimer = 0;
    this.lockResets = 0;
    this.lowestY = y;
    this.lastRotate = false;
    this.lastKick = 0;
  }

  private end(reason: 'topout' | 'finish') {
    if (this.over) return;
    this.over = reason;
    this.left = this.right = this.soft = false;
    this.dir = 0;
    this.events.push({ k: 'over', reason });
  }

  // ---------------------------------------------------------------- movement

  private afterManipulate(wasGrounded: boolean) {
    const c = this.cur!;
    if (c.y > this.lowestY) {
      this.lowestY = c.y;
      this.lockResets = 0;
    }
    if ((wasGrounded || this.onGround()) && this.lockResets < this.rules.maxLockResets) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  private shift(dx: number): boolean {
    const c = this.cur;
    if (!c || !this.fits(c.p, c.x + dx, c.y, c.r)) return false;
    const grounded = this.onGround();
    c.x += dx;
    this.lastRotate = false;
    this.afterManipulate(grounded);
    this.events.push({ k: 'move' });
    return true;
  }

  private slide(dx: number) {
    while (this.shift(dx));
  }

  private rotate(dir: 1 | -1) {
    const c = this.cur;
    if (!c) return;
    const to = (c.r + dir + 4) & 3;
    const tests = kicks(c.p, c.r, to);
    const grounded = this.onGround();
    for (let i = 0; i < tests.length; i++) {
      const [kx, ky] = tests[i];
      if (this.fits(c.p, c.x + kx, c.y + ky, to)) {
        c.x += kx;
        c.y += ky;
        c.r = to;
        this.lastRotate = true;
        this.lastKick = i;
        this.afterManipulate(grounded);
        this.events.push({ k: 'rotate' });
        return;
      }
    }
  }

  private doHold() {
    const c = this.cur;
    if (!c || this.holdUsed) return;
    const prev = this.hold;
    this.hold = c.p;
    this.holdUsed = true;
    this.events.push({ k: 'hold' });
    this.spawn(prev || this.queue.shift()!);
  }

  private hardDrop() {
    const c = this.cur;
    if (!c) return;
    const d = this.dropDistance();
    c.y += d;
    if (d > 0) this.lastRotate = false;
    this.score += d * 2;
    this.lock(true, d);
  }

  // ---------------------------------------------------------------- input

  input(code: number) {
    if (this.over) return;
    switch (code) {
      case Input.LeftDown:
        this.left = true;
        this.dir = -1;
        this.dasTimer = 0;
        this.arrTimer = 0;
        this.shift(-1);
        break;
      case Input.LeftUp:
        this.left = false;
        if (this.dir === -1) this.releaseDir(this.right ? 1 : 0);
        break;
      case Input.RightDown:
        this.right = true;
        this.dir = 1;
        this.dasTimer = 0;
        this.arrTimer = 0;
        this.shift(1);
        break;
      case Input.RightUp:
        this.right = false;
        if (this.dir === 1) this.releaseDir(this.left ? -1 : 0);
        break;
      case Input.SoftDown:
        this.soft = true;
        break;
      case Input.SoftUp:
        this.soft = false;
        break;
      case Input.RotateCW:
        this.rotate(1);
        break;
      case Input.RotateCCW:
        this.rotate(-1);
        break;
      case Input.HardDrop:
        this.hardDrop();
        break;
      case Input.Hold:
        this.doHold();
        break;
    }
  }

  private releaseDir(fallback: number) {
    this.dir = fallback;
    this.dasTimer = 0;
    this.arrTimer = 0;
  }

  /** Drop all held keys (focus lost, resync). */
  releaseAll() {
    this.left = this.right = this.soft = false;
    this.dir = 0;
    this.dasTimer = 0;
    this.arrTimer = 0;
  }

  receiveGarbage(chunk: GarbageChunk) {
    if (this.over) return;
    const lines = Math.max(0, Math.min(20, chunk.lines | 0));
    if (lines === 0) return;
    this.pending.push({ id: chunk.id, lines, hole: Math.max(0, Math.min(BOARD_W - 1, chunk.hole | 0)) });
  }

  get pendingLines(): number {
    let n = 0;
    for (const g of this.pending) n += g.lines;
    return n;
  }

  // ---------------------------------------------------------------- simulation

  private computeLevel(): number {
    const r = this.rules;
    let lvl = r.startLevel + Math.floor(this.lines / r.linesPerLevel);
    if (r.levelUpTicks > 0) lvl = Math.max(lvl, 1 + Math.floor(this.tick / r.levelUpTicks));
    return Math.min(MAX_LEVEL, lvl);
  }

  step() {
    this.tick++;
    if (this.over || !this.cur) return;

    const lvl = this.computeLevel();
    if (lvl !== this.level) {
      this.level = lvl;
      this.events.push({ k: 'level', level: lvl });
    }

    // Auto shift
    if (this.dir !== 0) {
      const { das, arr } = this.handling;
      if (this.dasTimer < das) {
        this.dasTimer++;
        if (this.dasTimer === das) {
          if (arr === 0) this.slide(this.dir);
          else {
            this.shift(this.dir);
            this.arrTimer = 0;
          }
        }
      } else if (arr === 0) {
        this.slide(this.dir);
      } else if (++this.arrTimer >= arr) {
        this.arrTimer = 0;
        this.shift(this.dir);
      }
    }

    // Gravity
    const c = this.cur;
    let g = GRAVITY_FP[this.level];
    if (this.soft) {
      g = this.handling.sdf >= 41 ? 40 * FP_ONE : Math.max(g * this.handling.sdf, FP_ONE / 3 | 0);
    }
    this.gravAcc += Math.min(g, 40 * FP_ONE);
    while (this.gravAcc >= FP_ONE) {
      if (this.fits(c.p, c.x, c.y + 1, c.r)) {
        c.y++;
        this.gravAcc -= FP_ONE;
        this.lastRotate = false;
        if (this.soft) this.score += 1;
        if (c.y > this.lowestY) {
          this.lowestY = c.y;
          this.lockResets = 0;
        }
      } else {
        this.gravAcc = 0;
        break;
      }
    }

    // Lock delay
    if (this.onGround()) {
      this.lockTimer++;
      if (this.lockTimer >= this.rules.lockDelay) this.lock(false, 0);
    } else if (this.lockResets < this.rules.maxLockResets) {
      // Once resets are used up the timer only pauses in the air, so kicking
      // upward repeatedly cannot stall the piece forever.
      this.lockTimer = 0;
    }
  }

  /** Advance until `this.tick === target`. */
  advanceTo(target: number) {
    while (this.tick < target) this.step();
  }

  private detectSpin(): SpinKind {
    const c = this.cur!;
    if (c.p !== 3 || !this.lastRotate) return 'none';
    const filled = (dx: number, dy: number) => {
      const x = c.x + dx;
      const y = c.y + dy;
      return x < 0 || x >= BOARD_W || y >= BOARD_H || (y >= 0 && this.board[y * BOARD_W + x] !== 0);
    };
    const corners = [filled(0, 0), filled(2, 0), filled(2, 2), filled(0, 2)]; // TL TR BR BL
    const count = corners.filter(Boolean).length;
    if (count < 3) return 'none';
    // Front corners per rotation (the side the T points to).
    const front = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ][c.r];
    if ((corners[front[0]] && corners[front[1]]) || this.lastKick === 4) return 'full';
    return 'mini';
  }

  private lock(hard: boolean, dist: number) {
    const c = this.cur!;
    const spin = this.detectSpin();
    let allHidden = true;
    for (const [cx, cy] of SHAPES[c.p][c.r]) {
      const y = c.y + cy;
      this.board[y * BOARD_W + c.x + cx] = c.p;
      if (y >= HIDDEN_H) allHidden = false;
    }
    this.pieces++;
    this.events.push({ k: 'lock', hard, dist });
    this.cur = null;

    // Line clears
    const rows: number[] = [];
    for (let y = 0; y < BOARD_H; y++) {
      let full = true;
      for (let x = 0; x < BOARD_W; x++) {
        if (this.board[y * BOARD_W + x] === 0) {
          full = false;
          break;
        }
      }
      if (full) rows.push(y);
    }
    if (rows.length) {
      const next = new Uint8Array(BOARD_W * BOARD_H);
      let dst = BOARD_H - 1;
      for (let y = BOARD_H - 1; y >= 0; y--) {
        if (rows.includes(y)) continue;
        next.set(this.board.subarray(y * BOARD_W, (y + 1) * BOARD_W), dst * BOARD_W);
        dst--;
      }
      this.board = next;
    }

    const n = rows.length;
    const lvl = this.level;
    const a = this.rules.attack;
    let attack = 0;
    let b2bApplied = false;
    let pc = false;

    let base = 0;
    if (spin === 'full') base = [400, 800, 1200, 1600][n];
    else if (spin === 'mini') base = [100, 200, 400, 400][n];
    else base = [0, 100, 300, 500, 800][n];

    if (n > 0) {
      this.combo++;
      const difficult = n === 4 || spin !== 'none';
      if (difficult) {
        if (this.b2b >= 0) {
          b2bApplied = true;
          base = Math.floor((base * 3) / 2);
        }
        this.b2b++;
      } else {
        this.b2b = -1;
      }
      attack =
        spin === 'full' ? a.tspin[Math.min(n, 3)] : spin === 'mini' ? a.mini[Math.min(n, 2)] : a.lines[n];
      if (b2bApplied) attack += a.b2bBonus;
      attack += a.combo[Math.min(this.combo, a.combo.length - 1)];
      pc = this.board.every((v) => v === 0);
      if (pc) {
        attack += a.perfectClear;
        this.score += [0, 800, 1200, 1800, 2000][n] * lvl;
      }
      this.score += 50 * this.combo * lvl;
    } else {
      this.combo = -1;
    }
    this.score += base * lvl;

    // Offset incoming garbage first, send the rest.
    let sent = attack;
    while (sent > 0 && this.pending.length) {
      const g = this.pending[0];
      const used = Math.min(g.lines, sent);
      g.lines -= used;
      sent -= used;
      if (g.lines === 0) this.pending.shift();
    }
    this.attackSent += sent;

    if (n > 0 || spin !== 'none') {
      this.events.push({ k: 'clear', rows, lines: n, spin, b2b: b2bApplied, combo: this.combo, pc, attack, sent });
    }

    if (n === 0 && this.pending.length) this.insertGarbage();

    this.lines += n;
    this.holdUsed = false;
    if (allHidden && n === 0) {
      this.end('topout');
      return;
    }
    if (this.over) return;
    const lvlNow = this.computeLevel();
    if (lvlNow !== this.level) {
      this.level = lvlNow;
      this.events.push({ k: 'level', level: lvlNow });
    }
    if (this.rules.goalLines > 0 && this.lines >= this.rules.goalLines) {
      this.end('finish');
      return;
    }
    this.spawn(this.queue.shift()!);
  }

  private insertGarbage() {
    let budget = this.rules.garbageCap;
    let total = 0;
    while (budget > 0 && this.pending.length) {
      const g = this.pending[0];
      const take = Math.min(budget, g.lines);
      for (let i = 0; i < take; i++) {
        // anything in the top row gets pushed out of the matrix
        for (let x = 0; x < BOARD_W; x++) if (this.board[x] !== 0) this.end('topout');
        this.board.copyWithin(0, BOARD_W);
        const base = (BOARD_H - 1) * BOARD_W;
        for (let x = 0; x < BOARD_W; x++) this.board[base + x] = x === g.hole ? 0 : GARBAGE;
      }
      g.lines -= take;
      budget -= take;
      total += take;
      if (g.lines === 0) this.pending.shift();
    }
    this.garbageIn += total;
    this.events.push({ k: 'garbageIn', lines: total });
  }

  // ---------------------------------------------------------------- state

  save(): GameState {
    let board = '';
    for (let i = 0; i < this.board.length; i++) board += this.board[i];
    return {
      tick: this.tick,
      board,
      rng: this.rng,
      queue: [...this.queue],
      cur: this.cur ? { ...this.cur } : null,
      hold: this.hold,
      holdUsed: this.holdUsed,
      gravAcc: this.gravAcc,
      lockTimer: this.lockTimer,
      lockResets: this.lockResets,
      lowestY: this.lowestY,
      lastRotate: this.lastRotate,
      lastKick: this.lastKick,
      left: this.left,
      right: this.right,
      soft: this.soft,
      dir: this.dir,
      dasTimer: this.dasTimer,
      arrTimer: this.arrTimer,
      score: this.score,
      lines: this.lines,
      level: this.level,
      combo: this.combo,
      b2b: this.b2b,
      pieces: this.pieces,
      attackSent: this.attackSent,
      garbageIn: this.garbageIn,
      pending: this.pending.map((g) => ({ ...g })),
      over: this.over,
    };
  }

  private load(s: GameState) {
    const { board, queue, cur, pending, ...rest } = s;
    Object.assign(this, rest);
    this.board = new Uint8Array(BOARD_W * BOARD_H);
    for (let i = 0; i < this.board.length; i++) this.board[i] = board.charCodeAt(i) - 48;
    this.queue = [...queue];
    this.cur = cur ? { ...cur } : null;
    this.pending = pending.map((g) => ({ ...g }));
  }

  /** 32-bit FNV-1a over the gameplay-relevant state, used to detect desync. */
  hash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (v >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193);
    };
    for (let i = 0; i < this.board.length; i++) {
      h ^= this.board[i];
      h = Math.imul(h, 0x01000193);
    }
    const c = this.cur;
    mix(c ? c.p * 1000000 + (c.x + 10) * 10000 + (c.y + 10) * 10 + c.r : -1);
    mix(this.tick);
    mix(this.score % 0x7fffffff);
    mix(this.lines);
    mix(this.hold * 2 + (this.holdUsed ? 1 : 0));
    mix(this.combo + 1);
    mix(this.b2b + 1);
    mix(this.pendingLines);
    mix(this.lockTimer);
    mix(this.gravAcc);
    for (let i = 0; i < NEXT_COUNT; i++) mix(this.queue[i]);
    return h >>> 0;
  }

  /** Visible rows (top..bottom) as a compact string for spectator views. */
  visibleBoard(): string {
    let s = '';
    for (let i = HIDDEN_H * BOARD_W - 2 * BOARD_W; i < this.board.length; i++) s += this.board[i];
    return s;
  }
}

/** Number of rows included in Game.visibleBoard (20 visible + 2 buffer rows). */
export const SPECTATOR_ROWS = 22;
export { BOX_SIZE };
