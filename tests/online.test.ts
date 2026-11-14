// End-to-end protocol tests: a real server on a random port and bot clients
// that use the same Connection / MatchRunner code as the browser.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startServer } from '../server/index';
import { Connection } from '../client/src/net/connection';
import { MatchRunner } from '../client/src/net/matchRunner';
import { Input } from '../shared/engine/game';
import { DEFAULT_HANDLING } from '../shared/engine/rules';
import { PROTOCOL_VERSION, ROOM_ID_RE, type RoomView, type ServerMsg, type ResultRow } from '../shared/protocol';

let app: Awaited<ReturnType<typeof startServer>>;
let url = '';

beforeAll(async () => {
  app = await startServer({ port: 0, host: '127.0.0.1', staticDir: '/nonexistent' });
  url = `ws://127.0.0.1:${app.port}/ws`;
});
afterAll(async () => {
  await app.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  conn: Connection;
  msgs: ServerMsg[] = [];
  room: RoomView | null = null;
  you = '';
  token = '';
  runner: MatchRunner | null = null;
  results: ResultRow[] | null = null;
  kos: { id: string; place: number }[] = [];
  resyncs = 0;
  garbage = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    readonly name: string,
    /** how aggressively to play: ms between hard drops */
    public pace = 30,
  ) {
    this.conn = new Connection(url);
    this.conn.on((m) => this.onMsg(m));
  }

  async ready() {
    await waitFor(() => this.conn.status === 'open');
    await sleep(30); // first pong for clock offset
  }

  onMsg(m: ServerMsg) {
    this.msgs.push(m);
    if (m.t === 'welcome') {
      this.you = m.you;
      this.token = m.token;
      this.room = m.room;
    } else if (m.t === 'room') this.room = m.room;
    else if (m.t === 'countdown') this.startMatch(m.match);
    else if (m.t === 'ko') this.kos.push({ id: m.id, place: m.place });
    else if (m.t === 'end') {
      this.results = m.results;
      this.stopPlaying();
    } else if (m.t === 'resync') this.resyncs++;
    else if (m.t === 'garbage') this.garbage++;
    if (this.runner) this.runner.handle(m);
    // reconnect during a match: pick the runner back up from the room view
    if (m.t === 'welcome' && m.room.match && m.room.match.participants.some((p) => p.id === this.you)) {
      this.startMatch(m.room.match);
    }
    if (this.room) this.runner?.syncPause(this.room.pause);
  }

  startMatch(info: NonNullable<RoomView['match']>) {
    if (this.runner?.info.id === info.id) return;
    this.runner = new MatchRunner(info, DEFAULT_HANDLING, (msg) => this.conn.send(msg), () => this.conn.serverNow());
    let last = Date.now();
    this.timer = setInterval(() => {
      const r = this.runner!;
      r.update();
      const now = Date.now();
      if (r.started && now - last > this.pace) {
        last = now;
        const k = Math.floor(Math.random() * 4);
        if (k === 0) r.input(Input.RotateCW);
        if (k === 1) {
          r.input(Input.LeftDown);
          r.input(Input.LeftUp);
        }
        if (k === 2) {
          r.input(Input.RightDown);
          r.input(Input.RightUp);
        }
        r.input(Input.HardDrop);
      }
    }, 10);
  }

  stopPlaying() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runner?.stop();
  }

  last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i] as any;
  }

  create() {
    this.conn.send({ t: 'create', name: this.name, handling: DEFAULT_HANDLING, v: PROTOCOL_VERSION });
  }

  join(room: string, token?: string) {
    this.conn.send({ t: 'join', room, name: this.name, handling: DEFAULT_HANDLING, token, v: PROTOCOL_VERSION });
  }

  close() {
    this.stopPlaying();
    this.conn.close();
  }
}

async function waitFor(cond: () => boolean, ms = 5000) {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout waiting for condition');
    await sleep(10);
  }
}

async function makeRoom(n: number, pace = 30) {
  const bots = Array.from({ length: n }, (_, i) => new Bot(`bot${i + 1}`, pace));
  await Promise.all(bots.map((b) => b.ready()));
  bots[0].create();
  await waitFor(() => !!bots[0].room);
  const id = bots[0].room!.id;
  for (const b of bots.slice(1)) b.join(id);
  await waitFor(() => bots.every((b) => b.room?.players.length === n));
  return { bots, id };
}

describe('rooms', () => {
  test('create issues a 6-char room code and joining by code shows everyone', async () => {
    const { bots, id } = await makeRoom(4);
    expect(id).toMatch(ROOM_ID_RE);
    expect(bots[3].room!.players.map((p) => p.name)).toEqual(['bot1', 'bot2', 'bot3', 'bot4']);
    expect(bots[1].room!.players[0].host).toBe(true);
    const res = await fetch(`http://127.0.0.1:${app.port}/api/rooms/${id}`).then((r) => r.json());
    expect(res).toMatchObject({ exists: true, players: 4, maxPlayers: 8 });
    bots.forEach((b) => b.close());
  });

  test('unknown room id is rejected', async () => {
    const b = new Bot('lost');
    await b.ready();
    b.join('ZZZZZZ');
    await waitFor(() => !!b.last('error'));
    expect(b.last('error')!.code).toBe('ROOM_NOT_FOUND');
    b.join('../etc');
    await sleep(50);
    expect(b.last('error')!.code).toBe('ROOM_NOT_FOUND');
    b.close();
  });

  test('a full room refuses the 9th player', async () => {
    const { bots, id } = await makeRoom(8);
    const extra = new Bot('ninth');
    await extra.ready();
    extra.join(id);
    await waitFor(() => !!extra.last('error'));
    expect(extra.last('error')!.code).toBe('ROOM_FULL');
    expect(extra.room).toBeNull();
    [...bots, extra].forEach((b) => b.close());
  });

  test('only the host can start, and only when everyone is ready', async () => {
    const { bots } = await makeRoom(3);
    bots[1].conn.send({ t: 'start' });
    await waitFor(() => !!bots[1].last('error'));
    expect(bots[1].last('error')!.code).toBe('NOT_HOST');
    bots[0].conn.send({ t: 'start' });
    await waitFor(() => !!bots[0].last('error'));
    expect(bots[0].last('error')!.code).toBe('NOT_READY');
    bots.forEach((b) => b.close());
  });

  test('host leaving hands host rights to the next player', async () => {
    const { bots } = await makeRoom(3);
    bots[0].conn.send({ t: 'leave' });
    await waitFor(() => bots[1].room!.players.length === 2);
    expect(bots[1].room!.players.find((p) => p.host)!.name).toBe('bot2');
    bots.forEach((b) => b.close());
  });

  test('a single player cannot start a match', async () => {
    const b = new Bot('alone');
    await b.ready();
    b.create();
    await waitFor(() => !!b.room);
    b.conn.send({ t: 'start' });
    await waitFor(() => !!b.last('error'));
    expect(b.last('error')!.code).toBe('NOT_ENOUGH_PLAYERS');
    b.close();
  });

  test('malformed messages are rejected without crashing the server', async () => {
    const ws = new WebSocket(url);
    await new Promise((r) => (ws.onopen = r));
    const got: any[] = [];
    ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'in', m: 1, e: 0, seq: 1, upto: 5, ev: [[1, 99999]], h: 0 }));
    ws.send(JSON.stringify({ t: 'start' }));
    await sleep(100);
    expect(got.some((m) => m.t === 'error' && m.code === 'BAD_REQUEST')).toBe(true);
    ws.close();
    const res = await fetch(`http://127.0.0.1:${app.port}/healthz`).then((r) => r.json());
    expect(res.ok).toBe(true);
  });
});

async function startMatch(bots: Bot[]) {
  for (const b of bots.slice(1)) b.conn.send({ t: 'ready', ready: true });
  await waitFor(() => bots[0].room!.players.filter((p) => p.ready).length === bots.length - 1);
  bots[0].conn.send({ t: 'start' });
  await waitFor(() => bots.every((b) => !!b.runner));
}

describe('matches', () => {
  test('6 players: same start time, knockouts, and one consistent final ranking', async () => {
    const { bots } = await makeRoom(6, 15);
    await startMatch(bots);
    const starts = new Set(bots.map((b) => b.runner!.info.startAt));
    const seeds = new Set(bots.map((b) => b.runner!.info.seed));
    expect(starts.size).toBe(1);
    expect(seeds.size).toBe(1);
    expect(bots[0].runner!.info.startAt - Date.now()).toBeGreaterThan(2500);

    await waitFor(() => bots.every((b) => !!b.results), 30000);
    const r = bots[0].results!;
    expect(r.map((x) => x.place)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r[0].reason).toBe('winner');
    for (const b of bots) expect(b.results).toEqual(r);
    // knockouts were announced worst place first
    const places = bots[0].kos.map((k) => k.place);
    expect(places).toEqual([...places].sort((a, b) => b - a));
    // server-side scores match what each client simulated locally
    for (const b of bots) {
      const row = r.find((x) => x.id === b.you)!;
      expect(row.lines).toBe(b.runner!.game.lines);
    }
    // room returns to the lobby with a win recorded
    await waitFor(() => bots[0].room!.phase === 'lobby');
    expect(bots[0].room!.players.find((p) => p.id === r[0].id)!.wins).toBe(1);
    bots.forEach((b) => b.close());
  }, 40000);

  test('a client cannot claim progress ahead of the server clock or forge garbage acks', async () => {
    const { bots } = await makeRoom(2, 100000);
    await startMatch(bots);
    const cheat = bots[1];
    await waitFor(() => cheat.runner!.started, 6000);
    const before = cheat.resyncs;
    // pretend 10 minutes have passed (would skip gravity / fake survival)
    cheat.conn.send({ t: 'in', m: cheat.runner!.info.id, e: cheat.runner!.epoch, seq: 10_000, upto: 36000, ev: [], h: 0 });
    await waitFor(() => cheat.resyncs > before);
    // ack garbage that was never sent
    const r = cheat.runner!;
    const before2 = cheat.resyncs;
    cheat.conn.send({ t: 'in', m: r.info.id, e: r.epoch, seq: 20_000, upto: r.game.tick, ev: [[r.game.tick, Input.Garbage, 777]], h: 0 });
    await waitFor(() => cheat.resyncs > before2);
    // there is no message type that sets score or declares a winner
    const res = cheat.msgs.filter((m) => m.t === 'end');
    expect(res.length).toBe(0);
    bots.forEach((b) => b.close());
  }, 20000);

  test('attacks send garbage to opponents and the server keeps both sides in sync', async () => {
    const { bots } = await makeRoom(2, 100000);
    await startMatch(bots);
    // Still in the countdown (tick 0 on both sides): give bot1 a ready-made tetris well
    // on the authoritative board and mirror it locally, so both timelines stay identical.
    const m = app.manager.rooms.get(bots[0].room!.id)!.match!;
    const p0 = m.players.get(bots[0].you)!;
    // fill 4 rows except the rightmost column on the authoritative board and mirror it on the client
    for (const g of [p0.game, bots[0].runner!.game]) {
      for (let y = 36; y < 40; y++) for (let x = 0; x < 9; x++) g.board[y * 10 + x] = 8;
      g.board[35 * 10] = 8;
    }
    await waitFor(() => bots[0].runner!.started, 6000);
    // drive bot1: rotate an I if we have one, otherwise hold until we do
    const r0 = bots[0].runner!;
    for (let i = 0; i < 14 && r0.game.cur!.p !== 1; i++) {
      r0.input(Input.HardDrop);
      r0.update();
      await sleep(5);
    }
    expect(r0.game.cur!.p).toBe(1);
    r0.input(Input.RotateCW);
    r0.input(Input.RightDown);
    r0.game.advanceTo(r0.game.tick); // no-op, keeps tick
    await sleep(250); // DAS to the wall
    r0.input(Input.RightUp);
    r0.input(Input.HardDrop);
    r0.flush();
    await waitFor(() => bots[1].garbage > 0, 3000);
    const g = bots[1].last('garbage')!;
    expect(g.lines).toBeGreaterThanOrEqual(4);
    expect(g.from).toBe(bots[0].you);
    bots.forEach((b) => b.close());
  }, 20000);

  test('a dropped connection rejoins the running match with its seat and state', async () => {
    const { bots, id } = await makeRoom(3, 200);
    await startMatch(bots);
    await waitFor(() => bots[2].runner!.started, 6000);
    await sleep(500);
    const victim = bots[2];
    const token = victim.token;
    const you = victim.you;
    victim.stopPlaying();
    victim.conn.close();
    await waitFor(() => bots[0].room!.players.find((p) => p.id === you)?.connected === false);

    const back = new Bot('bot3-again', 200);
    await back.ready();
    back.join(id, token);
    await waitFor(() => !!back.last('welcome'));
    expect(back.you).toBe(you);
    await waitFor(() => back.resyncs > 0);
    expect(back.runner).not.toBeNull();
    expect(back.runner!.epoch).toBeGreaterThan(0);
    await waitFor(() => bots[0].room!.players.find((p) => p.id === you)?.connected === true);
    // the server keeps accepting the rejoined client's inputs and both sides agree
    const mp = app.manager.rooms.get(id)!.match!.players.get(you)!;
    const seqBefore = mp.seq;
    await sleep(600);
    expect(mp.seq).toBeGreaterThan(seqBefore);
    if (mp.alive) {
      back.stopPlaying(); // final flush
      await sleep(150);
      expect(mp.game.tick).toBe(back.runner!.game.tick);
      expect(mp.game.hash()).toBe(back.runner!.game.hash());
    }
    [...bots, back].forEach((b) => b.close());
  }, 20000);

  test('automatic reconnect after a network blip keeps playing', async () => {
    const { bots } = await makeRoom(2, 300);
    await startMatch(bots);
    await waitFor(() => bots[0].runner!.started, 6000);
    const b = bots[1];
    // the browser client re-sends join with its token on every reconnect
    b.conn.onOpen(() => b.join(bots[0].room!.id, b.token));
    b.conn.dropForTest();
    await waitFor(() => b.conn.status === 'reconnecting', 2000);
    await waitFor(() => b.conn.status === 'open', 5000);
    await waitFor(() => b.resyncs > 0, 3000);
    expect(bots[0].room!.players.every((p) => p.connected)).toBe(true);
    bots.forEach((x) => x.close());
  }, 20000);

  test('pause freezes every player, and only the pauser can resume (after a countdown)', async () => {
    const { bots, id } = await makeRoom(2, 100000);
    await startMatch(bots);
    await waitFor(() => bots.every((b) => b.runner!.started), 6000);
    await sleep(500);
    const match = () => app.manager.rooms.get(id)!.match!;
    const serverTicks = () => [...match().players.values()].map((p) => p.game.tick);

    // bot2 pauses: the whole match freezes for everyone
    bots[1].conn.send({ t: 'pause' });
    await waitFor(() => bots.every((b) => b.room!.pause !== null));
    expect(bots[0].room!.pause!.by).toBe(bots[1].you);
    expect(bots[0].room!.pause!.name).toBe('bot2');
    await sleep(300); // let any in-flight batches settle
    const frozenClients = bots.map((b) => b.runner!.game.tick);
    const frozenServer = serverTicks();
    await sleep(1000);
    expect(bots.map((b) => b.runner!.game.tick)).toEqual(frozenClients);
    expect(serverTicks()).toEqual(frozenServer);
    expect(bots.every((b) => b.runner!.isPaused())).toBe(true);

    // someone else cannot resume
    bots[0].conn.send({ t: 'resume' });
    await sleep(300);
    expect(bots[0].room!.pause).not.toBeNull();
    expect(bots[0].room!.pause!.resumeAt).toBeNull();

    // the pauser resumes: a countdown comes first, then play continues
    bots[1].conn.send({ t: 'resume' });
    await waitFor(() => bots[0].room!.pause?.resumeAt != null);
    await sleep(300);
    expect(serverTicks()).toEqual(frozenServer); // still frozen during the countdown
    await waitFor(() => bots[0].room!.pause === null, 6000);
    await sleep(700);
    expect(Math.min(...serverTicks())).toBeGreaterThan(Math.min(...frozenServer));
    expect(bots.every((b) => !b.runner!.isPaused())).toBe(true);
    bots.forEach((b) => b.close());
  }, 30000);
});
