// GameSource implementations: local solo play, and the online match runner.

import { Game } from '../../../shared/engine/game';
import { SOLO_RULES, TICK_MS } from '../../../shared/engine/rules';
import type { MatchRunner } from '../net/matchRunner';
import type { Connection } from '../net/connection';
import { prefs } from '../prefs';
import type { GameSource } from './GameView';

const SOLO_COUNTDOWN_MS = 2000;
const MAX_CATCHUP = 600;

export class SoloSource implements GameSource {
  g!: Game;
  private startAt = 0;
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  constructor() {
    this.reset();
  }

  reset() {
    this.g = new Game({
      seed: (Math.random() * 0x7fffffff) | 0,
      rules: SOLO_RULES,
      handling: prefs.get().handling,
    });
    this.startAt = Date.now() + SOLO_COUNTDOWN_MS;
    this.pausedAt = null;
    this.pausedTotal = 0;
  }

  game() {
    return this.g;
  }

  private tickAt(now: number) {
    return Math.floor((now - this.startAt - this.pausedTotal) / TICK_MS);
  }

  frame(now: number) {
    if (this.pausedAt !== null || this.g.over) return;
    const t = this.tickAt(now);
    if (t > this.g.tick) this.g.advanceTo(Math.min(t, this.g.tick + MAX_CATCHUP));
  }

  input(code: number) {
    if (this.pausedAt !== null || this.g.over || this.countdownMs() > 0) return;
    this.frame(Date.now());
    this.g.input(code);
  }

  countdownMs() {
    const now = this.pausedAt ?? Date.now();
    return this.startAt + this.pausedTotal - now;
  }

  paused() {
    return this.pausedAt !== null;
  }

  pause() {
    if (this.pausedAt === null && !this.g.over) {
      this.g.releaseAll();
      this.pausedAt = Date.now();
    }
  }

  resume() {
    if (this.pausedAt === null) return;
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = null;
  }
}

export function onlineSource(runner: () => MatchRunner, conn: Connection): GameSource {
  return {
    game: () => runner().game,
    frame: (now) => runner().update(now),
    input: (code) => runner().input(code),
    countdownMs: () => runner().info.startAt - conn.serverNow(),
    paused: () => runner().isPaused(),
  };
}
