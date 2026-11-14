// NEON CYBER ARENA skin: canvas drawing only. Reads game state, never writes it.
//
// Cost model: every glow is baked once into a sprite (shadowBlur runs at sprite
// creation, never per frame). The settled stack is cached in a layer that is
// rebuilt only when the board contents change, so a normal frame is
// background + stack layer + the active piece.

import { SHAPES } from '../../../shared/engine/pieces';
import { BOARD_W, HIDDEN_H, VISIBLE_H } from '../../../shared/engine/rules';
import type { Game } from '../../../shared/engine/game';
import type { BoardFx, Canvas2D } from './render';

export const NEON = ['', '#2ee6ff', '#ffe14a', '#b65cff', '#3dff7a', '#ff3d7f', '#4d7dff', '#ff9a2e', '#6f7aa6'];
export const NEON_WELL = '#04060f';
const TOP = 2; // spawn rows above the well (render.ts TOP_ROWS)

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}
const rgba = (hex: string, a: number) => {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
/** amt < 0 darkens toward black, > 0 lightens toward white */
function mix(hex: string, amt: number, a = 1): string {
  const f = (c: number) => Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt);
  const [r, g, b] = rgb(hex);
  return `rgba(${f(r)},${f(g)},${f(b)},${a})`;
}

function make(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

// ------------------------------------------------------------------ sprites

const tiles = new Map<string, HTMLCanvasElement>();

/** Circuit traces, in unit coordinates. One layout per piece colour so shapes stay distinguishable. */
const TRACES: number[][][] = [
  [],
  [[0.28, 0.72, 0.28, 0.5, 0.72, 0.5], [0.72, 0.5, 0.72, 0.3]],
  [[0.3, 0.3, 0.7, 0.3, 0.7, 0.7], [0.3, 0.52, 0.3, 0.7]],
  [[0.5, 0.26, 0.5, 0.5, 0.74, 0.5], [0.28, 0.7, 0.5, 0.7]],
  [[0.26, 0.6, 0.48, 0.6, 0.48, 0.34, 0.74, 0.34]],
  [[0.74, 0.62, 0.52, 0.62, 0.52, 0.36, 0.26, 0.36]],
  [[0.3, 0.28, 0.3, 0.7, 0.6, 0.7], [0.6, 0.3, 0.74, 0.3]],
  [[0.7, 0.28, 0.7, 0.7, 0.4, 0.7], [0.26, 0.3, 0.4, 0.3]],
  [[0.3, 0.5, 0.7, 0.5]],
];

/** One cell. `flat` is the small variant for opponent boards. Size in device px. */
export function neonTile(color: number, size: number, flat = false): HTMLCanvasElement {
  const key = `${color}:${size}:${flat ? 1 : 0}`;
  let c = tiles.get(key);
  if (c) return c;
  let g: CanvasRenderingContext2D;
  [c, g] = make(size, size);
  const hue = NEON[color];
  const gap = size >= 14 ? 1 : 0;
  const s = size - gap;
  if (flat) {
    if (s < 5) {
      g.fillStyle = mix(hue, -0.1);
      g.fillRect(0, 0, s, s);
    } else {
      g.fillStyle = mix(hue, -0.62);
      g.fillRect(0, 0, s, s);
      g.strokeStyle = hue;
      g.lineWidth = 1;
      g.strokeRect(0.5, 0.5, s - 1, s - 1);
    }
    tiles.set(key, c);
    return c;
  }
  const garbage = color === 8;
  // glass body: dark tint of the hue, lighter toward the top-left
  const body = g.createLinearGradient(0, 0, s, s);
  body.addColorStop(0, mix(hue, garbage ? -0.62 : -0.5));
  body.addColorStop(1, mix(hue, garbage ? -0.8 : -0.78));
  g.fillStyle = body;
  g.fillRect(0, 0, s, s);
  // inner sheen
  const sheen = g.createLinearGradient(0, 0, 0, s);
  sheen.addColorStop(0, mix(hue, 0.5, garbage ? 0.08 : 0.26));
  sheen.addColorStop(0.45, mix(hue, 0, 0));
  g.fillStyle = sheen;
  g.fillRect(0, 0, s, s);
  // circuit traces (only when a cell is large enough to read them)
  if (s >= 18 && !garbage) {
    g.strokeStyle = rgba(hue, 0.5);
    g.fillStyle = rgba(hue, 0.85);
    g.lineWidth = Math.max(1, Math.round(s / 26));
    const dot = Math.max(2, Math.round(s / 11));
    for (const t of TRACES[color]) {
      g.beginPath();
      for (let i = 0; i < t.length; i += 2) {
        const x = Math.round(t[i] * s) + 0.5;
        const y = Math.round(t[i + 1] * s) + 0.5;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
      const ex = Math.round(t[t.length - 2] * s);
      const ey = Math.round(t[t.length - 1] * s);
      g.fillRect(ex - dot / 2 + 0.5, ey - dot / 2 + 0.5, dot, dot);
    }
  }
  // neon tube outline + a thin hot core on top/left
  const lw = Math.max(1, Math.round(s / 11));
  g.strokeStyle = garbage ? mix(hue, -0.1) : hue;
  g.lineWidth = lw;
  g.strokeRect(lw / 2, lw / 2, s - lw, s - lw);
  if (!garbage) {
    g.fillStyle = mix(hue, 0.7, 0.9);
    g.fillRect(lw, 0, s - lw * 2, Math.max(1, lw >> 1));
    g.fillRect(0, lw, Math.max(1, lw >> 1), s - lw * 2);
  }
  tiles.set(key, c);
  return c;
}

const halos = new Map<string, HTMLCanvasElement>();
const haloPad = (px: number) => Math.ceil(px * 0.34);

/** Soft glow behind a cell, baked once. Drawn at (x - pad, y - pad). */
function halo(color: number, px: number): HTMLCanvasElement {
  const key = `${color}:${px}`;
  let c = halos.get(key);
  if (c) return c;
  const pad = haloPad(px);
  let g: CanvasRenderingContext2D;
  [c, g] = make(px + pad * 2, px + pad * 2);
  g.shadowColor = NEON[color];
  g.shadowBlur = pad * 0.9;
  g.fillStyle = rgba(NEON[color], 0.55);
  g.fillRect(pad + 1, pad + 1, px - 3, px - 3);
  halos.set(key, c);
  return c;
}

const wells = new Map<number, HTMLCanvasElement>();

function wellLayer(px: number): HTMLCanvasElement {
  let c = wells.get(px);
  if (c) return c;
  const W = BOARD_W * px;
  const H = VISIBLE_H * px;
  let g: CanvasRenderingContext2D;
  [c, g] = make(W, H);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#081028');
  bg.addColorStop(1, NEON_WELL);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(70, 190, 255, 0.11)';
  for (let x = 1; x < BOARD_W; x++) g.fillRect(x * px, 0, 1, H);
  for (let y = 1; y < VISIBLE_H; y++) g.fillRect(0, y * px, W, 1);
  // brighter crossings, like solder points on a board
  g.fillStyle = 'rgba(120, 220, 255, 0.22)';
  for (let x = 1; x < BOARD_W; x++) for (let y = 1; y < VISIBLE_H; y++) g.fillRect(x * px - 1, y * px - 1, 3, 3);
  wells.set(px, c);
  return c;
}

/**
 * Build every sprite for this cell size up front. Baking a glow uses shadowBlur,
 * which is slow; doing it here keeps that cost out of the first frames of play.
 */
export function warmNeon(px: number) {
  wellLayer(px);
  for (let c = 1; c <= 8; c++) {
    neonTile(c, px);
    if (c !== 8) halo(c, px);
  }
}

// ------------------------------------------------------------------ stack cache

interface StackCache {
  key: string;
  layer: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
const stacks = new WeakMap<HTMLCanvasElement, StackCache>();
/** Counts stack-layer rebuilds, for the perf readout. */
export const neonStats = { stackRebuilds: 0 };

function stackLayer(c: Canvas2D, game: Game, px: number, dim: boolean, glow: boolean): StackCache {
  const first = (HIDDEN_H - TOP) * BOARD_W;
  const last = (HIDDEN_H + VISIBLE_H) * BOARD_W;
  let h = 0;
  const b = game.board;
  for (let i = first; i < last; i++) h = (Math.imul(h, 31) + b[i] + 1) | 0;
  const key = `${h}:${px}:${dim ? 1 : 0}:${glow ? 1 : 0}`;
  const pad = haloPad(px);
  let sc = stacks.get(c.canvas);
  if (!sc || sc.layer.width !== BOARD_W * px + pad * 2) {
    const [layer, ctx] = make(BOARD_W * px + pad * 2, (VISIBLE_H + TOP) * px + pad * 2);
    sc = { key: '', layer, ctx };
    stacks.set(c.canvas, sc);
  }
  if (sc.key === key) return sc;
  sc.key = key;
  neonStats.stackRebuilds++;
  const g = sc.ctx;
  g.clearRect(0, 0, sc.layer.width, sc.layer.height);
  for (let pass = glow && !dim ? 0 : 1; pass < 2; pass++) {
    for (let i = first; i < last; i++) {
      const v = b[i];
      if (!v) continue;
      const x = ((i - first) % BOARD_W) * px + pad;
      const y = (((i - first) / BOARD_W) | 0) * px + pad;
      if (pass === 0) {
        if (v !== 8) g.drawImage(halo(v, px), x - pad, y - pad);
      } else g.drawImage(neonTile(dim ? 8 : v, px), x, y);
    }
  }
  return sc;
}

// ------------------------------------------------------------------ board

export function drawNeonBoard(c: Canvas2D, game: Game, cell: number, fx: BoardFx, now: number, dim = false) {
  const { ctx, dpr } = c;
  const px = Math.round(cell * dpr);
  const W = BOARD_W * px;
  const H = VISIBLE_H * px;
  const top = TOP * px;
  const q = fx.quality;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);

  // hard-drop thump, plus a short sideways jolt on a four-line clear
  const since = now - fx.shakeAt;
  let sy = since < 90 ? Math.round((1 - since / 90) * 2 * dpr) : 0;
  let sx = 0;
  if (fx.clear && fx.clear.lines >= 4 && q > 0 && !fx.reduced) {
    const t = (now - fx.clear.at) / 260;
    if (t < 1) {
      sx = Math.round(Math.sin(t * 38) * (1 - t) * 3 * dpr);
      sy += Math.round(Math.cos(t * 31) * (1 - t) * 2 * dpr);
    }
  }
  ctx.translate(sx, sy);

  ctx.drawImage(wellLayer(px), 0, top);
  const pad = haloPad(px);
  ctx.drawImage(stackLayer(c, game, px, dim, q > 0).layer, -pad, -pad);

  const rowY = (boardY: number) => top + (boardY - HIDDEN_H) * px;
  const firstRow = HIDDEN_H - TOP;

  // hard drop trail
  if (fx.trail && now - fx.trail.at < 170) {
    const t = 1 - (now - fx.trail.at) / 170;
    const tr = fx.trail;
    const g = ctx.createLinearGradient(0, rowY(tr.yTop), 0, rowY(tr.yBot));
    g.addColorStop(0, rgba(NEON[tr.color], 0));
    g.addColorStop(1, rgba(NEON[tr.color], 0.42 * t));
    ctx.fillStyle = g;
    ctx.fillRect(tr.x0 * px, rowY(tr.yTop), (tr.x1 - tr.x0 + 1) * px, rowY(tr.yBot) - rowY(tr.yTop));
  }

  const cur = game.cur;
  if (cur && !game.over) {
    const shape = SHAPES[cur.p][cur.r];
    const hue = NEON[cur.p];
    const d = game.dropDistance();
    if (d > 0) {
      // landing guide: a faint column from the piece down to its ghost
      if (q > 0) {
        ctx.fillStyle = rgba(hue, 0.055);
        for (const [cx, cy] of shape) {
          const y = cur.y + cy + 1;
          if (y + d > firstRow) ctx.fillRect((cur.x + cx) * px, rowY(Math.max(y, firstRow)), px - 1, (d - 1) * px);
        }
      }
      ctx.strokeStyle = rgba(hue, 0.78);
      ctx.fillStyle = rgba(hue, 0.1);
      const lw = Math.max(1, Math.round(dpr * 1.5));
      ctx.lineWidth = lw;
      for (const [cx, cy] of shape) {
        const y = cur.y + cy + d;
        if (y < firstRow) continue;
        const X = (cur.x + cx) * px;
        const Y = rowY(y);
        ctx.fillRect(X, Y, px - 1, px - 1);
        ctx.strokeRect(X + lw / 2, Y + lw / 2, px - 1 - lw, px - 1 - lw);
      }
    }
    if (q > 0) {
      const h = halo(cur.p, px);
      for (const [cx, cy] of shape) {
        const y = cur.y + cy;
        if (y >= firstRow) ctx.drawImage(h, (cur.x + cx) * px - pad, rowY(y) - pad);
      }
    }
    const t = neonTile(cur.p, px);
    for (const [cx, cy] of shape) {
      const y = cur.y + cy;
      if (y >= firstRow) ctx.drawImage(t, (cur.x + cx) * px, rowY(y));
    }
    const lockFrac = d === 0 ? Math.min(1, game.lockTimer / game.rules.lockDelay) : 0;
    if (lockFrac > 0) {
      ctx.fillStyle = `rgba(4,6,15,${0.4 * lockFrac})`;
      for (const [cx, cy] of shape) {
        const y = cur.y + cy;
        if (y >= firstRow) ctx.fillRect((cur.x + cx) * px, rowY(y), px - 1, px - 1);
      }
    }
  }

  // landing flash on the cells that just locked
  if (fx.lock) {
    const t = (now - fx.lock.at) / 150;
    if (t >= 1) fx.lock = null;
    else {
      ctx.fillStyle = `rgba(255,255,255,${0.6 * (1 - t) ** 2})`;
      for (const [x, y] of fx.lock.cells) if (y >= firstRow) ctx.fillRect(x * px, rowY(y), px - 1, px - 1);
    }
  }

  // garbage rising from the floor
  if (fx.garbage) {
    const t = (now - fx.garbage.at) / 380;
    if (t >= 1) fx.garbage = null;
    else {
      const h = Math.min(VISIBLE_H, fx.garbage.lines) * px;
      const g = ctx.createLinearGradient(0, top + H - h - px, 0, top + H);
      g.addColorStop(0, 'rgba(255,61,127,0)');
      g.addColorStop(1, `rgba(255,61,127,${0.6 * (1 - t)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, top + H - h - px, W, h + px);
      ctx.fillStyle = `rgba(255,255,255,${0.7 * (1 - t) ** 3})`;
      ctx.fillRect(0, top + H - h - 1, W, 2 * dpr);
    }
  }

  // line clear: tiers 1..4 grow from a row flash to a full-board discharge
  if (fx.clear) {
    const cl = fx.clear;
    const dur = 240 + cl.lines * 55;
    const t = (now - cl.at) / dur;
    if (t >= 1) fx.clear = null;
    else {
      const k = Math.min(1.6, cl.power);
      const fade = (1 - t) ** 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top, W, H);
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      if (cl.lines >= 4 && !fx.reduced) {
        ctx.fillStyle = `rgba(190,235,255,${0.5 * (1 - t) ** 3})`;
        ctx.fillRect(0, top, W, H);
      }
      const rows = cl.rows;
      const mid = top + ((rows[0] + rows[rows.length - 1] + 1) / 2) * px;
      if (cl.lines >= 2) {
        // vertical ripple spreading from the cleared band
        const spread = px * (1 + t * (cl.lines + 1) * 1.6);
        const g = ctx.createLinearGradient(0, mid - spread, 0, mid + spread);
        const col = cl.lines >= 4 ? '255,61,240' : '46,230,255';
        g.addColorStop(0, `rgba(${col},0)`);
        g.addColorStop(0.5, `rgba(${col},${0.34 * fade * k})`);
        g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, mid - spread, W, spread * 2);
      }
      if (cl.lines >= 3 && !fx.reduced) {
        // a light front sweeping the whole well, upward from the clear
        const y = mid - t * (mid - top + px * 2);
        const g = ctx.createLinearGradient(0, y - px * 2, 0, y + px);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.7, `rgba(200,240,255,${0.3 * (1 - t)})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y - px * 2, W, px * 3);
      }
      for (const r of rows) {
        const y = top + r * px;
        const hgt = px * (1 - t * 0.75);
        ctx.fillStyle = `rgba(220,245,255,${0.85 * fade})`;
        ctx.fillRect(0, y + (px - hgt) / 2, W, hgt);
        if (!fx.reduced) {
          // light running outward from the centre along the row
          const run = (W / 2) * Math.min(1, t * 1.9);
          const bw = px * 1.2;
          ctx.fillStyle = `rgba(255,255,255,${0.9 * (1 - t)})`;
          ctx.fillRect(W / 2 + run - bw, y + px * 0.2, bw, px * 0.6);
          ctx.fillRect(W / 2 - run, y + px * 0.2, bw, px * 0.6);
        }
      }
      ctx.restore();
    }
  }

  // inner edge; the glowing frame itself is CSS and static
  ctx.strokeStyle = fx.danger ? 'rgba(255,61,127,0.9)' : 'rgba(46,230,255,0.35)';
  ctx.lineWidth = Math.max(1, Math.round(dpr));
  ctx.strokeRect(ctx.lineWidth / 2, top + ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth);
}
