// One room membership: connection, room state, current match runner, and
// spectator snapshots. React subscribes via `useSession`; boards are pushed to
// canvases imperatively through `onBoards`.

import { useSyncExternalStore } from 'react';
import type { KeyboardController } from '../game/input';
import { prefs, seat } from '../prefs';
import {
  PROTOCOL_VERSION,
  type BoardSnap,
  type ErrorCode,
  type ResultRow,
  type RoomView,
  type ServerMsg,
} from '../../../shared/protocol';
import { Connection, type ConnStatus } from './connection';
import { MatchRunner } from './matchRunner';

export function serverBase(): string {
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  return (env && env.replace(/\/$/, '')) || location.origin;
}

export function wsUrl(): string {
  return serverBase().replace(/^http/, 'ws') + '/ws';
}

/** Public URL for invites. Same origin as the app unless VITE_PUBLIC_URL is set. */
export function inviteUrl(roomId: string): string {
  const base = ((import.meta.env.VITE_PUBLIC_URL as string | undefined) || location.origin).replace(/\/$/, '');
  return `${base}/room/${roomId}`;
}

export type SessionEvent =
  | { k: 'ko'; id: string; place: number; by: string | null }
  | { k: 'attack'; from: string; to: string; lines: number }
  | { k: 'end'; results: ResultRow[] };

export interface SessionState {
  status: ConnStatus;
  room: RoomView | null;
  you: string;
  error: { code: ErrorCode; msg: string } | null;
  /** fatal for this page: room missing, full, kicked */
  fatal: boolean;
  runner: MatchRunner | null;
  results: ResultRow[] | null;
  /** place if you were knocked out this match */
  myPlace: number | null;
}

const FATAL: ErrorCode[] = ['ROOM_NOT_FOUND', 'ROOM_FULL', 'KICKED', 'VERSION'];

export class RoomSession {
  readonly conn: Connection;
  state: SessionState;
  readonly boards = new Map<string, BoardSnap>();
  private listeners = new Set<() => void>();
  private boardListeners = new Set<(s: BoardSnap[]) => void>();
  private eventListeners = new Set<(e: SessionEvent) => void>();
  private roomId: string | null;
  keyboard: KeyboardController | null = null;

  constructor(
    roomId: string | null,
    private onRoomId: (id: string) => void,
  ) {
    this.roomId = roomId;
    this.conn = new Connection(wsUrl());
    this.state = {
      status: this.conn.status,
      room: null,
      you: '',
      error: null,
      fatal: false,
      runner: null,
      results: null,
      myPlace: null,
    };
    this.conn.onStatus((status) => this.patch({ status }));
    this.conn.onOpen(() => this.hello());
    this.conn.on((m) => this.onMessage(m));
  }

  private hello() {
    const p = prefs.get();
    const name = p.name || 'プレイヤー';
    if (this.roomId) {
      this.conn.send({
        t: 'join',
        room: this.roomId,
        name,
        handling: p.handling,
        token: seat.get(this.roomId),
        v: PROTOCOL_VERSION,
      });
    } else {
      this.conn.send({ t: 'create', name, handling: p.handling, v: PROTOCOL_VERSION });
    }
  }

  private patch(p: Partial<SessionState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  private startRunner(info: NonNullable<RoomView['match']>) {
    if (this.state.runner?.info.id === info.id) return;
    if (!info.participants.some((p) => p.id === this.state.you)) return;
    this.state.runner?.stop();
    const runner = new MatchRunner(
      info,
      prefs.get().handling,
      (msg) => this.conn.send(msg),
      () => this.conn.serverNow(),
      () => this.keyboard?.heldInputs() ?? [],
    );
    this.boards.clear();
    this.patch({ runner, results: null, myPlace: null });
  }

  private onMessage(m: ServerMsg) {
    this.state.runner?.handle(m);
    switch (m.t) {
      case 'welcome': {
        seat.set(m.room.id, m.token);
        if (this.roomId !== m.room.id) {
          this.roomId = m.room.id;
          this.onRoomId(m.room.id);
        }
        this.patch({ you: m.you, room: m.room, error: null, fatal: false });
        // rejoining a running match: the server follows up with a resync for this runner
        if (m.room.match && m.room.phase !== 'lobby') this.startRunner(m.room.match);
        this.state.runner?.syncPause(m.room.pause);
        break;
      }
      case 'room':
        this.patch({ room: m.room });
        if (m.room.match && m.room.phase !== 'lobby') this.startRunner(m.room.match);
        this.state.runner?.syncPause(m.room.pause);
        break;
      case 'countdown':
        this.startRunner(m.match);
        break;
      case 'boards':
        for (const s of m.s) this.boards.set(s.id, s);
        for (const l of this.boardListeners) l(m.s);
        break;
      case 'ko':
        if (m.id === this.state.you) this.patch({ myPlace: m.place });
        this.emit({ k: 'ko', id: m.id, place: m.place, by: m.by });
        break;
      case 'attack':
        this.emit({ k: 'attack', from: m.from, to: m.to, lines: m.lines });
        break;
      case 'end':
        this.state.runner?.stop();
        this.patch({ results: m.results });
        this.emit({ k: 'end', results: m.results });
        break;
      case 'error': {
        const fatal = FATAL.includes(m.code) && (!this.state.room || m.code === 'KICKED');
        if (m.code === 'ROOM_NOT_FOUND' && this.roomId) seat.clear(this.roomId);
        if (m.code === 'KICKED' && this.roomId) seat.clear(this.roomId);
        this.patch({ error: { code: m.code, msg: m.msg }, fatal });
        if (fatal) this.conn.close();
        break;
      }
    }
  }

  private emit(e: SessionEvent) {
    for (const l of this.eventListeners) l(e);
  }

  // ---------------------------------------------------------- actions

  setReady(ready: boolean) {
    this.conn.send({ t: 'ready', ready });
  }
  setName(name: string) {
    this.conn.send({ t: 'name', name });
  }
  start() {
    this.conn.send({ t: 'start' });
  }
  pause() {
    this.conn.send({ t: 'pause' });
  }
  resume() {
    this.conn.send({ t: 'resume' });
  }
  kick(id: string) {
    this.conn.send({ t: 'kick', id });
  }
  updateSettings(settings: Partial<RoomView['settings']>) {
    this.conn.send({ t: 'settings', settings });
  }
  clearError() {
    this.patch({ error: null });
  }
  dismissResults() {
    this.patch({ results: null, runner: null, myPlace: null });
  }
  leave() {
    this.conn.send({ t: 'leave' });
    if (this.roomId) seat.clear(this.roomId);
    this.dispose();
  }
  dispose() {
    this.state.runner?.stop();
    this.conn.close();
    this.listeners.clear();
    this.boardListeners.clear();
    this.eventListeners.clear();
  }

  // ---------------------------------------------------------- subscriptions

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  onBoards(l: (s: BoardSnap[]) => void) {
    this.boardListeners.add(l);
    return () => void this.boardListeners.delete(l);
  }
  onEvent(l: (e: SessionEvent) => void) {
    this.eventListeners.add(l);
    return () => void this.eventListeners.delete(l);
  }
}

export function useSession(s: RoomSession): SessionState {
  return useSyncExternalStore(s.subscribe, () => s.state);
}
