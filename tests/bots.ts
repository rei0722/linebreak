// Dev helper: fill a room with bot players that ready up and play slowly.
// Usage: bun tests/bots.ts <ROOMID> [count=7] [server=ws://localhost:8787/ws]
import { Connection } from '../client/src/net/connection';
import { MatchRunner } from '../client/src/net/matchRunner';
import { Input } from '../shared/engine/game';
import { DEFAULT_HANDLING } from '../shared/engine/rules';
import { PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol';
import { bestMove } from '../client/src/game/ai';

/** Place one piece with ordinary inputs only (rotate, tap left/right, hard drop). */
function placeSmart(runner: MatchRunner) {
  const m = bestMove(runner.game);
  if (!m) return;
  for (let i = 0; i < m.r; i++) runner.input(Input.RotateCW);
  for (let i = 0; i < 12; i++) {
    const x = runner.game.cur?.x;
    if (x === undefined || x === m.x) break;
    if (x > m.x) (runner.input(Input.LeftDown), runner.input(Input.LeftUp));
    else (runner.input(Input.RightDown), runner.input(Input.RightUp));
    if (runner.game.cur?.x === x) break; // blocked
  }
  runner.input(Input.HardDrop);
}

// Add "smart" as a 4th argument for bots that stack properly (and so send real attacks):
//   bun tests/bots.ts <ROOMID> 3 ws://localhost:8787/ws smart
const [room, countArg, url = 'ws://localhost:8787/ws', modeArg] = process.argv.slice(2);
const smart = modeArg === 'smart';
if (!room) {
  console.error('usage: bun tests/bots.ts <ROOMID> [count] [ws-url]');
  process.exit(1);
}
const NAMES = ['ルカ', 'ハル', 'ミナ', 'ソウタ', 'ユイ', 'カイ', 'ノア', 'リン', 'アオ', 'メイ', 'レン', 'サク', 'ナギ', 'ヒナ', 'トワ'];

for (let i = 0; i < Number(countArg ?? 7); i++) {
  const conn = new Connection(url);
  let runner: MatchRunner | null = null;
  let token: string | undefined;
  let you = '';
  let aimMode = false;
  let others: { id: string; name: string }[] = [];
  const out = new Set<string>();
  let aimTimer: ReturnType<typeof setTimeout> | null = null;
  // aim mode: re-pick a target every 6–14 s; humans get picked half the time so you feel the pressure
  const reAim = () => {
    const alive = others.filter((p) => !out.has(p.id));
    if (alive.length) {
      const humans = alive.filter((p) => !NAMES.includes(p.name));
      const pool = humans.length && Math.random() < 0.5 ? humans : alive;
      conn.send({ t: 'aim', id: pool[Math.floor(Math.random() * pool.length)].id });
    }
    aimTimer = setTimeout(reAim, 6000 + Math.random() * 8000);
  };
  conn.onOpen(() =>
    conn.send({ t: 'join', room, name: NAMES[i % NAMES.length], handling: DEFAULT_HANDLING, token, v: PROTOCOL_VERSION }),
  );
  conn.on((m: ServerMsg) => {
    runner?.handle(m);
    if (m.t === 'welcome') {
      token = m.token;
      you = m.you;
      setTimeout(() => conn.send({ t: 'ready', ready: true }), 300);
    }
    if (m.t === 'room' && m.room.phase === 'lobby' && !m.room.players.find((p) => p.name === NAMES[i % NAMES.length])?.ready)
      conn.send({ t: 'ready', ready: true });
    if (m.t === 'room' || m.t === 'welcome') aimMode = m.room.settings.mode === 'aim';
    if ((m.t === 'room' || m.t === 'welcome') && runner) runner.syncPause(m.room.pause);
    if (m.t === 'countdown') {
      runner = new MatchRunner(m.match, DEFAULT_HANDLING, (x) => conn.send(x), () => conn.serverNow());
      others = m.match.participants.filter((p) => p.id !== you);
      out.clear();
      if (aimTimer) clearTimeout(aimTimer);
      if (aimMode) aimTimer = setTimeout(reAim, Math.max(0, m.match.startAt - conn.serverNow()) + 1500 + Math.random() * 3000);
    }
    if (m.t === 'ko') out.add(m.id);
    if (m.t === 'end' && aimTimer) clearTimeout(aimTimer);
    if (m.t === 'error') console.log(NAMES[i], m.code, m.msg);
  });
  setInterval(() => {
    if (!runner) return;
    runner.update();
    if (smart) {
      if (runner.started && !runner.game.over && Math.random() < 0.035) placeSmart(runner);
      return;
    }
    if (runner.started && Math.random() < 0.012 + i * 0.002) {
      const k = Math.floor(Math.random() * 3);
      if (k === 0) runner.input(Input.RotateCW);
      if (k === 1) (runner.input(Input.LeftDown), runner.input(Input.LeftUp));
      if (k === 2) (runner.input(Input.RightDown), runner.input(Input.RightUp));
      runner.input(Input.HardDrop);
    }
  }, 16);
}
console.log(`bots joining ${room}…`);
