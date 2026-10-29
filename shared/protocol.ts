// Wire protocol shared by client and server. JSON over a single WebSocket.

import type { GameState } from './engine/game';
import type { Handling } from './engine/rules';

export const PROTOCOL_VERSION = 1;
export const MAX_PLAYERS_DEFAULT = 8;
/** The room code alphabet skips look-alikes (0/O, 1/I/L). */
export const ROOM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const ROOM_ID_LENGTH = 6;
export const ROOM_ID_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_ID_LENGTH}}$`);
export const NAME_MAX = 16;

export type Targeting = 'random' | 'roundRobin';

export interface RoomSettings {
  /** Garbage attacks on/off. Survival without attacks is pure endurance. */
  attacks: boolean;
  targeting: Targeting;
  /** Multiplier applied to outgoing attack (in percent, 50..200). */
  attackPercent: number;
  maxPlayers: number;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  attacks: true,
  targeting: 'random',
  attackPercent: 100,
  maxPlayers: MAX_PLAYERS_DEFAULT,
};

export type Phase = 'lobby' | 'countdown' | 'playing';

/** A match pause lasts at most this long before it resumes on its own. */
export const PAUSE_LIMIT_MS = 60_000;
/** Play resumes this long after a resume begins, so nobody is caught mid-drop. */
export const RESUME_COUNTDOWN_MS = 3_000;

/** Shared pause state: while `resumeAt` is null the match clock is frozen at `at`. */
export interface PauseInfo {
  /** player who paused */
  by: string;
  /** their display name */
  name: string;
  /** Server epoch ms when the match clock froze. */
  at: number;
  /** Server epoch ms when play resumes, once a resume has begun. */
  resumeAt: number | null;
  /** Effective match start time; shifted forward when a resume begins. */
  startAt: number;
}

export interface PlayerView {
  id: string;
  name: string;
  host: boolean;
  ready: boolean;
  connected: boolean;
  /** Joined while a match was running: watches, plays next round. */
  spectator: boolean;
  wins: number;
}

export interface RoomView {
  id: string;
  phase: Phase;
  players: PlayerView[];
  settings: RoomSettings;
  /** Set during countdown/playing. */
  match: MatchInfo | null;
  /** Set while a match is paused (or counting down to resume). */
  pause: PauseInfo | null;
  lastResults: ResultRow[] | null;
}

export interface MatchInfo {
  id: number;
  seed: number;
  /** Server epoch ms when tick 0 begins. */
  startAt: number;
  participants: { id: string; name: string }[];
}

export interface ResultRow {
  id: string;
  name: string;
  place: number;
  score: number;
  lines: number;
  attack: number;
  /** Ticks survived. */
  survived: number;
  reason: 'winner' | 'topout' | 'disconnect' | 'left';
}

/** Compact spectator snapshot of one player's board. */
export interface BoardSnap {
  id: string;
  tick: number;
  /** 22 rows × 10 cols, digits 0..8, top row first. */
  b: string;
  /** Active piece [p, x, y(in snapshot rows), r] or null. */
  c: [number, number, number, number] | null;
  score: number;
  lines: number;
  level: number;
  pending: number;
  alive: boolean;
  place: number | null;
}

/** [tick, code, arg?] */
export type WireInput = [number, number] | [number, number, number];

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'NOT_HOST'
  | 'NOT_ENOUGH_PLAYERS'
  | 'NOT_READY'
  | 'KICKED'
  | 'VERSION';

// ------------------------------------------------------------- client → server

export type ClientMsg =
  | { t: 'create'; name: string; handling: Handling; v: number }
  | { t: 'join'; room: string; name: string; handling: Handling; token?: string; v: number }
  | { t: 'leave' }
  | { t: 'ready'; ready: boolean }
  | { t: 'name'; name: string }
  | { t: 'settings'; settings: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'pause' }
  | { t: 'resume' }
  | { t: 'kick'; id: string }
  | { t: 'ping'; c: number }
  | {
      t: 'in';
      /** match id */
      m: number;
      /** resync epoch the client is on */
      e: number;
      seq: number;
      /** client simulated up to this tick (exclusive of later input) */
      upto: number;
      ev: WireInput[];
      /** state hash at `upto` */
      h: number;
    };

// ------------------------------------------------------------- server → client

export type ServerMsg =
  | { t: 'welcome'; you: string; token: string; room: RoomView }
  | { t: 'room'; room: RoomView }
  | { t: 'pong'; c: number; s: number }
  | { t: 'error'; code: ErrorCode; msg: string }
  | { t: 'countdown'; match: MatchInfo }
  | {
      t: 'resync';
      m: number;
      e: number;
      /** last input seq the state includes */
      seq: number;
      state: GameState;
      /** garbage the server still waits for the client to acknowledge */
      unacked: { id: number; lines: number; hole: number }[];
    }
  | { t: 'garbage'; m: number; id: number; lines: number; hole: number; from: string }
  | { t: 'boards'; m: number; s: BoardSnap[] }
  | { t: 'attack'; m: number; from: string; to: string; lines: number }
  | { t: 'ko'; m: number; id: string; place: number; by: string | null }
  | { t: 'end'; m: number; results: ResultRow[] };
