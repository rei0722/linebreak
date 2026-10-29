import { useEffect, useMemo, useRef, useState } from 'react';
import { VISIBLE_H } from '../../../shared/engine/rules';
import { PAUSE_LIMIT_MS, type BoardSnap, type PauseInfo, type PlayerView, type ResultRow, type RoomView } from '../../../shared/protocol';
import { sfx } from '../game/audio';
import { GameView } from '../game/GameView';
import { COLORS, drawMini, setupCanvas } from '../game/render';
import { onlineSource } from '../game/sources';
import { prefs } from '../prefs';
import { RoomSession, inviteUrl, useSession, type SessionState } from '../net/session';
import { ConnBadge, HandlingDialog, TopBar, navigate, toast, usePrefs, useViewport } from '../ui';
import { boardCell } from './Solo';

/** Stable colour per seat (join order), used for chips and mini-board names. */
const SEAT_COLORS = [
  ...[3, 1, 2, 5, 4, 6, 7].map((i) => COLORS[i]),
  // seats 8–16: lighter tints so no two players in a full room share a colour
  '#ff8fc8',
  '#9be7c4',
  '#c9b6ff',
  '#ffd8a8',
  '#8fd3ff',
  '#e6ee9c',
  '#f4a6a6',
  '#b0bec5',
  '#d7ccc8',
];
const seatColor = (room: RoomView, id: string) => {
  const i = room.players.findIndex((p) => p.id === id);
  return SEAT_COLORS[(i < 0 ? 0 : i) % SEAT_COLORS.length];
};

// ================================================================= page

/** Rooms created in this tab: /room/new is rewritten to /room/ID without remounting. */
export const createdHere = new Set<string>();

export function RoomPage({ id }: { id: string }) {
  const p = usePrefs();
  const creating = id === 'new' || createdHere.has(id);
  const [named, setNamed] = useState(creating || !!p.name);
  if (!named) return <JoinPrompt roomId={id} onDone={() => setNamed(true)} />;
  return <RoomConnected initialId={creating ? null : id} />;
}

function JoinPrompt({ roomId, onDone }: { roomId: string; onDone: () => void }) {
  const [name, setName] = useState(prefs.get().name);
  return (
    <div className="screen">
      <TopBar />
      <main className="screen-body center">
        <form
          className="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            prefs.set({ name: name.trim().slice(0, 16) });
            onDone();
          }}
        >
          <h2>招待された部屋に参加</h2>
          <p className="muted">
            部屋 <b className="num code-inline">{roomId}</b> に参加します。ほかのプレイヤーに表示される名前を決めてください。
          </p>
          <label className="label" htmlFor="jn">
            表示名
          </label>
          <input
            id="jn"
            className="field"
            autoFocus
            maxLength={16}
            placeholder="プレイヤー"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="dialog-actions">
            <button className="btn btn-primary" type="submit">
              参加する
            </button>
            <button className="btn btn-quiet" type="button" onClick={() => navigate('/')}>
              ホームに戻る
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}

function RoomConnected({ initialId }: { initialId: string | null }) {
  const session = useMemo(
    () =>
      new RoomSession(initialId, (rid) => {
        if (!initialId) createdHere.add(rid);
        navigate(`/room/${rid}`, true);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  useEffect(() => () => session.dispose(), [session]);
  const s = useSession(session);
  const room = s.room;

  // a non-fatal error (not ready, not host...) shows briefly as a toast
  useEffect(() => {
    if (s.error && !s.fatal) {
      toast(s.error.msg);
      session.clearError();
    }
  }, [s.error, s.fatal, session]);

  const inMatch = !!room && room.phase !== 'lobby' && !!room.match;
  const playing = !!s.runner && (inMatch || !!s.results);

  let body;
  if (s.fatal && s.error) body = <FatalCard code={s.error.code} msg={s.error.msg} />;
  else if (!room) body = <Connecting status={s.status} onRetry={() => session.conn.retry()} />;
  else if (playing) body = <Arena session={session} s={s} room={room} />;
  else if (inMatch) body = <Spectate session={session} room={room} />;
  else body = <Lobby session={session} s={s} room={room} />;

  return (
    <div className="screen">
      <TopBar>
        {room && (
          <span className="topbar-room">
            部屋 <b>{room.id}</b>
          </span>
        )}
        <ConnBadge status={s.status} />
      </TopBar>
      <main className="screen-body">{body}</main>
      {room && (s.status === 'reconnecting' || s.status === 'failed') && (
        <div className="netbanner" data-s={s.status} role="alert">
          {s.status === 'reconnecting' ? (
            '接続が切れました。再接続しています…'
          ) : (
            <>
              サーバーに接続できません。
              <button className="btn btn-sm" onClick={() => session.conn.retry()}>
                再接続する
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Connecting({ status, onRetry }: { status: SessionState['status']; onRetry: () => void }) {
  return (
    <div className="center">
      <div className="dialog">
        {status === 'failed' ? (
          <>
            <h2>サーバーに接続できません</h2>
            <p className="muted">ネットワークを確認してから、もう一度お試しください。</p>
            <div className="dialog-actions">
              <button className="btn btn-primary" onClick={onRetry}>
                再接続する
              </button>
              <button className="btn btn-quiet" onClick={() => navigate('/')}>
                ホームに戻る
              </button>
            </div>
          </>
        ) : (
          <>
            <h2>部屋に接続しています</h2>
            <p className="muted">{status === 'reconnecting' ? '再接続を試みています…' : 'サーバーと通信中です…'}</p>
            <div className="loader" aria-hidden>
              <i />
              <i />
              <i />
              <i />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FatalCard({ code, msg }: { code: string; msg: string }) {
  const title =
    code === 'ROOM_FULL'
      ? 'この部屋は満員です'
      : code === 'KICKED'
        ? '部屋から退出しました'
        : code === 'VERSION'
          ? 'ページが古くなっています'
          : '部屋が見つかりません';
  return (
    <div className="center">
      <div className="dialog">
        <h2>{title}</h2>
        <p className="muted">
          {code === 'ROOM_NOT_FOUND' ? '招待リンクが正しいか確認するか、新しい部屋を作ってください。' : msg}
        </p>
        <div className="dialog-actions">
          {code === 'VERSION' ? (
            <button className="btn btn-primary" onClick={() => location.reload()}>
              再読み込み
            </button>
          ) : (
            <button className="btn btn-primary" onClick={() => navigate('/room/new')}>
              新しく部屋を作る
            </button>
          )}
          <button className="btn btn-quiet" onClick={() => navigate('/')}>
            ホームに戻る
          </button>
        </div>
      </div>
    </div>
  );
}

// ================================================================= lobby

function Lobby({ session, s, room }: { session: RoomSession; s: SessionState; room: RoomView }) {
  const me = room.players.find((p) => p.id === s.you);
  const isHost = !!me?.host;
  const connected = room.players.filter((p) => p.connected);
  const waiting = connected.filter((p) => !p.host && !p.ready);
  const canStart = isHost && connected.length >= 2 && waiting.length === 0;
  const url = inviteUrl(room.id);
  const [name, setName] = useState(me?.name ?? '');
  const [handling, setHandling] = useState(false);
  useEffect(() => setName(me?.name ?? ''), [me?.name]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast('招待リンクをコピーしました');
    } catch {
      const el = document.getElementById('invite') as HTMLInputElement | null;
      el?.select();
      toast('リンクを選択しました。⌘C / Ctrl+C でコピーしてください');
    }
  };

  const startHint = !isHost
    ? null
    : connected.length < 2
      ? '開始にはあと1人以上必要です。招待リンクを送ってください。'
      : waiting.length
        ? `準備完了を待っています：${waiting.map((p) => p.name).join('、')}`
        : 'みんなの準備ができました。';

  const slots = Array.from({ length: room.settings.maxPlayers }, (_, i) => room.players[i] ?? null);

  return (
    <div className="lobby">
      <section className="lobby-info">
        <div className="room-code-block">
          <span className="label">部屋コード</span>
          <div className="room-code num" aria-label={`部屋コード ${room.id.split('').join(' ')}`}>
            {room.id}
          </div>
        </div>

        <div className="invite">
          <label className="label" htmlFor="invite">
            招待リンク
          </label>
          <div className="invite-row">
            <input id="invite" className="field invite-field" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="btn btn-primary" onClick={copy}>
              コピー
            </button>
          </div>
          <p className="hint">このリンクを開くだけで、同じ部屋に入れます。</p>
        </div>

        <div className="namebox">
          <label className="label" htmlFor="myname">
            あなたの表示名
          </label>
          <input
            id="myname"
            className="field"
            maxLength={16}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              const n = name.trim();
              if (n && n !== me?.name) {
                prefs.set({ name: n });
                session.setName(n);
              }
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>

        <RulesPanel room={room} isHost={isHost} session={session} />
        <button className="btn btn-quiet btn-sm lobby-handling" onClick={() => setHandling(true)}>
          操作設定（長押し・落下速度）
        </button>
      </section>

      <section className="lobby-players" aria-label="参加者">
        <header className="players-head">
          <h2>参加者</h2>
          <span className="num players-count">
            {room.players.length}
            <span className="muted"> / {room.settings.maxPlayers}</span>
          </span>
        </header>
        {room.lastResults && <LastWinner results={room.lastResults} />}
        <ol className="players">
          {slots.map((p, i) =>
            p ? (
              <PlayerRow
                key={p.id}
                p={p}
                me={p.id === s.you}
                color={SEAT_COLORS[i % SEAT_COLORS.length]}
                canKick={isHost && p.id !== s.you}
                onKick={() => session.kick(p.id)}
              />
            ) : (
              <li key={`empty${i}`} className="player player-empty">
                空き
              </li>
            ),
          )}
        </ol>
        <footer className="lobby-actions">
          {isHost ? (
            <>
              <p className="start-hint" data-ok={canStart}>
                {startHint}
              </p>
              <button className="btn btn-primary btn-lg" disabled={!canStart} onClick={() => session.start()}>
                {room.lastResults ? 'もう一度対戦する' : '対戦を始める'}
              </button>
            </>
          ) : (
            <>
              <p className="start-hint">
                {me?.ready ? 'ホストが開始するのを待っています。' : '準備ができたらボタンを押してください。'}
              </p>
              <button
                className={`btn btn-lg ${me?.ready ? '' : 'btn-primary'}`}
                onClick={() => session.setReady(!me?.ready)}
              >
                {me?.ready ? '準備を取り消す' : '準備完了'}
              </button>
            </>
          )}
        </footer>
      </section>
      {handling && <HandlingDialog onClose={() => setHandling(false)} />}
    </div>
  );
}

function LastWinner({ results }: { results: ResultRow[] }) {
  const w = results.find((r) => r.place === 1);
  if (!w) return null;
  return (
    <p className="last-winner">
      前回の優勝：<b>{w.name}</b>
    </p>
  );
}

function PlayerRow({
  p,
  me,
  color,
  canKick,
  onKick,
}: {
  p: PlayerView;
  me: boolean;
  color: string;
  canKick: boolean;
  onKick: () => void;
}) {
  const status = !p.connected ? '切断中' : p.spectator ? '次の対戦から' : p.host ? 'ホスト' : p.ready ? '準備完了' : '準備中';
  const tone = !p.connected ? 'off' : p.host ? 'host' : p.ready ? 'ready' : 'wait';
  return (
    <li className="player" data-me={me}>
      <span className="chip" style={{ background: color }} aria-hidden />
      <span className="player-name">
        {p.name}
        {me && <span className="tag-you">あなた</span>}
      </span>
      {p.wins > 0 && <span className="wins num">{p.wins}勝</span>}
      <span className="pstatus" data-tone={tone}>
        {status}
      </span>
      {canKick && (
        <button className="btn btn-quiet btn-sm btn-danger kick" onClick={onKick} title={`${p.name} を退出させる`}>
          退出させる
        </button>
      )}
    </li>
  );
}

function RulesPanel({ room, isHost, session }: { room: RoomView; isHost: boolean; session: RoomSession }) {
  const st = room.settings;
  const set = session.updateSettings.bind(session);
  return (
    <fieldset className="rules" disabled={!isHost}>
      <legend className="label">ルール{isHost ? '' : '（ホストが設定）'}</legend>
      <div className="rule">
        <span>おじゃま攻撃</span>
        <div className="seg" role="group">
          <button aria-pressed={st.attacks} onClick={() => set({ attacks: true })}>
            あり
          </button>
          <button aria-pressed={!st.attacks} onClick={() => set({ attacks: false })}>
            なし
          </button>
        </div>
      </div>
      <div className="rule" data-off={!st.attacks}>
        <span>攻撃先</span>
        <div className="seg" role="group">
          <button aria-pressed={st.targeting === 'random'} onClick={() => set({ targeting: 'random' })}>
            ランダム
          </button>
          <button aria-pressed={st.targeting === 'roundRobin'} onClick={() => set({ targeting: 'roundRobin' })}>
            順番
          </button>
        </div>
      </div>
      <div className="rule" data-off={!st.attacks}>
        <span>攻撃の強さ</span>
        <div className="seg" role="group">
          {[50, 100, 150].map((v) => (
            <button key={v} aria-pressed={st.attackPercent === v} onClick={() => set({ attackPercent: v })}>
              {v}%
            </button>
          ))}
        </div>
      </div>
      <div className="rule">
        <span>最大人数</span>
        <div className="seg" role="group">
          {[4, 8, 12, 16].map((v) => (
            <button
              key={v}
              aria-pressed={st.maxPlayers === v}
              disabled={v < room.players.length}
              onClick={() => set({ maxPlayers: v })}
            >
              {v}人
            </button>
          ))}
        </div>
      </div>
    </fieldset>
  );
}

// ================================================================= arena

interface Layout {
  cell: number;
  mini: number;
  left: string[];
  right: string[];
  colsL: number;
  colsR: number;
}

/** Split opponents into two side columns and size their boards to fit. */
function computeLayout(vw: number, vh: number, opponents: string[]): Layout {
  let cell = boardCell(vh);
  const half = Math.ceil(opponents.length / 2);
  const left = opponents.slice(0, half);
  const right = opponents.slice(half);
  const availH = vh - 52 - 40;
  const fit = (n: number, sideW: number) => {
    if (!n) return { mini: 0, cols: 1 };
    let best = { mini: 0, cols: 1 };
    for (let cols = 1; cols <= 3; cols++) {
      const rows = Math.ceil(n / cols);
      const byH = Math.floor((availH - rows * 44) / (rows * VISIBLE_H));
      const byW = Math.floor((sideW - (cols - 1) * 12) / cols / 10);
      const m = Math.min(byH, byW, 18);
      if (m > best.mini) best = { mini: m, cols };
    }
    return best;
  };
  // shrink the main board only if the opponents would get unreadably small
  for (;;) {
    const mainW = cell * 10 + 2 * Math.round(cell * 4.2) + 2 * 16 + 24;
    const sideW = Math.max(0, (vw - mainW - 48 - 32) / 2);
    const L = fit(left.length, sideW);
    const R = fit(right.length, sideW);
    const mini = Math.min(L.mini || 99, R.mini || 99);
    if (mini >= 6 || cell <= 20 || !opponents.length) {
      return { cell, mini: opponents.length ? Math.max(3, mini) : 0, left, right, colsL: L.cols, colsR: R.cols };
    }
    cell--;
  }
}

function MiniBoard({
  session,
  id,
  name,
  color,
  mini,
  target,
}: {
  session: RoomSession;
  id: string;
  name: string;
  color: string;
  mini: number;
  target?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const linesRef = useRef<HTMLSpanElement>(null);
  const koRef = useRef<HTMLDivElement>(null);
  const hitRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const c = setupCanvas(canvasRef.current!, mini * 10, mini * VISIBLE_H);
    const draw = (snap: BoardSnap | undefined) => {
      if (!snap) {
        drawMini(c, '0'.repeat(220), null, mini, true);
        return;
      }
      drawMini(c, snap.b, snap.c, mini, snap.alive || snap.place === 1);
      scoreRef.current!.textContent = snap.score.toLocaleString('ja-JP');
      linesRef.current!.textContent = `${snap.lines}ライン`;
      const root = rootRef.current!;
      root.dataset.out = String(!snap.alive && snap.place !== null && snap.place !== 1);
      root.dataset.pending = String(snap.pending > 0);
      if (snap.place !== null) koRef.current!.textContent = `${snap.place}位`;
    };
    draw(session.boards.get(id));
    const offB = session.onBoards((list) => {
      for (const s of list) if (s.id === id) draw(s);
    });
    let hitTimer = 0;
    const offE = session.onEvent((e) => {
      if (e.k === 'attack' && e.to === id) {
        const root = rootRef.current!;
        hitRef.current!.textContent = `+${e.lines}`;
        root.classList.remove('hit');
        void root.offsetWidth;
        root.classList.add('hit');
        clearTimeout(hitTimer);
        hitTimer = window.setTimeout(() => root.classList.remove('hit'), 700);
      }
    });
    return () => {
      offB();
      offE();
      clearTimeout(hitTimer);
    };
  }, [session, id, mini]);

  const small = mini < 9;
  return (
    <div className="mini" ref={rootRef} data-small={small} data-target={target}>
      <div className="mini-head">
        <span className="mini-name" style={{ ['--seat' as string]: color }}>
          {name}
        </span>
        {!small && <span className="num mini-score" ref={scoreRef} />}
        {small && <span hidden ref={scoreRef} />}
      </div>
      <div className="mini-board">
        <canvas ref={canvasRef} />
        <div className="mini-ko num" ref={koRef} />
        <span className="mini-hit num" ref={hitRef} />
      </div>
      <span className="mini-lines num" ref={linesRef} />
    </div>
  );
}

function OpponentColumn({
  ids,
  cols,
  mini,
  session,
  room,
  participants,
}: {
  ids: string[];
  cols: number;
  mini: number;
  session: RoomSession;
  room: RoomView;
  /** names as they were at match start (room.match is cleared once the match ends) */
  participants: { id: string; name: string }[];
}) {
  const names = new Map(participants.map((p) => [p.id, p.name]));
  return (
    <div className="opp-col" style={{ gridTemplateColumns: `repeat(${cols}, ${mini * 10}px)` }}>
      {ids.map((id) => (
        <MiniBoard key={id} session={session} id={id} name={names.get(id) ?? '?'} color={seatColor(room, id)} mini={mini} />
      ))}
    </div>
  );
}

/** Shown to everyone while a match is paused; ticks down the resume timers. */
function PausePanel({ session, s, pause }: { session: RoomSession; s: SessionState; pause: PauseInfo }) {
  const [now, setNow] = useState(() => session.conn.serverNow());
  const [confirmLeave, setConfirmLeave] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(session.conn.serverNow()), 200);
    return () => clearInterval(t);
  }, [session]);
  const mine = pause.by === s.you;
  return (
    <div className="board-panel">
      <h2>一時停止中</h2>
      <p className="muted">{mine ? 'あなたが対戦を止めました。全員止まっています。' : `${pause.name}さんが対戦を止めました。全員止まっています。`}</p>
      {pause.resumeAt !== null ? (
        <p className="muted">あと {Math.max(0, Math.ceil((pause.resumeAt - now) / 1000))} 秒で再開します。</p>
      ) : (
        <p className="muted">あと約 {Math.max(0, Math.ceil((pause.at + PAUSE_LIMIT_MS - now) / 1000))} 秒で自動的に再開します。</p>
      )}
      <div className="dialog-actions">
        {mine && pause.resumeAt === null && (
          <button className="btn btn-primary" autoFocus onClick={() => session.resume()}>
            再開する
          </button>
        )}
        {confirmLeave ? (
          <button
            className="btn btn-danger"
            onClick={() => {
              session.leave();
              navigate('/');
            }}
          >
            本当に退出する（脱落扱い）
          </button>
        ) : (
          <button className="btn" onClick={() => setConfirmLeave(true)}>
            部屋から退出する
          </button>
        )}
      </div>
    </div>
  );
}

function Arena({ session, s, room }: { session: RoomSession; s: SessionState; room: RoomView }) {
  const vp = useViewport();
  const runnerRef = useRef(s.runner!);
  runnerRef.current = s.runner!;
  const source = useMemo(() => onlineSource(() => runnerRef.current, session.conn), [session]);
  const [menu, setMenu] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const info = s.runner?.info.participants ?? [];
  const participants = info.map((p) => p.id).filter((id) => id !== s.you);
  const layout = computeLayout(vp.w, vp.h, participants);
  const out = s.myPlace !== null;
  const pause = room.pause;

  useEffect(
    () =>
      session.onEvent((e) => {
        if (e.k === 'ko' && e.id === s.you) sfx.ko();
        else if (e.k === 'ko') sfx.warn();
        if (e.k === 'end' && e.results[0]?.id === s.you) sfx.win();
      }),
    [session, s.you],
  );

  return (
    <div className="arena">
      <OpponentColumn ids={layout.left} cols={layout.colsL} mini={layout.mini} session={session} room={room} participants={info} />
      <GameView
        source={source}
        cell={layout.cell}
        onMenu={() => !s.results && setMenu((m) => !m)}
        inputEnabled={!out && !s.results && !pause}
        onController={(k) => (session.keyboard = k)}
      >
        {out && !s.results && (
          <div className="board-panel board-panel-ko">
            <div className="ko-place num">{s.myPlace}位</div>
            <p>脱落しました。ほかのプレイヤーの対戦を観戦しています。</p>
          </div>
        )}
        {pause && !s.results && <PausePanel session={session} s={s} pause={pause} />}
        {menu && !pause && !s.results && (
          <div className="board-panel">
            <h2>メニュー</h2>
            <p className="muted">一時停止すると、対戦相手全員が止まります。</p>
            <div className="dialog-actions">
              <button
                className="btn btn-primary"
                autoFocus
                onClick={() => {
                  setMenu(false);
                  session.pause();
                }}
              >
                みんなで一時停止する
              </button>
              <button className="btn" onClick={() => setMenu(false)}>
                対戦に戻る
              </button>
              {confirmLeave ? (
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    session.leave();
                    navigate('/');
                  }}
                >
                  本当に退出する（脱落扱い）
                </button>
              ) : (
                <button className="btn" onClick={() => setConfirmLeave(true)}>
                  部屋から退出する
                </button>
              )}
            </div>
          </div>
        )}
      </GameView>
      <OpponentColumn ids={layout.right} cols={layout.colsR} mini={layout.mini} session={session} room={room} participants={info} />
      {s.results && <Results results={s.results} you={s.you} room={room} session={session} />}
    </div>
  );
}

function Spectate({ session, room }: { session: RoomSession; room: RoomView }) {
  const vp = useViewport();
  const ids = room.match?.participants.map((p) => p.id) ?? [];
  const availH = vp.h - 52 - 120;
  let best = { mini: 4, cols: 1 };
  for (let cols = 1; cols <= 8; cols++) {
    const rows = Math.ceil(ids.length / cols);
    const m = Math.min(Math.floor((availH - rows * 44) / (rows * VISIBLE_H)), Math.floor((vp.w - 96 - cols * 16) / cols / 10), 22);
    if (m > best.mini) best = { mini: m, cols };
  }
  return (
    <div className="spectate">
      <p className="spectate-note">
        {room.pause
          ? `一時停止中です（${room.pause.name}さんが止めました）。再開までお待ちください。`
          : '対戦中です。この対戦が終わると、次の対戦から参加できます。'}
      </p>
      <OpponentColumn
        ids={ids}
        cols={best.cols}
        mini={best.mini}
        session={session}
        room={room}
        participants={room.match?.participants ?? []}
      />
    </div>
  );
}

// ================================================================= results

function fmtSurvived(ticks: number) {
  const s = Math.floor(ticks / 60);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Results({ results, you, room, session }: { results: ResultRow[]; you: string; room: RoomView; session: RoomSession }) {
  const winner = results[0];
  const me = room.players.find((p) => p.id === you);
  const mine = results.find((r) => r.id === you);
  const back = (ready: boolean) => {
    if (ready && !me?.host) session.setReady(true);
    session.dismissResults();
  };
  return (
    <div className="overlay results-overlay">
      <div className="results" role="dialog" aria-label="最終順位">
        <header className="results-head">
          <span className="label">優勝</span>
          <div className="results-winner" style={{ ['--seat' as string]: seatColor(room, winner.id) }}>
            {winner.name}
          </div>
          {mine && <p className="muted">あなたは {mine.place}位 でした。</p>}
        </header>
        <table className="results-table">
          <thead>
            <tr>
              <th>順位</th>
              <th>プレイヤー</th>
              <th className="r">スコア</th>
              <th className="r">ライン</th>
              <th className="r">攻撃</th>
              <th className="r">生存</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id} data-me={r.id === you} data-win={r.place === 1}>
                <td className="num place">{r.place}</td>
                <td>
                  <span className="chip" style={{ background: seatColor(room, r.id) }} aria-hidden />
                  {r.name}
                  {r.reason === 'disconnect' && <span className="muted"> （切断）</span>}
                  {r.reason === 'left' && <span className="muted"> （退出）</span>}
                </td>
                <td className="num r">{r.score.toLocaleString('ja-JP')}</td>
                <td className="num r">{r.lines}</td>
                <td className="num r">{r.attack}</td>
                <td className="num r">{fmtSurvived(r.survived)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="results-actions">
          {me?.host ? (
            <button className="btn btn-primary" autoFocus onClick={() => back(false)}>
              ロビーに戻って再戦する
            </button>
          ) : (
            <>
              <button className="btn btn-primary" autoFocus onClick={() => back(true)}>
                再戦の準備をする
              </button>
              <button className="btn btn-quiet" onClick={() => back(false)}>
                ロビーに戻る
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
