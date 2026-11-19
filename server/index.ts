// HTTP + WebSocket entry point. Serves the built client (single-origin deploy)
// and the realtime endpoint at /ws. Runs on Bun or Node (via tsx).

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOM_ID_RE } from '../shared/protocol';
import { RoomManager, type Conn } from './rooms';
import { parseClientMsg } from './schema';
import { Presence, Tips, type TipConfig } from './tips';

export interface ServerOptions {
  port: number;
  host?: string;
  staticDir?: string;
  /** Allowed browser origins for /ws. Empty = allow all. */
  allowedOrigins?: string[];
  /** ¥50 tips. Off when no Stripe key (and no mock) is given. */
  tips?: TipConfig;
  /** Public origin used for Stripe's return URLs. Default: from the request's Host header. */
  publicUrl?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 2048): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    req.on('error', fail);
  });
}

/** Origin the browser used, for Stripe's success/cancel URLs. */
function requestOrigin(req: IncomingMessage, fixed: string | undefined, allowed: string[]): string {
  if (fixed) return fixed.replace(/\/+$/, '');
  // The page's own origin (also right behind the Vite dev proxy and split deploys).
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/[^/]+$/.test(origin) && (allowed.length === 0 || allowed.includes(origin))) return origin;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  const fwd = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  const proto = fwd || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

/** Small per-IP limiter for the paid endpoints (Stripe calls cost API quota). */
function limiter(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (req: IncomingMessage): boolean => {
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
    const now = Date.now();
    const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= perMinute) return false;
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}

function serveStatic(STATIC_DIR: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = join(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  if (!rel || !existsSync(file) || statSync(file).isDirectory()) {
    // SPA fallback: /room/ABC123 and friends render index.html
    file = join(STATIC_DIR, 'index.html');
    rel = 'index.html';
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Client build not found. Run `bun run build`, or use the Vite dev server on :5173.');
      return;
    }
  }
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

export async function startServer(opts: ServerOptions) {
  const STATIC_DIR = resolve(opts.staticDir ?? join(import.meta.dirname, '../client/dist'));
  const allowed = opts.allowedOrigins ?? [];
  const tips = new Tips(opts.tips ?? {});
  const presence = new Presence();
  const manager = new RoomManager(Date.now, (t) => tips.verify(t));
  const tipLimit = limiter(10);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, ...manager.stats() });
    const m = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
    if (m) {
      const id = m[1].toUpperCase();
      const room = ROOM_ID_RE.test(id) ? manager.rooms.get(id) : undefined;
      if (!room) return sendJson(res, 404, { exists: false });
      return sendJson(res, 200, {
        exists: true,
        players: room.players.size,
        maxPlayers: room.settings.maxPlayers,
        phase: room.phase,
      });
    }
    if (url.pathname === '/api/stats') {
      presence.ping(url.searchParams.get('v'));
      const { playing } = manager.stats();
      return sendJson(res, 200, { online: Math.max(presence.count(), 1), playing, tips: tips.enabled });
    }
    if (url.pathname === '/api/tip/checkout' || url.pathname === '/api/tip/claim') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method' });
      if (!tips.enabled) return sendJson(res, 404, { error: 'tips are off' });
      if (!tipLimit(req)) return sendJson(res, 429, { error: 'rate limited' });
      void (async () => {
        try {
          if (url.pathname === '/api/tip/checkout') {
            return sendJson(res, 200, { url: await tips.checkout(requestOrigin(req, opts.publicUrl, allowed)) });
          }
          let body: { session?: unknown };
          try {
            body = JSON.parse((await readBody(req)) || '{}');
          } catch {
            return sendJson(res, 400, { error: 'bad request' });
          }
          const token = typeof body.session === 'string' ? await tips.claim(body.session) : null;
          return token ? sendJson(res, 200, { token }) : sendJson(res, 402, { error: 'not paid' });
        } catch (e) {
          console.error('[tips]', (e as Error).message);
          if (!res.headersSent) sendJson(res, 502, { error: 'payment provider error' });
        }
      })();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(STATIC_DIR, req, res);
  });

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 16 * 1024,
    perMessageDeflate: false, // latency over bandwidth; messages are small
    verifyClient: ({ origin }: { origin?: string }) =>
      allowed.length === 0 || (origin !== undefined && allowed.includes(origin)),
  });

  let nextConnId = 1;
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on('connection', (ws) => {
    const conn: Conn = {
      id: nextConnId++,
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    alive.set(ws, true);
    manager.connect(conn);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      manager.handle(conn, parseClientMsg(data.toString()));
    });
    ws.on('close', () => manager.disconnect(conn));
    ws.on('error', () => ws.terminate());
  });

  // Dead-peer detection: browsers answer protocol pings automatically.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, 10_000);

  const ticker = setInterval(() => manager.update(), 50);

  await new Promise<void>((ok) => server.listen(opts.port, opts.host ?? '0.0.0.0', ok));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    port,
    manager,
    close: () =>
      new Promise<void>((ok) => {
        clearInterval(heartbeat);
        clearInterval(ticker);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        server.close(() => ok());
      }),
  };

}

if (import.meta.main) {
  const opts: ServerOptions = {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? '0.0.0.0',
    staticDir: process.env.STATIC_DIR,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicUrl: process.env.PUBLIC_URL || undefined,
    tips: {
      stripeKey: process.env.STRIPE_SECRET_KEY || undefined,
      secret: process.env.SUPPORTER_SECRET || undefined,
      // fake payments for local testing; never in production
      mock: process.env.TIP_MOCK === '1' && process.env.NODE_ENV !== 'production',
    },
  };
  const app = await startServer(opts);
  console.log(`[linebreak] listening on :${app.port}  (websocket: /ws)`);
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      app.close().then(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}
