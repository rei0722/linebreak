// The player's own field: hold, board, next queue and stats. Everything inside
// is drawn/updated imperatively from one requestAnimationFrame loop — React only
// mounts it, so a running game causes zero React renders.

import { useEffect, useRef, type ReactNode } from 'react';
import { Input, type Game, type GameEvent } from '../../../shared/engine/game';
import { SHAPES } from '../../../shared/engine/pieces';
import { HIDDEN_H, NEXT_COUNT, TICK_RATE, VISIBLE_H } from '../../../shared/engine/rules';
import { hiScore } from '../prefs';
import { usePrefs } from '../ui';
import { sfx } from './audio';
import { fx as fxe, type Box } from './fx';
import { KeyboardController } from './input';
import { warmNeon } from './neon';
import { TOP_ROWS, currentDesign, drawMainBoard, drawPiece, inDanger, newFx, palette, setupCanvas } from './render';

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
  /** which personal best this field counts toward */
  mode?: 'solo' | 'battle';
  /** extra content under the left-hand stats (incoming-attack list) */
  leftExtra?: ReactNode;
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

const LINE_NAMES_EN = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'LINEBREAK!'];

function describeEn(e: Extract<GameEvent, { k: 'clear' }>, battle: boolean): { main: string; sub: string[] } {
  let main = LINE_NAMES_EN[e.lines];
  if (e.spin === 'full') main = `T-SPIN${e.lines ? ' ' + LINE_NAMES_EN[Math.min(3, e.lines)] : ''}`;
  else if (e.spin === 'mini') main = `T-SPIN MINI${e.lines ? ' ' + LINE_NAMES_EN[Math.min(3, e.lines)] : ''}`;
  const sub: string[] = [];
  if (e.b2b) sub.push('BACK-TO-BACK');
  if (e.combo >= 1) sub.push(`${e.combo} COMBO`);
  if (e.pc) sub.push('PERFECT CLEAR');
  if (battle && e.sent > 0) sub.push(`ATTACK +${e.sent}`);
  return { main, sub };
}

const SPARK = ['#2ee6ff', '#ff3df0', '#d8f4ff'];
/** HIGH-quality particle totals for 1..4 lines */
const CLEAR_PARTICLES = [0, 16, 40, 84, 170];

function fmtTime(ticks: number) {
  const s = Math.max(0, Math.floor(ticks / TICK_RATE));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function GameView({
  source,
  cell,
  onMenu,
  inputEnabled,
  children,
  onController,
  onEvent,
  showMeter = true,
  mode = 'solo',
  leftExtra,
}: Props) {
  const neon = usePrefs().design === 'neon';
  const boardRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLDivElement>(null);
  const score2Ref = useRef<HTMLElement>(null);
  const hiRef = useRef<HTMLElement>(null);
  const emitRef = useRef<(code: number) => void>(() => {});
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
    // pay for sprite baking now, during the countdown, not on the first piece or first clear
    const warm = () => {
      if (currentDesign() !== 'neon') return;
      warmNeon(Math.round(cell * board.dpr));
      fxe.warm([...SPARK, '#ff3d7f', ...palette().slice(1)]);
    };
    warm();
    let raf = 0;
    let drawnHold = '';
    let drawnNext = '';
    let lastStats = '';
    let lastCount = '';
    let actionTimer = 0;
    let lastGame: Game | null = null;
    let lastNow = 0;
    let lastDesign = currentDesign();
    let lastDanger = false;
    let lastCombo = -2;
    let hi = hiScore.get(mode);
    let hiDirty = false;
    /** where the active piece was at the end of the last frame: [cells, colour] */
    let lastPiece: { cells: [number, number][]; p: number } | null = null;
    /** landing cells captured at the moment of a hard drop */
    let hardLand: { cells: [number, number][]; p: number } | null = null;

    /** The well (20 visible rows) in viewport coordinates. Read on events only, never per frame. */
    const wellBox = (): Box => {
      const r = boardRef.current!.getBoundingClientRect();
      return { left: r.left, top: r.top + TOP_ROWS * cell, right: r.right, bottom: r.bottom };
    };

    const emit = (code: number) => {
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
        hardLand = { cells: cells.map(([x, y]) => [g.cur!.x + x, g.cur!.y + y + d]), p: g.cur.p };
      }
      sfx.unlock();
      live.current.source.input(code);
    };
    emitRef.current = (code) => {
      if (live.current.inputEnabled) emit(code);
    };

    const kb = new KeyboardController(emit, () => live.current.onMenu());
    kb.enabled = live.current.inputEnabled;
    kbRef.current = kb;
    // dev-only handle for browser tests and the perf readout (stripped from production builds)
    if (import.meta.env.DEV) {
      const w = window as never as { __lb?: object };
      w.__lb = { ...w.__lb, game: () => live.current.source.game(), fx: fxe };
    }
    onController?.(kb);

    const showAction = (main: string, sub: string[], tone: 'normal' | 'big' | 'quad' = 'normal') => {
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

    const saveHi = () => {
      if (hiDirty) hiScore.set(mode, hi);
      hiDirty = false;
    };

    /** Sparks and shockwaves for a line clear (neon skin). Scales with lines and combo. */
    const clearBurst = (rows: number[], lines: number, power: number) => {
      if (!fxe.active) return;
      const box = wellBox();
      const w = box.right - box.left;
      const cx = (box.left + box.right) / 2;
      const per = (CLEAR_PARTICLES[lines] * power) / rows.length;
      let midY = 0;
      for (const r of rows) {
        if (r < 0) continue;
        const y = box.top + (r + 0.5) * cell;
        midY += y / rows.length;
        fxe.burst(cx, y, SPARK[0], per * 0.5, { jitter: w, angle: -Math.PI / 2, spread: Math.PI * 1.5, speed: 150 + lines * 70 });
        fxe.burst(cx, y, SPARK[1], per * 0.3, { jitter: w, angle: -Math.PI / 2, spread: Math.PI * 2, speed: 120 + lines * 60 });
        fxe.burst(box.left, y, SPARK[2], per * 0.1, { angle: Math.PI, spread: 1.6, speed: 220 + lines * 50, gravity: 200 });
        fxe.burst(box.right, y, SPARK[2], per * 0.1, { angle: 0, spread: 1.6, speed: 220 + lines * 50, gravity: 200 });
      }
      if (!midY) return;
      if (lines === 2) fxe.ring(cx, midY, SPARK[0], cell * 5, 360, 2.5);
      else if (lines === 3) {
        fxe.ring(cx, midY, SPARK[0], cell * 7, 420, 3);
        fxe.boxWave(box, SPARK[0], cell * 1.1, 420, 2.5);
      } else if (lines >= 4) {
        fxe.ring(cx, midY, SPARK[2], cell * 10, 520, 4);
        fxe.boxWave(box, SPARK[1], cell * 2.4, 560, 4);
        fxe.boxWave(box, SPARK[0], cell * 1.3, 400, 3);
      }
    };

    const handleEvents = (g: Game, now: number) => {
      if (!g.events.length) return;
      const events = g.events;
      g.events = [];
      const isNeon = currentDesign() === 'neon';
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
          case 'lock': {
            if (e.hard) {
              fx.shakeAt = now;
              sfx.hard();
            } else sfx.lock();
            const land = (e.hard && hardLand) || lastPiece;
            hardLand = null;
            if (isNeon && land) {
              fx.lock = { cells: land.cells, at: now };
              if (fxe.level > 0 && fxe.active) {
                // sparks kicked up from under the piece
                const box = wellBox();
                let x = 0;
                let yMax = 0;
                for (const [cx, cy] of land.cells) {
                  x += cx + 0.5;
                  yMax = Math.max(yMax, cy + 1);
                }
                fxe.burst(box.left + (x / land.cells.length) * cell, box.top + (yMax - HIDDEN_H) * cell, palette()[land.p], e.hard ? 12 : 5, {
                  angle: -Math.PI / 2,
                  spread: Math.PI * 0.9,
                  speed: e.hard ? 170 : 90,
                  ttl: 0.32,
                  size: 2,
                  jitter: cell * 2,
                });
              }
            }
            break;
          }
          case 'clear': {
            if (e.lines) {
              const rows = e.rows.map((r) => r - HIDDEN_H);
              const power = 1 + Math.min(8, Math.max(0, e.combo)) * 0.1;
              fx.flash = { rows, at: now };
              fx.clear = { rows, lines: e.lines, at: now, power };
              fx.lock = null;
              if (isNeon) clearBurst(rows, e.lines, power);
            }
            const d = isNeon ? describeEn(e, mode === 'battle') : describe(e);
            if (e.lines >= 2 || e.spin !== 'none' || e.combo >= 1 || e.pc)
              showAction(
                d.main,
                d.sub,
                isNeon && e.lines === 4 ? 'quad' : e.lines === 4 || e.spin === 'full' || e.pc ? 'big' : 'normal',
              );
            if (isNeon && e.lines === 4) sfx.quad();
            else sfx.clear(e.lines, e.spin !== 'none' || e.pc);
            if (isNeon && e.combo >= 1) sfx.combo(e.combo);
            break;
          }
          case 'garbageIn': {
            sfx.garbage();
            fx.garbage = { lines: e.lines, at: now };
            // impact: a wave around the board, debris along the floor
            const box = wellBox();
            fxe.boxWave(box, '#ff3d7f', 14 + Math.min(8, e.lines) * 4, 380, 3);
            fxe.burst((box.left + box.right) / 2, box.bottom, '#ff3d7f', 8 + e.lines * 6, {
              jitter: box.right - box.left,
              angle: -Math.PI / 2,
              spread: Math.PI * 0.8,
              speed: 200,
              ttl: 0.4,
            });
            break;
          }
          case 'level':
            if (e.level > 1) showAction(isNeon ? `LEVEL ${e.level}` : `レベル ${e.level}`, []);
            break;
          case 'over':
            saveHi();
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
      if (g.combo !== lastCombo) {
        lastCombo = g.combo;
        const el = comboRef.current!;
        el.dataset.on = String(g.combo >= 1);
        if (g.combo >= 1) {
          el.lastElementChild!.textContent = String(g.combo);
          el.dataset.heat = String(Math.min(3, Math.floor(g.combo / 3)));
          el.classList.remove('bump');
          void el.offsetWidth;
          el.classList.add('bump');
        }
      }
      const key = `${g.score}|${g.lines}|${g.level}|${Math.floor(g.tick / TICK_RATE)}`;
      if (key === lastStats) return;
      lastStats = key;
      if (g.score > hi) {
        hi = g.score;
        hiDirty = true;
      }
      const score = g.score.toLocaleString('ja-JP');
      statRefs.score.current!.textContent = score;
      score2Ref.current!.textContent = score;
      hiRef.current!.textContent = hi.toLocaleString('ja-JP');
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
      // React detaches refs before this effect's cleanup runs; skip the frame in that gap
      if (!comboRef.current || !wrapRef.current || !statRefs.score.current) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const now = performance.now();
      const src = live.current.source;
      src.frame(Date.now());
      const g = src.game();
      if (lastNow) fxe.noteFrame(now - lastNow);
      lastNow = now;
      if (g !== lastGame) {
        // new game instance (restart or resync): drop transient effects
        lastGame = g;
        fx.flash = fx.clear = fx.lock = fx.garbage = null;
        fx.trail = null;
        lastPiece = hardLand = null;
        drawnHold = drawnNext = lastStats = '';
        saveHi();
      }
      const d = currentDesign();
      if (d !== lastDesign) {
        // skin switched mid-game: repaint the cached side panels, keep everything else
        lastDesign = d;
        drawnHold = drawnNext = '';
        warm();
      }
      fx.quality = fxe.level;
      fx.reduced = fxe.reduced;
      handleEvents(g, now);
      fx.danger = inDanger(g) && !g.over;
      if (fx.danger !== lastDanger) {
        lastDanger = fx.danger;
        wrapRef.current!.dataset.danger = String(fx.danger);
      }
      drawMainBoard(board, g, cell, fx, now, g.over === 'topout');
      lastPiece = g.cur
        ? { cells: SHAPES[g.cur.p][g.cur.r].map(([x, y]) => [g.cur!.x + x, g.cur!.y + y]), p: g.cur.p }
        : null;
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
      saveHi();
      emitRef.current = () => {};
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
          <h3 className="slot-label">{neon ? 'HOLD' : 'ホールド'}</h3>
          <canvas ref={holdRef} />
        </section>
        <dl className="stats">
          <div className="stat-score-left">
            <dt>スコア</dt>
            <dd className="num stat-score" ref={statRefs.score as never}>0</dd>
          </div>
          <div className="stat-lines">
            <dt>{neon ? 'LINES' : 'ライン'}</dt>
            <dd className="num" ref={statRefs.lines as never}>0</dd>
          </div>
          <div className="stat-level">
            <dt>{neon ? 'LEVEL' : 'レベル'}</dt>
            <dd className="num" ref={statRefs.level as never}>1</dd>
          </div>
          <div className="stat-time">
            <dt>{neon ? 'TIME' : 'タイム'}</dt>
            <dd className="num" ref={statRefs.time as never}>0:00</dd>
          </div>
        </dl>
        <div className="combo-box" ref={comboRef} data-on="false">
          <span>COMBO</span>
          <b className="num">0</b>
        </div>
        {leftExtra}
      </div>
      <div className="play-well">
        {showMeter && (
          <div className="gmeter" aria-label="受けるおじゃまライン">
            <div className="gmeter-fill" ref={meterRef} />
          </div>
        )}
        <div className="board-wrap" ref={wrapRef} data-danger="false">
          <div className="board-frame" aria-hidden />
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
          <h3 className="slot-label">{neon ? 'NEXT' : 'ネクスト'}</h3>
          <canvas ref={nextRef} />
        </section>
        <dl className="stats stats-right">
          <div>
            <dt>SCORE</dt>
            <dd className="num stat-score" ref={score2Ref as never}>0</dd>
          </div>
          <div>
            <dt>HI-SCORE</dt>
            <dd className="num" ref={hiRef as never}>0</dd>
          </div>
        </dl>
      </div>
      <TouchPad emit={emitRef} onMenu={onMenu} />
    </div>
  );
}

// On-screen controls for touch devices (hidden by CSS unless the pointer is coarse).
const TOUCH: { cls: string; label: string; aria: string; down: number; up?: number }[] = [
  { cls: 'tp-left', label: '◀', aria: '左に移動', down: Input.LeftDown, up: Input.LeftUp },
  { cls: 'tp-right', label: '▶', aria: '右に移動', down: Input.RightDown, up: Input.RightUp },
  { cls: 'tp-soft', label: '▼', aria: 'ソフトドロップ', down: Input.SoftDown, up: Input.SoftUp },
  { cls: 'tp-hold', label: 'HOLD', aria: 'ホールド', down: Input.Hold },
  { cls: 'tp-ccw', label: '↺', aria: '左回転', down: Input.RotateCCW },
  { cls: 'tp-cw', label: '↻', aria: '右回転', down: Input.RotateCW },
  { cls: 'tp-hard', label: 'DROP', aria: 'ハードドロップ', down: Input.HardDrop },
];

function TouchPad({ emit, onMenu }: { emit: { current: (code: number) => void }; onMenu: () => void }) {
  return (
    <div className="touchpad">
      {TOUCH.map((b) => (
        <button
          key={b.cls}
          type="button"
          className={`tp ${b.cls}`}
          aria-label={b.aria}
          tabIndex={-1}
          onPointerDown={(e) => {
            e.preventDefault();
            e.currentTarget.setPointerCapture(e.pointerId);
            emit.current(b.down);
          }}
          onPointerUp={() => b.up !== undefined && emit.current(b.up)}
          onPointerCancel={() => b.up !== undefined && emit.current(b.up)}
          onContextMenu={(e) => e.preventDefault()}
        >
          {b.label}
        </button>
      ))}
      <button type="button" className="tp tp-menu" aria-label="メニュー" tabIndex={-1} onClick={onMenu}>
        ≡
      </button>
    </div>
  );
}
