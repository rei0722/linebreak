// Dev helper: fill a room with bot players that ready up and play slowly.
// Usage: bun tests/bots.ts <ROOMID> [count=7] [server=ws://localhost:8787/ws]
import { Connection } from '../client/src/net/connection';
import { MatchRunner } from '../client/src/net/matchRunner';
import { Input } from '../shared/engine/game';
import { DEFAULT_HANDLING } from '../shared/engine/rules';
import { PROTOCOL_VERSION, type ServerMsg } from '../shared/protocol';

const [room, countArg, url = 'ws://localhost:8787/ws'] = process.argv.slice(2);
if (!room) {
  console.error('usage: bun tests/bots.ts <ROOMID> [count] [ws-url]');
  process.exit(1);
}
const NAMES = ['ルカ', 'ハル', 'ミナ', 'ソウタ', 'ユイ', 'カイ', 'ノア', 'リン', 'アオ', 'メイ', 'レン', 'サク', 'ナギ', 'ヒナ', 'トワ'];

for (let i = 0; i < Number(countArg ?? 7); i++) {
  const conn = new Connection(url);
  let runner: MatchRunner | null = null;
  let token: string | undefined;
  conn.onOpen(() =>
    conn.send({ t: 'join', room, name: NAMES[i % NAMES.length], handling: DEFAULT_HANDLING, token, v: PROTOCOL_VERSION }),
  );
  conn.on((m: ServerMsg) => {
    runner?.handle(m);
    if (m.t === 'welcome') {
      token = m.token;
      setTimeout(() => conn.send({ t: 'ready', ready: true }), 300);
    }
    if (m.t === 'room' && m.room.phase === 'lobby' && !m.room.players.find((p) => p.name === NAMES[i % NAMES.length])?.ready)
      conn.send({ t: 'ready', ready: true });
    if ((m.t === 'room' || m.t === 'welcome') && runner) runner.syncPause(m.room.pause);
    if (m.t === 'countdown') runner = new MatchRunner(m.match, DEFAULT_HANDLING, (x) => conn.send(x), () => conn.serverNow());
    if (m.t === 'error') console.log(NAMES[i], m.code, m.msg);
  });
  setInterval(() => {
    if (!runner) return;
    runner.update();
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
