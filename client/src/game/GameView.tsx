// The player's own field: hold, board, next queue and stats. Everything inside
// is drawn/updated imperatively from one requestAnimationFrame loop — React only
// mounts it, so a running game causes zero React renders.

import { useEffect, useRef, type ReactNode } from 'react';
import { Input, type Game, type GameEvent } from '../../../shared/engine/game';
import { SHAPES } from '../../../shared/engine/pieces';
import { HIDDEN_H, NEXT_COUNT, TICK_RATE, VISIBLE_H } from '../../../shared/engine/rules';
import { sfx } from './audio';
import { KeyboardController } from './input';
import { TOP_ROWS, drawMainBoard, drawPiece, inDanger, newFx, setupCanvas } from './render';

export interface GameSource {
  game(): Game;
  /** advance the simulation to "now" */
  frame(now: number): void;
  input(code: number): void;
  /** ms until play begins (countdown), or <= 0 once running */
  countdownMs(): number;
  paused(): boolean;
}

interface Props {
  source: GameSource;
  cell: number;
  onMenu: () => void;
  /** disable keyboard (menus open, knocked out) */
  inputEnabled: boolean;
  /** extra overlay content on the board */
  children?: ReactNode;
  /** receives the keyboard controller so online play can re-press held keys after resync */
  onController?: (k: KeyboardController | null) => void;
  /** game events for the parent (e.g. game over in solo) */
  onEvent?: (e: GameEvent) => void;
  showMeter?: boolean;
}

const LINE_NAMES = ['', 'シングル', 'ダブル', 'トリプル', '4ライン'];

function describe(e: Extract<GameEvent, { k: 'clear' }>): { main: string; sub: string[] } {
  let main = '';
  if (e.spin === 'full') main = `Tスピン${e.lines ? ' ' + LINE_NAMES[e.lines] : ''}`;
  else if (e.spin === 'mini') main = `Tスピン ミニ${e.lines ? ' ' + LINE_NAMES[e.lines] : ''}`;
  else main = LINE_NAMES[e.lines];
  const sub: string[] = [];
  if (e.b2b) sub.push('連続ボーナス');
  if (e.combo >= 1) sub.push(`${e.combo} コンボ`);
  if (e.pc) sub.push('全消し');
  return { main, sub };
}

function fmtTime(ticks: number) {
  const s = Math.max(0, Math.floor(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GameView({ source, cell, onMenu, inputEnabled, children, onController, onEvent, showMeter = true }: Props) {
  const boardRef = useRef<HTMLCanvasElement>(null);
  const holdRef = useRef<HTMLCanvasElement>(null);
  const nextRef = useRef<HTMLCanvasElement>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  const statRefs = {
    score: useRef<HTMLElement>(null),
    lines: useRef<HTMLElement>(null),
    level: useRef<HTMLElement>(null),
    time: useRef<HTMLElement>(null),
  };
  const kbRef = useRef<KeyboardController | null>(null);
  const live = useRef({ source, onMenu, onEvent, inputEnabled });
  live.current = { source, onMenu, onEvent, inputEnabled };

  useEffect(() => {
    if (kbRef.current) kbRef.current.enabled = inputEnabled;
  }, [inputEnabled]);

  useEffect(() => {
    const board = setupCanvas(boardRef.current!, cell * 10, cell * (VISIBLE_H + TOP_ROWS));
    const side = Math.round(cell * 4.2);
    const small = Math.round(cell * 0.82);
    const hold = setupCanvas(holdRef.current!, side, Math.round(cell * 3));
    const nextH = Math.round(cell * 3) + (NEXT_COUNT - 1) * Math.round(small * 2.6);
    const next = setupCanvas(nextRef.current!, side, nextH);
    const fx = newFx();
    let raf = 0;
    let drawnHold = '';
    let drawnNext = '';
    let lastStats = '';
    let lastCount = '';
    let actionTimer = 0;
    let lastGame: Game | null = null;

    const kb = new KeyboardController(
      (code) => {
        const g = live.current.source.game();
        if (code === Input.HardDrop && g.cur && !g.over && live.current.source.countdownMs() <= 0) {
          const cells = SHAPES[g.cur.p][g.cur.r];
          const xs = cells.map(([x]) => g.cur!.x + x);
          const ys = cells.map(([, y]) => g.cur!.y + y);
          const d = g.dropDistance();
          fx.trail = {
            x0: Math.min(...xs),
            x1: Math.max(...xs),
            yTop: Math.max(HIDDEN_H - TOP_ROWS, Math.min(...ys)),
            yBot: Math.max(...ys) + d + 1,
            color: g.cur.p,
            at: performance.now(),
          };
        }
        sfx.unlock();
        live.current.source.input(code);
      },
      () => live.current.onMenu(),
    );
    kb.enabled = live.current.inputEnabled;
    kbRef.current = kb;
    onController?.(kb);

    const showAction = (main: string, sub: string[], tone: 'normal' | 'big' = 'normal') => {
      const el = actionRef.current!;
      el.innerHTML = '';
      const m = document.createElement('div');
      m.className = 'action-main';
      m.textContent = main;
      el.appendChild(m);
      for (const s of sub) {
        const d = document.createElement('div');
        d.className = 'action-sub';
        d.textContent = s;
        el.appendChild(d);
      }
      el.dataset.tone = tone;
      el.classList.remove('show');
      void el.offsetWidth; // restart the animation
      el.classList.add('show');
      clearTimeout(actionTimer);
      actionTimer = window.setTimeout(() => el.classList.remove('show'), 1300);
    };

    const handleEvents = (g: Game, now: number) => {
      if (!g.events.length) return;
      const events = g.events;
      g.events = [];
      for (const e of events) {
        switch (e.k) {
          case 'move':
            sfx.move();
            break;
          case 'rotate':
            sfx.rotate();
            break;
          case 'hold':
            sfx.hold();
            break;
          case 'lock':
            if (e.hard) {
              fx.shakeAt = now;
              sfx.hard();
            } else sfx.lock();
            break;
          case 'clear': {
            if (e.lines) fx.flash = { rows: e.rows.map((r) => r - HIDDEN_H), at: now };
            const d = describe(e);
            if (e.lines >= 2 || e.spin !== 'none' || e.combo >= 1 || e.pc)
              showAction(d.main, d.sub, e.lines === 4 || e.spin === 'full' || e.pc ? 'big' : 'normal');
            sfx.clear(e.lines, e.spin !== 'none' || e.pc);
            break;
          }
          case 'garbageIn':
            sfx.garbage();
            break;
          case 'level':
            if (e.level > 1) showAction(`レベル ${e.level}`, []);
            break;
          case 'over':
            break;
        }
        live.current.onEvent?.(e);
      }
    };

    const drawSide = (g: Game) => {
      const holdKey = `${g.hold}:${g.holdUsed}`;
      if (holdKey !== drawnHold) {
        drawnHold = holdKey;
        const { ctx, canvas, dpr } = hold;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (g.hold) drawPiece(ctx, g.hold, canvas.width / 2, canvas.height / 2, Math.round(cell * 0.9 * dpr), g.holdUsed ? 8 : g.hold);
      }
      const q = g.next;
      const nextKey = q.join('');
      if (nextKey !== drawnNext) {
        drawnNext = nextKey;
        const { ctx, canvas, dpr } = next;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const firstH = Math.round(cell * 3) * dpr;
        drawPiece(ctx, q[0], canvas.width / 2, firstH / 2, Math.round(cell * 0.9 * dpr));
        const step = Math.round(small * 2.6) * dpr;
        for (let i = 1; i < q.length; i++) {
          drawPiece(ctx, q[i], canvas.width / 2, firstH + (i - 1) * step + step / 2, Math.round(small * 0.85 * dpr));
        }
      }
    };

    const drawStats = (g: Game) => {
      const key = `${g.score}|${g.lines}|${g.level}|${Math.floor(g.tick / TICK_RATE)}`;
      if (key === lastStats) return;
      lastStats = key;
      statRefs.score.current!.textContent = g.score.toLocaleString('ja-JP');
      statRefs.lines.current!.textContent = String(g.lines);
      statRefs.level.current!.textContent = String(g.level);
      statRefs.time.current!.textContent = fmtTime(g.tick);
    };

    const drawCountdown = (ms: number) => {
      const el = countRef.current!;
      let label = '';
      if (ms > 0 && ms <= 3000) label = String(Math.ceil(ms / 1000));
      else if (ms <= 0 && ms > -700) label = 'スタート';
      else if (ms > 3000 && ms < 99999) label = '準備';
      if (label === lastCount) return;
      if (label && label !== '準備') sfx.count(label === 'スタート');
      lastCount = label;
      el.textContent = label;
      el.dataset.word = String(label.length > 1);
      el.classList.remove('pop');
      void el.offsetWidth;
      if (label) el.classList.add('pop');
    };

    const frame = () => {
      const now = performance.now();
      const src = live.current.source;
      src.frame(Date.now());
      const g = src.game();
      if (g !== lastGame) {
        // new game instance (restart or resync): drop transient effects
        lastGame = g;
        fx.flash = null;
        fx.trail = null;
        drawnHold = drawnNext = '';
      }
      handleEvents(g, now);
      fx.danger = inDanger(g) && !g.over;
      drawMainBoard(board, g, cell, fx, now, g.over === 'topout');
      drawSide(g);
      drawStats(g);
      if (meterRef.current) {
        const n = Math.min(VISIBLE_H, g.pendingLines);
        meterRef.current.style.transform = `scaleY(${n / VISIBLE_H})`;
      }
      drawCountdown(src.paused() ? 99999 : src.countdownMs());
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // rAF stops in background tabs; keep the simulation (and network batches) moving.
    const bg = window.setInterval(() => {
      if (document.hidden) {
        const src = live.current.source;
        src.frame(Date.now());
        const g = src.game();
        g.events = [];
      }
    }, 250);

    return () => {
      cancelAnimationFrame(raf);
      clearInterval(bg);
      clearTimeout(actionTimer);
      kb.dispose();
      kbRef.current = null;
      onController?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell]);

  const side = Math.round(cell * 4.2);
  return (
    <div className="play" style={{ ['--cell' as string]: `${cell}px` }}>
      <div className="play-side play-left" style={{ width: side }}>
        <section className="slot">
          <h3 className="slot-label">ホールド</h3>
          <canvas ref={holdRef} />
        </section>
        <dl className="stats">
          <div>
            <dt>スコア</dt>
            <dd className="num stat-score" ref={statRefs.score as never}>0</dd>
          </div>
          <div>
            <dt>ライン</dt>
            <dd className="num" ref={statRefs.lines as never}>0</dd>
          </div>
          <div>
            <dt>レベル</dt>
            <dd className="num" ref={statRefs.level as never}>1</dd>
          </div>
          <div>
            <dt>タイム</dt>
            <dd className="num" ref={statRefs.time as never}>0:00</dd>
          </div>
        </dl>
      </div>
      <div className="play-well">
        {showMeter && (
          <div className="gmeter" aria-label="受けるおじゃまライン">
            <div className="gmeter-fill" ref={meterRef} />
          </div>
        )}
        <div className="board-wrap">
          <canvas ref={boardRef} className="board-canvas" />
          <div className="board-overlay">
            <div className="countdown num" ref={countRef} />
            <div className="action" ref={actionRef} />
            {children}
          </div>
        </div>
      </div>
      <div className="play-side play-right" style={{ width: side }}>
        <section className="slot">
          <h3 className="slot-label">ネクスト</h3>
          <canvas ref={nextRef} />
        </section>
      </div>
    </div>
  );
}
