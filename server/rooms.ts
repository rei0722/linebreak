// Room lifecycle, membership, host rights and message routing.
// Transport-agnostic: index.ts adapts WebSocket connections to `Conn`.

import { randomBytes, randomInt } from 'node:crypto';
import { clampHandling, type Handling } from '../shared/engine/rules';
import {
  DEFAULT_SETTINGS,
  PROTOCOL_VERSION,
  ROOM_ALPHABET,
  ROOM_ID_LENGTH,
  ROOM_ID_RE,
  type ClientMsg,
  type ErrorCode,
  type Phase,
  type ResultRow,
  type RoomSettings,
  type RoomView,
  type ServerMsg,
} from '../shared/protocol';
import { Match, type MatchHost } from './match';
import { cleanName } from './schema';

export const COUNTDOWN_MS = 3500;
/** Lobby members who drop are kept this long so a page reload keeps their seat. */
export const SEAT_GRACE_MS = 30_000;
/** A disconnected host hands over after this long. */
export const HOST_GRACE_MS = 10_000;
export const HARD_MAX_PLAYERS = 16;

export interface Conn {
  readonly id: number;
  send(msg: ServerMsg): void;
  close(code: number, reason: string): void;
}

interface RoomPlayer {
  id: string;
  token: string;
  name: string;
  handling: Handling;
  conn: Conn | null;
  ready: boolean;
  spectator: boolean;
  wins: number;
  joinedAt: number;
  disconnectedAt: number | null;
}

const err = (code: ErrorCode, msg: string): ServerMsg => ({ t: 'error', code, msg });

export class Room implements MatchHost {
  readonly players = new Map<string, RoomPlayer>();
  hostId = '';
  phase: Phase = 'lobby';
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  match: Match | null = null;
  lastResults: ResultRow[] | null = null;
  private matchCounter = 0;

  constructor(
    readonly id: string,
    private now: () => number,
  ) {}

  // ---------------------------------------------------------- MatchHost

  send(playerId: string, msg: ServerMsg) {
    this.players.get(playerId)?.conn?.send(msg);
  }

  broadcast(msg: ServerMsg) {
    for (const p of this.players.values()) p.conn?.send(msg);
  }

  roomChanged() {
    this.broadcastRoom();
  }

  ended(results: ResultRow[]) {
    this.lastResults = results;
    const winner = results.find((r) => r.place === 1);
    if (winner) {
      const w = this.players.get(winner.id);
      if (w) w.wins++;
    }
    this.phase = 'lobby';
    this.match = null;
    for (const p of this.players.values()) {
      p.ready = false;
      p.spectator = false;
    }
    this.broadcastRoom();
  }

  // ---------------------------------------------------------- membership

  view(): RoomView {
    return {
      id: this.id,
      phase: this.phase,
      players: [...this.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          host: p.id === this.hostId,
          ready: p.ready,
          connected: p.conn !== null,
          spectator: p.spectator,
          wins: p.wins,
        })),
      settings: this.settings,
      match: this.match ? this.match.info : null,
      pause: this.match ? this.match.pauseInfo() : null,
      lastResults: this.lastResults,
    };
  }

  broadcastRoom() {
    this.broadcast({ t: 'room', room: this.view() });
  }

  get full() {
    return this.players.size >= this.settings.maxPlayers;
  }

  add(conn: Conn, name: string, handling: Handling): RoomPlayer {
    let id: string;
    do id = randomBytes(5).toString('hex');
    while (this.players.has(id));
    const p: RoomPlayer = {
      id,
      token: randomBytes(16).toString('hex'),
      name,
      handling,
      conn,
      ready: false,
      spectator: this.phase !== 'lobby',
      wins: 0,
      joinedAt: this.now() + this.players.size * 1e-3,
      disconnectedAt: null,
    };
    this.players.set(id, p);
    if (!this.hostId) this.hostId = id;
    return p;
  }

  remove(id: string) {
    const p = this.players.get(id);
    if (!p) return;
    this.players.delete(id);
    if (this.match?.isParticipant(id)) this.match.left(id, this.now());
    if (this.hostId === id) this.pickHost();
  }

  private pickHost() {
    const candidates = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const next = candidates.find((p) => p.conn) ?? candidates[0];
    this.hostId = next ? next.id : '';
  }

  welcome(p: RoomPlayer) {
    p.conn?.send({ t: 'welcome', you: p.id, token: p.token, room: this.view() });
    if (this.match && (this.phase === 'countdown' || this.phase === 'playing')) {
      p.conn?.send({ t: 'boards', m: this.match.info.id, s: this.match.allSnapshots() });
      if (this.match.isParticipant(p.id) && this.phase === 'playing') this.match.rejoin(p.id, this.now());
    }
  }

  // ---------------------------------------------------------- actions

  handle(p: RoomPlayer, msg: ClientMsg): ServerMsg | null {
    const isHost = p.id === this.hostId;
    switch (msg.t) {
      case 'ready':
        if (this.phase !== 'lobby') return null;
        p.ready = msg.ready;
        this.broadcastRoom();
        return null;
      case 'name':
        p.name = cleanName(msg.name);
        this.broadcastRoom();
        return null;
      case 'settings': {
        if (!isHost) return err('NOT_HOST', 'ルール変更はホストのみ可能です');
        if (this.phase !== 'lobby') return null;
        const s = msg.settings;
        const next = { ...this.settings };
        if (s.attacks !== undefined) next.attacks = s.attacks;
        if (s.targeting !== undefined) next.targeting = s.targeting;
        if (s.attackPercent !== undefined) next.attackPercent = Math.min(200, Math.max(50, s.attackPercent));
        if (s.maxPlayers !== undefined)
          next.maxPlayers = Math.min(HARD_MAX_PLAYERS, Math.max(2, this.players.size, s.maxPlayers));
        this.settings = next;
        this.broadcastRoom();
        return null;
      }
      case 'kick': {
        if (!isHost) return err('NOT_HOST', 'キックはホストのみ可能です');
        const target = this.players.get(msg.id);
        if (!target || target.id === p.id) return null;
        target.conn?.send(err('KICKED', 'ホストにより退出させられました'));
        this.remove(target.id);
        this.broadcastRoom();
        return null;
      }
      case 'start':
        return this.start(p);
      case 'pause':
        if (this.phase === 'playing' && this.match) this.match.requestPause(p.id, this.now());
        return null;
      case 'resume':
        if (this.phase === 'playing' && this.match) this.match.requestResume(p.id, this.now());
        return null;
      case 'in': {
        // the 50ms room ticker may not have flipped the phase yet when the first batch arrives
        const now = this.now();
        if (this.phase === 'countdown' && this.match && now >= this.match.info.startAt) {
          this.phase = 'playing';
          this.broadcastRoom();
        }
        if (this.phase === 'playing' && this.match) this.match.handleInput(p.id, msg, now);
        return null;
      }
      default:
        return null;
    }
  }

  private start(p: RoomPlayer): ServerMsg | null {
    if (p.id !== this.hostId) return err('NOT_HOST', '開始できるのはホストだけです');
    if (this.phase !== 'lobby') return null;
    const ready = [...this.players.values()].filter((x) => x.conn);
    if (ready.length < 2) return err('NOT_ENOUGH_PLAYERS', '開始には2人以上が必要です');
    const waiting = ready.filter((x) => x.id !== this.hostId && !x.ready);
    if (waiting.length) return err('NOT_READY', `${waiting.map((x) => x.name).join('、')} の準備ができていません`);

    const startAt = this.now() + COUNTDOWN_MS;
    this.matchCounter++;
    for (const x of this.players.values()) x.spectator = !x.conn;
    this.match = new Match(
      this.matchCounter,
      ready.sort((a, b) => a.joinedAt - b.joinedAt).map((x) => ({ id: x.id, name: x.name, handling: x.handling })),
      { ...this.settings },
      startAt,
      this,
    );
    this.phase = 'countdown';
    this.broadcast({ t: 'countdown', match: this.match.info });
    this.broadcastRoom();
    return null;
  }

  // ---------------------------------------------------------- connection state

  attach(p: RoomPlayer, conn: Conn) {
    if (p.conn && p.conn !== conn) p.conn.close(4000, 'replaced by a newer connection');
    p.conn = conn;
    p.disconnectedAt = null;
  }

  detach(p: RoomPlayer) {
    p.conn = null;
    p.disconnectedAt = this.now();
    if (this.match?.isParticipant(p.id)) this.match.disconnected(p.id, this.now());
    this.broadcastRoom();
  }

  /** Returns false when the room is empty and should be dropped. */
  update(now: number): boolean {
    if (this.phase === 'countdown' && this.match && now >= this.match.info.startAt) {
      this.phase = 'playing';
      this.broadcastRoom();
    }
    if (this.phase === 'playing') this.match?.update(now);

    let changed = false;
    for (const p of [...this.players.values()]) {
      if (p.conn || p.disconnectedAt === null) continue;
      const inMatch = this.phase !== 'lobby' && this.match?.isParticipant(p.id);
      if (!inMatch && now - p.disconnectedAt > SEAT_GRACE_MS) {
        this.remove(p.id);
        changed = true;
      }
    }
    const host = this.players.get(this.hostId);
    if (host && !host.conn && host.disconnectedAt !== null && now - host.disconnectedAt > HOST_GRACE_MS) {
      const before = this.hostId;
      this.pickHost();
      if (this.hostId !== before) changed = true;
    }
    if (changed) this.broadcastRoom();
    return this.players.size > 0;
  }
}

// ---------------------------------------------------------- manager

interface ConnState {
  room: Room | null;
  player: string | null;
  tokens: number;
  last: number;
  dropped: number;
}

const BUCKET_RATE = 60; // msgs per second
const BUCKET_BURST = 120;
const MAX_DROPPED = 300;

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private conns = new Map<number, ConnState>();

  constructor(private now: () => number = Date.now) {}

  newRoomId(): string {
    for (;;) {
      let id = '';
      for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
      if (!this.rooms.has(id)) return id;
    }
  }

  connect(conn: Conn) {
    this.conns.set(conn.id, { room: null, player: null, tokens: BUCKET_BURST, last: this.now(), dropped: 0 });
  }

  disconnect(conn: Conn) {
    const st = this.conns.get(conn.id);
    this.conns.delete(conn.id);
    if (!st?.room || !st.player) return;
    const p = st.room.players.get(st.player);
    if (p && p.conn === conn) st.room.detach(p);
  }

  /** Token bucket. Returns false if the message must be dropped. */
  private allow(st: ConnState, conn: Conn): boolean {
    const now = this.now();
    st.tokens = Math.min(BUCKET_BURST, st.tokens + ((now - st.last) / 1000) * BUCKET_RATE);
    st.last = now;
    if (st.tokens >= 1) {
      st.tokens--;
      return true;
    }
    if (++st.dropped > MAX_DROPPED) conn.close(4008, 'rate limit');
    else if (st.dropped % 50 === 1) conn.send(err('RATE_LIMITED', '送信が多すぎます'));
    return false;
  }

  handle(conn: Conn, msg: ClientMsg | null) {
    const st = this.conns.get(conn.id);
    if (!st) return;
    if (!this.allow(st, conn)) return;
    if (!msg) {
      conn.send(err('BAD_REQUEST', '不正なメッセージです'));
      return;
    }
    if (msg.t === 'ping') {
      conn.send({ t: 'pong', c: msg.c, s: this.now() });
      return;
    }
    if (msg.t === 'create' || msg.t === 'join') {
      if (msg.v !== PROTOCOL_VERSION) {
        conn.send(err('VERSION', 'ページを再読み込みしてください（バージョン不一致）'));
        return;
      }
      this.leaveCurrent(st);
      const name = cleanName(msg.name);
      const handling = clampHandling(msg.handling);
      let room: Room | undefined;
      if (msg.t === 'create') {
        room = new Room(this.newRoomId(), this.now);
        this.rooms.set(room.id, room);
      } else {
        const id = msg.room.toUpperCase();
        room = ROOM_ID_RE.test(id) ? this.rooms.get(id) : undefined;
        if (!room) {
          conn.send(err('ROOM_NOT_FOUND', 'この部屋は存在しないか、すでに閉じられています'));
          return;
        }
      }
      let p = msg.t === 'join' && msg.token ? [...room.players.values()].find((x) => x.token === msg.token) : undefined;
      if (p) {
        room.attach(p, conn);
        p.handling = handling;
      } else {
        if (room.full) {
          conn.send(err('ROOM_FULL', `満員です（最大${room.settings.maxPlayers}人）`));
          return;
        }
        p = room.add(conn, name, handling);
      }
      st.room = room;
      st.player = p.id;
      room.welcome(p);
      room.broadcastRoom();
      return;
    }

    const room = st.room;
    const p = room && st.player ? room.players.get(st.player) : undefined;
    if (!room || !p || p.conn !== conn) {
      conn.send(err('ROOM_NOT_FOUND', '部屋に参加していません'));
      return;
    }
    if (msg.t === 'leave') {
      this.leaveCurrent(st);
      return;
    }
    const reply = room.handle(p, msg);
    if (reply) conn.send(reply);
  }

  private leaveCurrent(st: ConnState) {
    if (st.room && st.player) {
      const room = st.room;
      room.remove(st.player);
      if (room.players.size === 0) this.rooms.delete(room.id);
      else room.broadcastRoom();
    }
    st.room = null;
    st.player = null;
  }

  update() {
    const now = this.now();
    for (const [id, room] of this.rooms) {
      if (!room.update(now)) this.rooms.delete(id);
    }
  }

  stats() {
    let players = 0;
    for (const r of this.rooms.values()) players += r.players.size;
    return { rooms: this.rooms.size, players, connections: this.conns.size };
  }
}
