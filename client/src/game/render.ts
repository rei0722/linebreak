// Canvas 2D drawing for boards, pieces and previews. Tiles are pre-rendered
// per (colour, size) into offscreen canvases so a frame is mostly drawImage calls.

import { SHAPES } from '../../../shared/engine/pieces';
import { BOARD_W, HIDDEN_H, VISIBLE_H } from '../../../shared/engine/rules';
import type { Game } from '../../../shared/engine/game';

export const COLORS = ['', '#3fd0e0', '#f5cd3d', '#b56cf0', '#63d86b', '#f2566a', '#4c7df5', '#f59342', '#5d5677'];
export const WELL = '#110e1e';
const GRID = 'rgba(160, 145, 210, 0.07)';

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  const r = f(n >> 16);
  const g = f((n >> 8) & 255);
  const b = f(n & 255);
  return `rgb(${r},${g},${b})`;
}

const tileCache = new Map<string, HTMLCanvasElement>();

/** A bevelled tile: flat face, light top edge, darker bottom edge. Size in device px. */
export function tile(color: number, size: number, flat = false): HTMLCanvasElement {
  const key = `${color}:${size}:${flat ? 1 : 0}`;
  let c = tileCache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const base = COLORS[color];
  const gap = size >= 14 ? 1 : 0;
  const s = size - gap;
  g.fillStyle = base;
  g.fillRect(0, 0, s, s);
  if (!flat) {
    const e = Math.max(1, Math.round(size / 9));
    g.fillStyle = shade(base, 0.32);
    g.fillRect(0, 0, s, e);
    g.fillStyle = shade(base, 0.14);
    g.fillRect(0, e, e, s - e);
    g.fillStyle = shade(base, -0.32);
    g.fillRect(0, s - e, s, e);
    g.fillStyle = shade(base, -0.18);
    g.fillRect(s - e, 0, e, s - e);
  }
  tileCache.set(key, c);
  return c;
}

export interface Canvas2D {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
}

export function setupCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): Canvas2D {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d', { alpha: true })!;
  ctx.imageSmoothingEnabled = false;
  return { canvas, ctx, dpr };
}

/** Extra rows drawn above the visible field so spawning pieces are visible. */
export const TOP_ROWS = 2;

export interface BoardFx {
  /** visible-row indices currently flashing, with start time */
  flash: { rows: number[]; at: number } | null;
  /** last hard drop: columns + time, for a short trail */
  trail: { x0: number; x1: number; yTop: number; yBot: number; color: number; at: number } | null;
  shakeAt: number;
  danger: boolean;
}

export function newFx(): BoardFx {
  return { flash: null, trail: null, shakeAt: 0, danger: false };
}

/** Draws the main board including ghost and active piece. Cell size in css px. */
export function drawMainBoard(c: Canvas2D, game: Game, cell: number, fx: BoardFx, now: number, dim = false) {
  const { ctx, dpr } = c;
  const px = Math.round(cell * dpr);
  const W = BOARD_W * px;
  const top = TOP_ROWS * px;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);

  // hard-drop "thump": 2px for 90ms
  const since = now - fx.shakeAt;
  const shake = since < 90 ? Math.round((1 - since / 90) * 2 * dpr) : 0;
  ctx.translate(0, shake);

  // well
  ctx.fillStyle = WELL;
  ctx.fillRect(0, top, W, VISIBLE_H * px);
  ctx.fillStyle = GRID;
  for (let x = 1; x < BOARD_W; x++) ctx.fillRect(x * px, top, Math.max(1, dpr | 0), VISIBLE_H * px);
  for (let y = 1; y < VISIBLE_H; y++) ctx.fillRect(0, top + y * px, W, Math.max(1, dpr | 0));

  const rowY = (boardY: number) => top + (boardY - HIDDEN_H) * px;
  const firstRow = HIDDEN_H - TOP_ROWS;

  // settled cells
  for (let y = firstRow; y < HIDDEN_H + VISIBLE_H; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const v = game.board[y * BOARD_W + x];
      if (v) ctx.drawImage(tile(dim ? 8 : v, px), x * px, rowY(y));
    }
  }

  // hard drop trail
  if (fx.trail && now - fx.trail.at < 140) {
    const t = 1 - (now - fx.trail.at) / 140;
    const tr = fx.trail;
    const g = ctx.createLinearGradient(0, rowY(tr.yTop), 0, rowY(tr.yBot));
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(1, hexAlpha(COLORS[tr.color], 0.28 * t));
    ctx.fillStyle = g;
    ctx.fillRect(tr.x0 * px, rowY(tr.yTop), (tr.x1 - tr.x0 + 1) * px, rowY(tr.yBot) - rowY(tr.yTop));
  }

  const cur = game.cur;
  if (cur && !game.over) {
    const shape = SHAPES[cur.p][cur.r];
    // ghost
    const d = game.dropDistance();
    if (d > 0) {
      ctx.strokeStyle = hexAlpha(COLORS[cur.p], 0.6);
      ctx.fillStyle = hexAlpha(COLORS[cur.p], 0.12);
      ctx.lineWidth = Math.max(1, Math.round(dpr * 1.5));
      const lw = ctx.lineWidth;
      for (const [cx, cy] of shape) {
        const y = cur.y + cy + d;
        if (y < firstRow) continue;
        const X = (cur.x + cx) * px;
        const Y = rowY(y);
        ctx.fillRect(X, Y, px - 1, px - 1);
        ctx.strokeRect(X + lw / 2, Y + lw / 2, px - 1 - lw, px - 1 - lw);
      }
    }
    // lock-delay feedback: the active piece darkens slightly while it sits on the stack
    const lockFrac = d === 0 ? Math.min(1, game.lockTimer / game.rules.lockDelay) : 0;
    for (const [cx, cy] of shape) {
      const y = cur.y + cy;
      if (y < firstRow) continue;
      ctx.drawImage(tile(cur.p, px), (cur.x + cx) * px, rowY(y));
    }
    if (lockFrac > 0) {
      ctx.fillStyle = `rgba(17,14,30,${0.35 * lockFrac})`;
      for (const [cx, cy] of shape) {
        const y = cur.y + cy;
        if (y >= firstRow) ctx.fillRect((cur.x + cx) * px, rowY(y), px - 1, px - 1);
      }
    }
  }

  // line clear flash
  if (fx.flash) {
    const t = (now - fx.flash.at) / 220;
    if (t >= 1) fx.flash = null;
    else {
      ctx.fillStyle = `rgba(255,255,255,${0.75 * (1 - t) ** 2})`;
      for (const r of fx.flash.rows) {
        const h = px * (1 - t * 0.6);
        ctx.fillRect(0, top + r * px + (px - h) / 2, W, h);
      }
    }
  }

  // frame: danger tint when the stack reaches the top quarter
  ctx.strokeStyle = fx.danger ? 'rgba(255,93,115,0.85)' : 'rgba(167,159,192,0.28)';
  ctx.lineWidth = Math.max(1, Math.round(dpr * (fx.danger ? 2 : 1)));
  ctx.strokeRect(ctx.lineWidth / 2, top + ctx.lineWidth / 2, W - ctx.lineWidth, VISIBLE_H * px - ctx.lineWidth);
}

export function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

/** A single piece centred in a box (hold / next). */
export function drawPiece(ctx: CanvasRenderingContext2D, p: number, cx: number, cy: number, px: number, color = p) {
  const cells = SHAPES[p][0];
  let minX = 9,
    maxX = 0,
    minY = 9,
    maxY = 0;
  for (const [x, y] of cells) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = (maxX - minX + 1) * px;
  const h = (maxY - minY + 1) * px;
  const ox = Math.round(cx - w / 2);
  const oy = Math.round(cy - h / 2);
  for (const [x, y] of cells) ctx.drawImage(tile(color, px), ox + (x - minX) * px, oy + (y - minY) * px);
}

/** Danger: any settled cell in the top 4 visible rows (or above). */
export function inDanger(game: Game): boolean {
  for (let i = 0; i < (HIDDEN_H + 4) * BOARD_W; i++) if (game.board[i]) return true;
  return false;
}

/** Opponent mini board from a compact snapshot string (22 rows; first 2 are buffer). */
export function drawMini(
  c: Canvas2D,
  b: string,
  piece: [number, number, number, number] | null,
  cell: number,
  alive: boolean,
) {
  const { ctx, dpr } = c;
  const px = Math.max(2, Math.round(cell * dpr));
  const W = BOARD_W * px;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
  ctx.fillStyle = WELL;
  ctx.fillRect(0, 0, W, VISIBLE_H * px);
  const off = 2; // buffer rows in snapshot
  for (let y = off; y < VISIBLE_H + off; y++) {
    for (let x = 0; x < BOARD_W; x++) {
      const v = b.charCodeAt(y * BOARD_W + x) - 48;
      if (v > 0) ctx.drawImage(tile(alive ? v : 8, px, true), x * px, (y - off) * px);
    }
  }
  if (piece && alive) {
    const [p, x, y, r] = piece;
    for (const [cx, cy] of SHAPES[p][r]) {
      const yy = y + cy - off;
      if (yy >= 0) ctx.drawImage(tile(p, px, true), (x + cx) * px, yy * px);
    }
  }
  ctx.strokeStyle = 'rgba(167,159,192,0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, VISIBLE_H * px - 1);
}
