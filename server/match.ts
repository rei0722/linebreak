// Authoritative match: re-simulates every player's input log with the shared
// engine. Scores, eliminations, attacks and placements come only from here.

import { Game, Input, MAX_INPUT_CODE, SPECTATOR_ROWS, type GarbageChunk } from '../shared/engine/game';
import { BATTLE_RULES, HIDDEN_H, TICK_MS, type Handling, type Rules } from '../shared/engine/rules';
import type { BoardSnap, ClientMsg, MatchInfo, ResultRow, RoomSettings, ServerMsg } from '../shared/protocol';

/** Client may run at most this far ahead of the server clock (clock skew allowance). */
export const AHEAD_TOLERANCE = 30;
/** If a client falls this far behind, the server advances its game itself and resyncs. */
export const MAX_LAG = 180;
/** Ticks a client has to acknowledge incoming garbage before the server forces it in. */
export const GARBAGE_GRACE = 150;
/** Disconnected players are knocked out after this long. */
export const DISCONNECT_FORFEIT_MS = 20_000;
export const MAX_EVENTS_PER_BATCH = 128;
const SNAPSHOT_INTERVAL_MS = 100;
const RESYNC_MIN_INTERVAL_MS = 400;

type InputMsg = Extract<ClientMsg, { t: 'in' }>;

interface SentGarbage {
  chunk: GarbageChunk;
  /** server tick at send time */
  tick: number;
  from: string;
}

interface MatchPlayer {
  id: string;
  name: string;
  game: Game;
  seq: number;
  epoch: number;
  alive: boolean;
  place: number | null;
  reason: ResultRow['reason'];
  diedTick: number;
  /** garbage sent to this player that its client has not acknowledged yet */
  unacked: Map<number, SentGarbage>;
  nextGarbageId: number;
  lastAttacker: string | null;
  disconnectedAt: number | null;
  dirty: boolean;
  lastResyncAt: number;
  violations: number;
}

export interface MatchHost {
  send(playerId: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  ended(results: ResultRow[]): void;
}

export class Match {
  readonly info: MatchInfo;
  readonly rules: Rules = BATTLE_RULES;
  readonly players = new Map<string, MatchPlayer>();
  private alive: number;
  private rng: number;
  private rr = 0;
  private lastSnapshotAt = 0;
  finished = false;

  constructor(
    id: number,
    participants: { id: string; name: string; handling: Handling }[],
    readonly settings: RoomSettings,
    startAt: number,
    private host: MatchHost,
    seed = (Math.random() * 0x7fffffff) | 0,
  ) {
    this.rng = seed ^ 0x5bd1e995;
    this.info = { id, seed, startAt, participants: participants.map(({ id, name }) => ({ id, name })) };
    for (const p of participants) {
      this.players.set(p.id, {
        id: p.id,
        name: p.name,
        game: new Game({ seed, rules: this.rules, handling: p.handling }),
        seq: 0,
        epoch: 0,
        alive: true,
        place: null,
        reason: 'winner',
        diedTick: 0,
        unacked: new Map(),
        nextGarbageId: 1,
        lastAttacker: null,
        disconnectedAt: null,
        dirty: true,
        lastResyncAt: 0,
        violations: 0,
      });
    }
    this.alive = participants.length;
  }

  serverTick(now: number): number {
    return Math.floor((now - this.info.startAt) / TICK_MS);
  }

  private random(n: number): number {
    // xorshift32, server-only so float math is fine but keep it simple
    let x = this.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x;
    return (x >>> 0) % n;
  }

  // ------------------------------------------------------------ input

  handleInput(pid: string, msg: InputMsg, now: number) {
    const p = this.players.get(pid);
    if (!p || !p.alive || this.finished) return;
    if (msg.m !== this.info.id || msg.e !== p.epoch) return; // stale match or pre-resync batch
    if (msg.seq <= p.seq) return; // duplicate / replayed

    const g = p.game;
    const st = this.serverTick(now);
    const problem = this.validate(p, msg, st);
    if (problem) {
      if (process.env.LB_DEBUG) console.log("[violation]", pid, problem, msg.upto, g.tick, st);
      p.violations++;
      p.seq = msg.seq;
      this.resync(p, now, true);
      return;
    }

    for (const [tick, code, arg] of msg.ev) {
      this.advance(p, tick, now);
      if (!p.alive) return;
      if (code === Input.Garbage) {
        const sent = p.unacked.get(arg!);
        if (sent) {
          p.unacked.delete(arg!);
          g.receiveGarbage(sent.chunk);
        }
      } else {
        g.input(code);
      }
      this.drain(p, now);
      if (!p.alive || this.finished) return;
    }
    this.advance(p, msg.upto, now);
    if (!p.alive || this.finished) return;
    p.seq = msg.seq;
    p.dirty = true;
    if (g.hash() !== (msg.h >>> 0)) {
      if (process.env.LB_DEBUG) console.log("[desync]", pid, g.tick, JSON.stringify(g.cur), g.pieces);
      this.resync(p, now, true);
    }
  }

  private validate(p: MatchPlayer, msg: InputMsg, st: number): string | null {
    const g = p.game;
    if (msg.upto < g.tick) return 'upto behind';
    if (msg.upto > st + AHEAD_TOLERANCE) return 'upto ahead of server clock';
    if (msg.ev.length > MAX_EVENTS_PER_BATCH) return 'too many events';
    let last = g.tick;
    const acked = new Set<number>();
    for (const e of msg.ev) {
      const [tick, code, arg] = e;
      if (tick < last || tick > msg.upto) return 'event tick out of order';
      if (code < 0 || code > MAX_INPUT_CODE) return 'bad input code';
      if (code === Input.Garbage) {
        if (arg === undefined || !p.unacked.has(arg) || acked.has(arg)) return 'unknown garbage ack';
        acked.add(arg);
      }
      last = tick;
    }
    return null;
  }

  /** Step a player's game to `target`, forcing in garbage whose ack deadline has passed. */
  private advance(p: MatchPlayer, target: number, now: number) {
    const g = p.game;
    while (g.tick < target && p.alive) {
      let deadline = Infinity;
      let due: SentGarbage | null = null;
      for (const s of p.unacked.values()) {
        const d = s.tick + GARBAGE_GRACE;
        if (d < deadline) {
          deadline = d;
          due = s;
        }
      }
      if (due && deadline <= target) {
        g.advanceTo(Math.max(g.tick, deadline));
        p.unacked.delete(due.chunk.id);
        g.receiveGarbage(due.chunk);
        this.drain(p, now);
        // client ignored garbage: its timeline is now wrong, resync it
        this.resync(p, now, true);
        continue;
      }
      g.advanceTo(target);
      this.drain(p, now);
    }
  }

  private drain(p: MatchPlayer, now: number) {
    const events = p.game.events;
    if (!events.length) return;
    p.game.events = [];
    for (const ev of events) {
      if (ev.k === 'clear' && ev.sent > 0) this.attack(p, ev.sent, now);
      else if (ev.k === 'over') this.eliminate(p, 'topout', now);
      if (this.finished) return;
    }
  }

  // ------------------------------------------------------------ attacks

  private attack(from: MatchPlayer, lines: number, now: number) {
    if (!this.settings.attacks || !from.alive) return;
    const amount = Math.floor((lines * this.settings.attackPercent) / 100);
    if (amount <= 0) return;
    const targets = [...this.players.values()].filter((t) => t.alive && t.id !== from.id);
    if (!targets.length) return;
    const target =
      this.settings.targeting === 'roundRobin'
        ? targets[this.rr++ % targets.length]
        : targets[this.random(targets.length)];
    const chunk: GarbageChunk = { id: target.nextGarbageId++, lines: amount, hole: this.random(10) };
    target.unacked.set(chunk.id, { chunk, tick: this.serverTick(now), from: from.id });
    target.lastAttacker = from.id;
    this.host.send(target.id, { t: 'garbage', m: this.info.id, ...chunk, from: from.id });
    this.host.broadcast({ t: 'attack', m: this.info.id, from: from.id, to: target.id, lines: amount });
  }

  // ------------------------------------------------------------ lifecycle

  private eliminate(p: MatchPlayer, reason: ResultRow['reason'], now: number) {
    if (!p.alive || this.finished) return;
    p.alive = false;
    p.place = this.alive;
    p.reason = reason;
    p.diedTick = Math.min(p.game.tick, this.serverTick(now));
    p.dirty = true;
    this.alive--;
    this.host.broadcast({ t: 'ko', m: this.info.id, id: p.id, place: p.place, by: p.lastAttacker });
    if (this.alive <= 1) this.finish(now);
  }

  private finish(now: number) {
    if (this.finished) return;
    this.finished = true;
    for (const p of this.players.values()) {
      if (p.alive) {
        p.alive = false;
        p.place = 1;
        p.reason = 'winner';
        p.diedTick = Math.min(p.game.tick, this.serverTick(now));
      }
    }
    this.flushSnapshots(now, true);
    const results: ResultRow[] = [...this.players.values()]
      .map((p) => ({
        id: p.id,
        name: p.name,
        place: p.place!,
        score: p.game.score,
        lines: p.game.lines,
        attack: p.game.attackSent,
        survived: Math.max(0, p.diedTick),
        reason: p.reason,
      }))
      .sort((a, b) => a.place - b.place);
    this.host.broadcast({ t: 'end', m: this.info.id, results });
    this.host.ended(results);
  }

  private resync(p: MatchPlayer, now: number, force = false) {
    if (!force && now - p.lastResyncAt < RESYNC_MIN_INTERVAL_MS) return;
    p.epoch++;
    p.lastResyncAt = now;
    p.dirty = true;
    this.host.send(p.id, {
      t: 'resync',
      m: this.info.id,
      e: p.epoch,
      seq: p.seq,
      state: p.game.save(),
      unacked: [...p.unacked.values()].map((s) => s.chunk),
    });
  }

  /** Full state for a (re)connecting participant. */
  rejoin(pid: string, now: number) {
    const p = this.players.get(pid);
    if (!p) return;
    p.disconnectedAt = null;
    p.game.releaseAll();
    this.resync(p, now, true);
  }

  disconnected(pid: string, now: number) {
    const p = this.players.get(pid);
    if (p && p.alive) p.disconnectedAt = now;
  }

  left(pid: string, now: number) {
    const p = this.players.get(pid);
    if (p) this.eliminate(p, 'left', now);
  }

  isParticipant(pid: string) {
    return this.players.has(pid);
  }

  /** Called periodically (~20Hz). */
  update(now: number) {
    if (this.finished) return;
    const st = this.serverTick(now);
    if (st < 0) return;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.disconnectedAt !== null && now - p.disconnectedAt > DISCONNECT_FORFEIT_MS) {
        this.eliminate(p, 'disconnect', now);
        if (this.finished) return;
        continue;
      }
      if (st - p.game.tick > MAX_LAG) {
        // client stalled (hidden tab, frozen, or cheating by not reporting): time keeps going
        p.game.releaseAll();
        this.advance(p, st - MAX_LAG / 2, now);
        if (this.finished) return;
        p.dirty = true;
        if (p.disconnectedAt === null) this.resync(p, now);
      }
    }
    if (now - this.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) this.flushSnapshots(now);
  }

  snapshot(p: MatchPlayer): BoardSnap {
    const g = p.game;
    const c = g.cur && p.alive ? g.cur : null;
    const top = HIDDEN_H - (SPECTATOR_ROWS - 20);
    return {
      id: p.id,
      tick: g.tick,
      b: g.visibleBoard(),
      c: c ? [c.p, c.x, c.y - top, c.r] : null,
      score: g.score,
      lines: g.lines,
      level: g.level,
      pending: g.pendingLines + [...p.unacked.values()].reduce((n, s) => n + s.chunk.lines, 0),
      alive: p.alive,
      place: p.place,
    };
  }

  private flushSnapshots(now: number, all = false) {
    this.lastSnapshotAt = now;
    const s: BoardSnap[] = [];
    for (const p of this.players.values()) {
      if (all || p.dirty) {
        p.dirty = false;
        s.push(this.snapshot(p));
      }
    }
    if (s.length) this.host.broadcast({ t: 'boards', m: this.info.id, s });
  }

  allSnapshots(): BoardSnap[] {
    return [...this.players.values()].map((p) => this.snapshot(p));
  }
}
