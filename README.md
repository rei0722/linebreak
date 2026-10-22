# LINEBREAK

A browser block-puzzle game with real-time online battles for up to 8 players (expandable to 16). It's built for PC.
Create a room, send the invite URL, and your friends join by opening it.

- Standard rules: 10×20 field, 7 piece types, SRS rotation and wall kicks, 7-bag, hold, 5-piece next queue, ghost piece, and lock delay with a 15-move reset limit.
- Survival mode: each player plays their own board. A top-out eliminates you, and the last player standing wins. Garbage attacks can be switched on or off.
- The server re-simulates every player's input log, so scores, eliminations, attacks and rankings can't be faked from a client.

> **Deployment status:** This repository has not been deployed to production. Only local runs were verified. Follow "Production deployment" below to publish it.

---

## Requirements

- [Bun](https://bun.sh) 1.2 or later (developed and tested on 1.4.3)
  - The server only uses `node:http` and `ws`, so it is designed to run on Node.js 20+ with `npx tsx server/index.ts`. This environment has no Node.js, though, so that path is untested.

## Local development

```bash
bun install
bun run dev          # game server :8787 + Vite :5173 (proxies /ws and /api to :8787)
```

Open http://localhost:5173. To test multiplayer, open the invite URL in another tab, another browser, or another PC on the same LAN.
Seats are stored per tab (sessionStorage), so **several tabs in one browser count as different players**.

Running in production mode (one port serves the app and the WebSocket):

```bash
bun run build        # → client/dist
bun run start        # http://localhost:8787
```

To fill a room with bots (useful for checking 8-player layouts):

```bash
bun tests/bots.ts <ROOM_ID> 7
```

## Tests

```bash
bun test             # unit tests + integration tests that run a real server
bun run typecheck    # TypeScript
```

| File | Coverage |
| --- | --- |
| `tests/engine.test.ts` (30) | 7-bag, movement, DAS/ARR, key conflicts, SRS kicks, hold, hard and soft drop, gravity, lock delay limit, 1–4 line scoring, B2B, T-spin, perfect clear, top-out, level-ups, garbage insertion, cancelling and caps, deterministic replay, save/restore |
| `tests/online.test.ts` (12) | Start a real server and connect bots that use the same `Connection`/`MatchRunner` as the browser. Covers room creation and joining, unknown room IDs, rejecting a 9th player, host-only start, ready checks, host handover, a minimum of 2 players, malformed messages, a full **6-player** match (shared start time and seed, elimination order, results identical for all players), rejection of clients that run ahead of the server clock or fake garbage acks, garbage delivery, rejoining mid-match after a disconnect, and auto-reconnect |

Checked by hand in a real browser (multiple tabs in the Claude desktop app's browser pane):

- A 4-player match from room creation, invite URL and ready-up through countdown, eliminations, final rankings and rematch
- Reloading a tab during a match → it comes back with the same seat and board state
- 8 players (1 browser + 7 bots) at 1280×720: layout and results screen
- Invalid room ID screen, and 59.7 FPS measured on the active tab during a 4-player match

## Environment variables

See `.env.example`. A default single-service deployment needs **no settings at all**. There are no secrets.

| Variable | When | Purpose |
| --- | --- | --- |
| `PORT` | Runtime | Listen port (default 8787; usually set by the host) |
| `HOST` | Runtime | Bind address (default `0.0.0.0`) |
| `ALLOWED_ORIGINS` | Runtime | Comma-separated origins allowed to connect to `/ws`. Empty allows any origin. Set it when the frontend runs on a different domain |
| `STATIC_DIR` | Runtime | Directory with the built client (default `client/dist`) |
| `VITE_SERVER_URL` | Build | Backend origin when frontend and backend are deployed separately, e.g. `https://linebreak-api.fly.dev` |
| `VITE_PUBLIC_URL` | Build | Origin used in invite links (default: the page's own origin) |
| `DEV_SERVER_URL` | Dev | Where the Vite dev server proxies (default `http://localhost:8787`) |

## Production deployment

Rooms are kept **in the server's memory**, so run **exactly one instance that stays up**. Avoid free tiers that sleep and serverless platforms. Restarting the server drops any rooms in progress.

### A. Single service (recommended): Fly.io / Render / any Docker host

The server also serves the built client, so frontend and WebSocket share one origin and no connection settings are needed.

```bash
# Fly.io
fly launch --copy-config --no-deploy   # change app in fly.toml to a unique name
fly deploy
# → https://<app>.fly.dev/ is the game. Invites look like https://<app>.fly.dev/room/AB12CD
```

Render: New → Blueprint → choose this repository (uses `render.yaml`).
Other Docker hosts: `docker build -t linebreak . && docker run -p 8787:8787 linebreak`.
(I couldn't build the Dockerfile here because Docker isn't installed in this environment.)

### B. Separate frontend and backend

1. Deploy the backend using A, then set `ALLOWED_ORIGINS=https://<frontend domain>`.
2. Build and publish the frontend with `VITE_SERVER_URL=https://<backend domain>` and `VITE_PUBLIC_URL=https://<frontend domain>`.
   - Vercel: `vercel.json` is included (it rewrites `/room/*` to the SPA)
   - Netlify / Cloudflare Pages: `client/public/_redirects` is included
3. The backend must accept `wss://` (TLS). Fly and Render handle this automatically.

## How invite URLs work

1. Pressing "部屋を作る" (Create room) opens `/room/new` and sends `create` over the WebSocket.
2. The server issues a 6-character ID from a 31-character alphabet that excludes the look-alikes 0/O and 1/I/L (31⁶ ≈ 890 million combinations, checked for collisions). It also returns a **seat token** for the player.
3. The client rewrites the URL to `/room/AB12CD` (history.replaceState) and shows `inviteUrl()` (`VITE_PUBLIC_URL` or the current origin + `/room/ID`) as a copyable link.
4. A friend who opens the URL gets `index.html` from the SPA fallback, enters a name, and the client sends `join`. The server answers `ROOM_NOT_FOUND` if the room doesn't exist, or `ROOM_FULL` if it is full.
5. The seat token is stored in sessionStorage. After a reload or reconnect it is sent with `join`, so the player gets the same seat back (the seat is held for 30 seconds in the lobby and 20 seconds during a match).

## Architecture

```
shared/engine/   Deterministic 60Hz tick engine (integer math only, identical in V8/JSC/SpiderMonkey)
shared/protocol  Message types
server/          node:http + ws. RoomManager (rooms, host, rate limits) / Match (authoritative re-simulation)
client/          React + Vite. Boards are drawn on Canvas 2D from a single rAF loop (no React re-renders during play)
```

### Real-time sync and anti-cheat

- **Local first:** key input goes straight into the local engine and shows up on the next frame. DAS/ARR are counted in engine ticks.
- **Input log:** every 50 ms the client sends `{epoch, seq, upto, ev: [[tick, code], …], hash}`. Hard drop and hold are sent immediately. The client never sends scores or eliminations.
- **Server re-simulation:** the server replays the log in the same engine. Scores, line clears, attack amounts, top-outs and rankings all come from the server's result.
- **Validation:** the server checks schemas (zod); that ticks run in order and don't run ahead of the server clock (+0.5 s allowed); event counts and codes; that garbage acks refer to garbage that was really sent and aren't duplicated; duplicate or old `seq` values; stale `epoch` values; message size (16 KB); and rate limits (token bucket, 60 msg/s).
- **Correcting divergence (resync):** if the hash doesn't match, the input is invalid, or the client falls more than 3 s behind (hidden tab, freezing, a slowdown cheat), the server pushes its own state, bumps the `epoch`, and the client continues from that state.
- **Garbage:** attack (after cancelling against your own incoming garbage) × the strength setting goes to one surviving opponent (random or round-robin). Each chunk has a single hole column chosen by the server. The receiver acknowledges it at the tick it arrives. If it isn't acknowledged within 2.5 s, the server inserts it anyway. Incoming garbage is inserted when you lock a piece without clearing a line, up to 8 rows per lock in arrival order. Eliminated players receive nothing.
- **Clock sync:** NTP-style offset estimation from ping/pong, weighted toward the sample with the smallest RTT. Every client starts at the same server timestamp (`startAt`) after a 3.5-second countdown.
- **Bandwidth:** opponent boards are sent as 10 Hz diffs (only boards that changed), about 250 bytes per player.

Latency isn't zero: opponent boards run behind by one-way delay plus up to 100 ms. Your own controls don't wait on the network.

## Implemented features

- Solo play (150-line marathon, pause and restart, auto-pause when the tab is hidden)
- Movement, CW/CCW rotation (SRS), soft drop, hard drop, hold, 5-piece next queue, ghost piece
- Scoring for singles through 4-line clears, T-spin (mini), B2B, combos and perfect clears; level-ups and faster gravity
- In battles, gravity also rises every 45 seconds so matches always end
- Room creation, invite URL, one-click copy, display names, host transfer and kick, ready state, connection state, full-room rejection
- Host settings: garbage on/off, targeting (random / round-robin), strength 50–150%, max players 4/8/12/16
- Synced countdown, 2–16 player battles, opponent mini boards (2-column layout, auto-sized), incoming-garbage meter, hit effects
- Line clear flash, hard drop trail, attack name pop-up, elimination rank display, winner and final rankings screen, rematch, win count
- Disconnect banner, auto-reconnect (exponential backoff), seat restore after reload, spectating for players who join mid-match
- Sound effects (synthesized with WebAudio, toggle saved), handling settings (DAS/ARR/soft drop speed)
- Arrow and Space keys don't scroll the page, OS key repeat is ignored, held keys are released when the window loses focus, and an empty `e.code` falls back to `e.key`
- Responsive down to about 1280×720 (more compact below that)

## Not implemented / known limitations

- **Production deployment not done** (I haven't deployed it or published a URL)
- Building the Dockerfile and running on Node.js are untested (neither Docker nor Node.js was available)
- Rooms live in memory: horizontal scaling and keeping rooms across restarts aren't supported (that would need Redis or similar plus sticky sessions)
- No custom key bindings (only DAS/ARR/SDF can be changed)
- No 180° rotation, IRS/IHS, or replay saving
- No touch controls on phones (PC only)
- No accounts, persistent rankings or matchmaking
- No E2E tests with Playwright or similar (multi-browser behaviour is covered by integration tests with real WebSockets and by hand)
- No hard limits per IP on the number of rooms or connections (only per-connection rate limits)
- The reference site (game16.net) only stated its controls, 150-line marathon, HOLD position and 5-piece next queue. Everything else follows standard guideline specs. No code, images or other assets from the reference site were used.
