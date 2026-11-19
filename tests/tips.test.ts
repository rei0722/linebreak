// Live player count and ¥50 tips (supporter name tag).

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import WebSocket from 'ws';
import { startServer } from '../server/index';
import { Presence, Tips } from '../server/tips';
import { DEFAULT_HANDLING } from '../shared/engine/rules';
import { PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol';

describe('Tips', () => {
  const fakeStripe = (session: Record<string, unknown>) =>
    (async () => new Response(JSON.stringify(session), { status: 200 })) as unknown as typeof fetch;
  const paid = { payment_status: 'paid', currency: 'jpy', amount_total: 50, metadata: { app: 'linebreak' } };
  const sid = 'cs_test_a1B2c3D4e5F6g7H8i9J0';

  test('a paid Checkout Session becomes a token the server accepts', async () => {
    const t = new Tips({ stripeKey: 'sk_test_x', fetchImpl: fakeStripe(paid) });
    const token = await t.claim(sid);
    expect(token).toBeString();
    expect(t.verify(token!)).toBe(true);
  });

  test('unpaid, wrong currency, too small or foreign sessions are refused', async () => {
    for (const bad of [
      { ...paid, payment_status: 'unpaid' },
      { ...paid, currency: 'usd' },
      { ...paid, amount_total: 10 },
      { ...paid, metadata: { app: 'other' } },
    ]) {
      const t = new Tips({ stripeKey: 'sk_test_x', fetchImpl: fakeStripe(bad) });
      expect(await t.claim(sid)).toBeNull();
    }
  });

  test('forged or tampered tokens fail; another server secret fails', () => {
    const a = new Tips({ stripeKey: 'sk_test_a' });
    const b = new Tips({ stripeKey: 'sk_test_b' });
    const tok = a.sign(sid);
    expect(a.verify(tok)).toBe(true);
    expect(b.verify(tok)).toBe(false);
    expect(a.verify(tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(a.verify(`${sid}.nope`)).toBe(false);
    expect(a.verify('garbage')).toBe(false);
    expect(a.verify(undefined)).toBe(false);
  });

  test('mock tokens only work while mock mode is on; tips off = nobody is a supporter', () => {
    const mock = new Tips({ mock: true });
    const tok = mock.sign('mock_0123456789abcdef01234567');
    expect(mock.verify(tok)).toBe(true);
    expect(new Tips({ stripeKey: 'sk_test_x' }).verify(tok)).toBe(false);
    expect(new Tips({}).enabled).toBe(false);
  });
});

describe('Presence', () => {
  test('counts distinct browsers and forgets them after the TTL', () => {
    let now = 1_000_000;
    const p = new Presence(() => now);
    p.ping('aaaaaaaaaaaaaaaa1');
    p.ping('aaaaaaaaaaaaaaaa1');
    p.ping('bbbbbbbbbbbbbbbb2');
    p.ping('BAD ID');
    p.ping(null);
    expect(p.count()).toBe(2);
    now += Presence.TTL_MS + 1;
    expect(p.count()).toBe(0);
  });
});

describe('server', () => {
  let app: Awaited<ReturnType<typeof startServer>>;
  let base = '';
  beforeAll(async () => {
    app = await startServer({ port: 0, host: '127.0.0.1', staticDir: '/nonexistent', tips: { mock: true } });
    base = `http://127.0.0.1:${app.port}`;
  });
  afterAll(() => app.close());

  const joinRoom = (sup?: string) =>
    new Promise<ServerMsg & { t: 'welcome' }>((ok, fail) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
      ws.on('open', () =>
        ws.send(JSON.stringify({ t: 'create', name: 'テスト', handling: DEFAULT_HANDLING, v: PROTOCOL_VERSION, sup })),
      );
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString()) as ServerMsg;
        if (m.t === 'welcome') {
          ok(m);
          ws.close();
        }
      });
      ws.on('error', fail);
    });

  test('/api/stats reports online browsers, players in matches and whether tips are on', async () => {
    const s = await fetch(`${base}/api/stats?v=cccccccccccccccc3`).then((r) => r.json());
    expect(s).toEqual({ online: 1, playing: 0, tips: true });
    const s2 = await fetch(`${base}/api/stats?v=dddddddddddddddd4`).then((r) => r.json());
    expect(s2.online).toBe(2);
  });

  test('checkout → claim → join shows the supporter tag; a fake token does not', async () => {
    const { url } = await fetch(`${base}/api/tip/checkout`, { method: 'POST' }).then((r) => r.json());
    const session = new URL(url).searchParams.get('tip');
    expect(session).toMatch(/^mock_/);
    const claim = await fetch(`${base}/api/tip/claim`, { method: 'POST', body: JSON.stringify({ session }) });
    expect(claim.status).toBe(200);
    const { token } = await claim.json();

    const yes = await joinRoom(token);
    expect(yes.room.players[0].supporter).toBe(true);
    const no = await joinRoom(`${session}.forged`);
    expect(no.room.players[0].supporter).toBe(false);
    const none = await joinRoom();
    expect(none.room.players[0].supporter).toBe(false);
  });

  test('claim rejects junk session ids and GET', async () => {
    expect((await fetch(`${base}/api/tip/claim`, { method: 'POST', body: '{"session":"cs_live_x"}' })).status).toBe(402);
    expect((await fetch(`${base}/api/tip/claim`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${base}/api/tip/checkout`)).status).toBe(405);
  });
});

describe('playing count', () => {
  test('/api/stats counts players once a match starts', async () => {
    const app = await startServer({ port: 0, host: '127.0.0.1', staticDir: '/nonexistent' });
    const base = `http://127.0.0.1:${app.port}`;
    const open = () =>
      new Promise<{ ws: WebSocket; next: (t: string) => Promise<ServerMsg> }>((ok) => {
        const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
        const queue: ServerMsg[] = [];
        const waiters: (() => void)[] = [];
        ws.on('message', (d) => {
          queue.push(JSON.parse(d.toString()));
          waiters.splice(0).forEach((w) => w());
        });
        const next = async (t: string): Promise<ServerMsg> => {
          for (;;) {
            const i = queue.findIndex((m) => m.t === t);
            if (i >= 0) return queue.splice(i, 1)[0];
            await new Promise<void>((r) => waiters.push(r));
          }
        };
        ws.on('open', () => ok({ ws, next }));
      });
    const a = await open();
    a.ws.send(JSON.stringify({ t: 'create', name: 'A', handling: DEFAULT_HANDLING, v: PROTOCOL_VERSION }));
    const w = (await a.next('welcome')) as ServerMsg & { t: 'welcome' };
    const b = await open();
    b.ws.send(JSON.stringify({ t: 'join', room: w.room.id, name: 'B', handling: DEFAULT_HANDLING, v: PROTOCOL_VERSION }));
    await b.next('welcome');
    b.ws.send(JSON.stringify({ t: 'ready', ready: true }));
    await new Promise((r) => setTimeout(r, 100));
    expect((await fetch(`${base}/api/stats`).then((r) => r.json())).playing).toBe(0);
    a.ws.send(JSON.stringify({ t: 'start' }));
    await a.next('countdown');
    expect((await fetch(`${base}/api/stats`).then((r) => r.json())).playing).toBe(2);
    a.ws.close();
    b.ws.close();
    await app.close();
  });
});
