// Client side of an online match: runs the local game against the shared
// server clock, batches inputs to the server, and accepts authoritative resyncs.

import { Game, Input, type GarbageChunk } from '../../../shared/engine/game';
import { BATTLE_RULES, TICK_MS, type Handling } from '../../../shared/engine/rules';
import type { ClientMsg, MatchInfo, PauseInfo, ServerMsg, WireInput } from '../../../shared/protocol';

export const SEND_INTERVAL_MS = 50;
/** Never simulate more than this many ticks in one update (keeps a frame bounded). */
const MAX_CATCHUP = 600;

export class MatchRunner {
  game: Game;
  epoch = 0;
  private seq = 0;
  private buffer: WireInput[] = [];
  private lastSend = 0;
  private stopped = false;
  /** Server epoch ms the shared clock is frozen at, while the match is paused. */
  private pauseFreezeAt: number | null = null;
  /** Server epoch ms play resumes, once a resume countdown has begun. */
  private resumeUntil: number | null = null;
  /** Called after a resync so the UI can drop transient effects. */
  onReset: (() => void) | null = null;

  constructor(
    readonly info: MatchInfo,
    readonly handling: Handling,
    private send: (msg: ClientMsg) => void,
    private serverNow: () => number,
    /** keys physically held right now, re-pressed after a resync */
    private heldInputs: () => number[] = () => [],
  ) {
    this.game = new Game({ seed: info.seed, rules: BATTLE_RULES, handling });
  }

  /** Current tick on the shared clock (negative during countdown). */
  clockTick(): number {
    const now =
      this.pauseFreezeAt !== null ? Math.min(this.serverNow(), this.pauseFreezeAt) : this.serverNow();
    return Math.floor((now - this.info.startAt) / TICK_MS);
  }

  /** True while the match is frozen or counting down to resume. */
  isPaused(): boolean {
    return this.pauseFreezeAt !== null || (this.resumeUntil !== null && this.serverNow() < this.resumeUntil);
  }

  /** Follow the room's shared pause state (drives the local clock). */
  syncPause(pause: PauseInfo | null) {
    if (!pause) {
      this.pauseFreezeAt = null;
      this.resumeUntil = null;
      return;
    }
    if (pause.resumeAt !== null) {
      if (this.resumeUntil !== pause.resumeAt) {
        // resume begun: adopt the shifted start time; the clock reaches the
        // frozen tick exactly when the countdown ends, so nothing jumps
        this.info.startAt = pause.startAt;
        this.resumeUntil = pause.resumeAt;
        this.pauseFreezeAt = null;
      }
    } else if (this.pauseFreezeAt !== pause.at) {
      this.pauseFreezeAt = pause.at;
      this.resumeUntil = null;
    }
  }

  get started() {
    return this.clockTick() >= 0;
  }

  private catchUp(): number {
    const t = Math.max(this.game.tick, this.clockTick());
    if (t > this.game.tick) this.game.advanceTo(Math.min(t, this.game.tick + MAX_CATCHUP));
    return this.game.tick;
  }

  input(code: number) {
    if (this.stopped || !this.started || this.game.over || this.isPaused()) return;
    const t = this.catchUp();
    this.game.input(code);
    this.buffer.push([t, code]);
    if (code === Input.HardDrop || code === Input.Hold) this.flush();
  }

  /** Call every frame (and from a background timer when the tab is hidden). */
  update(now = Date.now()) {
    if (this.stopped || !this.started) return;
    this.catchUp();
    // while frozen, keep pre-pause inputs buffered; they go out after the resume
    if (this.pauseFreezeAt !== null) return;
    if (this.resumeUntil !== null) {
      if (this.serverNow() < this.resumeUntil) return;
      this.resumeUntil = null; // countdown over: play (and sending) resumes below
    }
    if (now - this.lastSend >= SEND_INTERVAL_MS) this.flush(now);
  }

  flush(now = Date.now()) {
    if (this.stopped || !this.started) return;
    this.lastSend = now;
    this.send({
      t: 'in',
      m: this.info.id,
      e: this.epoch,
      seq: ++this.seq,
      upto: this.game.tick,
      ev: this.buffer,
      h: this.game.hash(),
    });
    this.buffer = [];
  }

  private ack(chunk: GarbageChunk) {
    const t = this.catchUp();
    this.game.receiveGarbage(chunk);
    this.buffer.push([t, Input.Garbage, chunk.id]);
  }

  handle(msg: ServerMsg) {
    if (this.stopped) return;
    if (msg.t === 'garbage' && msg.m === this.info.id) {
      this.ack({ id: msg.id, lines: msg.lines, hole: msg.hole });
    } else if (msg.t === 'resync' && msg.m === this.info.id) {
      this.game = new Game({ seed: this.info.seed, rules: BATTLE_RULES, handling: this.handling }, msg.state);
      this.epoch = msg.e;
      // a fresh runner (page reload) must continue the server's sequence, not restart at 0
      this.seq = msg.seq;
      this.buffer = [];
      for (const g of msg.unacked) this.ack(g);
      if (!this.game.over && this.started) {
        const t = this.catchUp();
        for (const code of this.heldInputs()) {
          this.game.input(code);
          this.buffer.push([t, code]);
        }
      }
      this.onReset?.();
      this.flush();
    }
  }

  stop() {
    if (!this.stopped && this.started) this.flush();
    this.stopped = true;
  }
}
