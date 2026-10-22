// Tiny placement bot for the home screen demo: tries every rotation/column,
// scores the result with a classic height/holes/bumpiness heuristic.

import { Game, Input } from '../../../shared/engine/game';
import { SHAPES } from '../../../shared/engine/pieces';
import { BOARD_H, BOARD_W } from '../../../shared/engine/rules';

function evaluate(board: Uint8Array): number {
  const heights: number[] = [];
  let holes = 0;
  for (let x = 0; x < BOARD_W; x++) {
    let h = 0;
    let seen = false;
    for (let y = 0; y < BOARD_H; y++) {
      const v = board[y * BOARD_W + x];
      if (v && !seen) {
        seen = true;
        h = BOARD_H - y;
      } else if (!v && seen) holes++;
    }
    heights.push(h);
  }
  let agg = 0;
  let bump = 0;
  for (let x = 0; x < BOARD_W; x++) {
    agg += heights[x];
    if (x) bump += Math.abs(heights[x] - heights[x - 1]);
  }
  let lines = 0;
  for (let y = 0; y < BOARD_H; y++) {
    let full = true;
    for (let x = 0; x < BOARD_W; x++) if (!board[y * BOARD_W + x]) full = false;
    if (full) lines++;
  }
  return -0.51 * agg + 0.76 * lines - 0.36 * holes - 0.18 * bump;
}

export function bestMove(g: Game): { x: number; r: number } | null {
  const c = g.cur;
  if (!c) return null;
  let best: { x: number; r: number; s: number } | null = null;
  for (let r = 0; r < 4; r++) {
    for (let x = -2; x < BOARD_W; x++) {
      if (!g.fits(c.p, x, c.y, r)) continue;
      let y = c.y;
      while (g.fits(c.p, x, y + 1, r)) y++;
      const b = g.board.slice();
      for (const [cx, cy] of SHAPES[c.p][r]) b[(y + cy) * BOARD_W + x + cx] = c.p;
      const s = evaluate(b) + Math.random() * 0.05;
      if (!best || s > best.s) best = { x, r, s };
    }
  }
  return best;
}

/** Teleports the active piece to the chosen spot and hard-drops (demo only). */
export function playOne(g: Game) {
  const m = bestMove(g);
  if (!m || !g.cur) return;
  if (g.fits(g.cur.p, m.x, g.cur.y, m.r)) {
    g.cur.x = m.x;
    g.cur.r = m.r;
  }
  g.input(Input.HardDrop);
}
