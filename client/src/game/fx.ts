// Screen-space effects: particles, shockwaves and attack beams on one overlay
// canvas. Presentation only — nothing here is read by the game or the network.
//
// Budget rules:
//  - particles live in fixed typed arrays (a pool); spawning never allocates
//  - hard caps per quality level; extra spawns are dropped
//  - the rAF loop runs only while something is alive, and stops in hidden tabs
//  - glows are pre-rendered sprites, never per-frame blur or shadow

import { prefs, type FxQuality } from '../prefs';

const LEVEL: Record<FxQuality, number> = { low: 0, medium: 1, high: 2 };
const MAX_PARTICLES = 640;
const PARTICLE_CAP = [90, 260, 420];
/** Overlay pixel budget per level. The overlay is uploaded to the GPU every effect frame, so its size is the main cost. */
const PIXEL_BUDGET = [0.6e6, 0.9e6, 1.3e6];
const MAX_RINGS = 10;
const MAX_BEAMS = 6;

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Ring {
  x: number;
  y: number;
  /** when set, an expanding rounded box instead of a circle */
  box: Box | null;
  r0: number;
  r1: number;
  at: number;
  dur: number;
  color: string;
  width: number;
}

interface Beam {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
  at: number;
  dur: number;
  color: string;
  ci: number;
  power: number;
  onArrive: (() => void) | null;
}

class FxEngine {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private scale = 1;
  private w = 0;
  private h = 0;

  // particle pool (struct of arrays, dense: indices 0..n-1 are alive)
  private n = 0;
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private vx = new Float32Array(MAX_PARTICLES);
  private vy = new Float32Array(MAX_PARTICLES);
  private life = new Float32Array(MAX_PARTICLES);
  private ttl = new Float32Array(MAX_PARTICLES);
  private size = new Float32Array(MAX_PARTICLES);
  private grav = new Float32Array(MAX_PARTICLES);
  private col = new Uint8Array(MAX_PARTICLES);

  private colors: string[] = [];
  private glows: HTMLCanvasElement[] = [];
  private rings: Ring[] = [];
  private beams: Beam[] = [];

  private raf = 0;
  private running = false;
  private last = 0;

  /** user's ceiling */
  cap = LEVEL[prefs.get().fx];
  /** effective level right now (<= cap) */
  level = this.cap;
  reduced = false;

  /** automatic quality stepping; tests switch it off to pin a level */
  auto = true;
  // frame-time governor
  private gN = 0;
  private gSum = 0;
  private gSlow = 0;
  /** rolling average frame time in ms, for the perf readout */
  avgFrame = 16.7;

  constructor() {
    prefs.subscribe((p) => {
      this.cap = LEVEL[p.fx];
      this.level = this.cap;
      this.resize();
    });
    if (typeof matchMedia === 'function') {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = mq.matches;
      mq.addEventListener?.('change', () => {
        this.reduced = mq.matches;
        if (this.reduced) this.clearAll();
      });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearAll();
    });
    window.addEventListener('resize', () => this.resize());
  }

  /** Particle effects are off entirely for reduced motion. */
  get active() {
    return !this.reduced;
  }

  /**
   * Called once per game frame with the frame time. Drops one quality level
   * when frames run slow for ~2s and climbs back after ~10s of smooth frames.
   */
  noteFrame(dt: number) {
    if (dt <= 0 || dt > 250) return; // tab switch, breakpoint
    this.gSum += dt;
    // a "hitch" is a frame that missed at least one refresh on a 60Hz display
    if (dt > 25) this.gSlow++;
    if (++this.gN < 90) return;
    const avg = this.gSum / this.gN;
    const hitchy = this.gSlow > this.gN * 0.06;
    this.avgFrame = avg;
    this.gN = 0;
    this.gSum = 0;
    this.gSlow = 0;
    if (!this.auto) return;
    // Step down on a slow average OR on repeated hitches (an average hides those).
    // There is no automatic step back up: climbing would bring the stutter back.
    // Picking a level in the top bar resets this.
    if ((avg > 19 || hitchy) && this.level > 0) {
      this.level--;
      this.resize();
    }
  }

  private ensure(): CanvasRenderingContext2D | null {
    if (this.ctx) return this.ctx;
    const c = document.createElement('canvas');
    c.className = 'fx-layer';
    c.setAttribute('aria-hidden', 'true');
    document.body.appendChild(c);
    this.canvas = c;
    // desynchronized: let the browser present this layer without waiting on the page's own paint
    this.ctx = c.getContext('2d', { alpha: true, desynchronized: true });
    c.style.display = 'none';
    this.resize();
    return this.ctx;
  }

  private resize() {
    const c = this.canvas;
    if (!c) return;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    // Never more pixels than the budget, whatever the window or display size:
    // sparks are soft, so a slightly lower-resolution overlay is not visible.
    this.scale = Math.min(1, Math.sqrt(PIXEL_BUDGET[this.level] / Math.max(1, this.w * this.h)));
    c.width = Math.round(this.w * this.scale);
    c.height = Math.round(this.h * this.scale);
  }

  private colorIndex(color: string): number {
    let i = this.colors.indexOf(color);
    if (i >= 0) return i;
    if (this.colors.length >= 250) return 0;
    i = this.colors.push(color) - 1;
    const g = document.createElement('canvas');
    g.width = g.height = 48;
    const x = g.getContext('2d')!;
    const grad = x.createRadialGradient(24, 24, 0, 24, 24, 24);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.18, color);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    x.globalAlpha = 0.9;
    x.fillStyle = grad;
    x.fillRect(0, 0, 48, 48);
    this.glows.push(g);
    return i;
  }

  private kick() {
    if (this.running || document.hidden) return;
    if (!this.ensure()) return;
    this.running = true;
    this.canvas!.style.display = '';
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------------------------------------------------------------- spawn

  /**
   * Sparks from a point. `count` is the HIGH-quality amount; it is scaled down
   * on lower levels and clipped by the pool cap.
   */
  burst(
    x: number,
    y: number,
    color: string,
    count: number,
    o: { speed?: number; angle?: number; spread?: number; ttl?: number; size?: number; gravity?: number; jitter?: number } = {},
  ) {
    if (!this.active || document.hidden) return;
    if (x < -40 || y < -40 || x > window.innerWidth + 40 || y > window.innerHeight + 40) return; // off-screen
    const n = Math.round(count * [0.3, 0.6, 1][this.level]);
    const cap = PARTICLE_CAP[this.level];
    const ci = this.colorIndex(color);
    const speed = o.speed ?? 260;
    const spread = o.spread ?? Math.PI * 2;
    const angle = o.angle ?? 0;
    const ttl = o.ttl ?? 0.55;
    const size = o.size ?? 2.4;
    const jit = o.jitter ?? 0;
    for (let k = 0; k < n && this.n < cap; k++) {
      const i = this.n++;
      const a = angle + (Math.random() - 0.5) * spread;
      const v = speed * (0.35 + Math.random() * 0.65);
      this.px[i] = x + (Math.random() - 0.5) * jit;
      this.py[i] = y;
      this.vx[i] = Math.cos(a) * v;
      this.vy[i] = Math.sin(a) * v;
      this.ttl[i] = this.life[i] = ttl * (0.6 + Math.random() * 0.6);
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.grav[i] = o.gravity ?? 420;
      this.col[i] = ci;
    }
    this.kick();
  }

  ring(x: number, y: number, color: string, r1: number, dur = 380, width = 3, r0 = 4) {
    this.pushRing({ x, y, box: null, r0, r1, at: performance.now(), dur, color, width });
  }

  /** A shockwave that follows the outline of a box (the board) and expands outward. */
  boxWave(box: Box, color: string, grow: number, dur = 420, width = 3) {
    this.pushRing({ x: 0, y: 0, box, r0: 0, r1: grow, at: performance.now(), dur, color, width });
  }

  private pushRing(r: Ring) {
    if (!this.active || document.hidden || this.level === 0) return;
    if (this.rings.length >= MAX_RINGS) this.rings.shift();
    this.rings.push(r);
    this.kick();
  }

  /**
   * Energy travelling from `from` to `to` along a shallow arc. `onArrive` runs
   * when the head lands (or immediately if the beam cannot be shown).
   */
  beam(from: Pt, to: Pt, color: string, power: number, onArrive?: () => void) {
    if (!this.active || document.hidden || this.beams.length >= MAX_BEAMS) {
      onArrive?.();
      return;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy) || 1;
    // control point pushed sideways; alternate sides so simultaneous beams separate
    const side = (this.beams.length % 2 ? -1 : 1) * (0.12 + Math.random() * 0.1) * dist;
    this.beams.push({
      x0: from.x,
      y0: from.y,
      cx: (from.x + to.x) / 2 + (-dy / dist) * side,
      cy: (from.y + to.y) / 2 + (dx / dist) * side,
      x1: to.x,
      y1: to.y,
      at: performance.now(),
      dur: Math.min(620, 300 + dist * 0.3),
      color,
      ci: this.colorIndex(color),
      power: Math.max(1, Math.min(8, power)),
      onArrive: onArrive ?? null,
    });
    this.kick();
  }

  /** Create the overlay and the glow sprites for these colours ahead of first use. */
  warm(colors: string[]) {
    if (!this.ensure()) return;
    for (const c of colors) this.colorIndex(c);
  }

  clearAll() {
    this.n = 0;
    this.rings.length = 0;
    // deliver pending arrivals so callers never wait on a cancelled beam
    const pending = this.beams.splice(0);
    for (const b of pending) b.onArrive?.();
    if (this.running) {
      cancelAnimationFrame(this.raf);
      this.running = false;
      if (this.canvas) this.canvas.style.display = 'none';
    }
    this.ctx?.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
  }

  /** live counts, for the perf readout and tests */
  stats() {
    return { particles: this.n, rings: this.rings.length, beams: this.beams.length, running: this.running, level: this.level };
  }

  // ---------------------------------------------------------------- frame

  private frame = (now: number) => {
    try {
      this.draw(now);
    } catch (err) {
      // an effect must never take the loop down with it: drop everything and go idle
      this.running = false;
      this.clearAll();
      console.error('[fx] frame failed', err);
    }
  };

  private draw(now: number) {
    const ctx = this.ctx!;
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    const s = this.scale;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.globalCompositeOperation = 'lighter';

    // beams
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      // rAF's timestamp is the frame start, which can be earlier than a spawn made this frame
      const t = Math.max(0, (now - b.at) / b.dur);
      if (t >= 1) {
        this.beams.splice(i, 1);
        b.onArrive?.();
        continue;
      }
      const e = t * t * (3 - 2 * t); // smoothstep
      const segs = this.level === 0 ? 4 : 9;
      const tail = 0.34;
      ctx.strokeStyle = b.color;
      ctx.lineCap = 'round';
      let lx = 0;
      let ly = 0;
      for (let k = 0; k <= segs; k++) {
        const u = Math.max(0, e - tail + (tail * k) / segs);
        const m = 1 - u;
        const x = m * m * b.x0 + 2 * m * u * b.cx + u * u * b.x1;
        const y = m * m * b.y0 + 2 * m * u * b.cy + u * u * b.y1;
        if (k) {
          ctx.globalAlpha = (k / segs) * 0.9;
          ctx.lineWidth = (1 + b.power * 0.7) * (0.3 + (0.7 * k) / segs);
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(x, y);
          ctx.stroke();
        }
        lx = x;
        ly = y;
      }
      const hs = 14 + b.power * 5;
      ctx.globalAlpha = 1;
      ctx.drawImage(this.glows[b.ci], lx - hs, ly - hs, hs * 2, hs * 2);
      if (this.level > 0 && Math.random() < 0.6) {
        const i2 = this.n;
        if (i2 < PARTICLE_CAP[this.level]) {
          this.n++;
          this.px[i2] = lx;
          this.py[i2] = ly;
          this.vx[i2] = (Math.random() - 0.5) * 90;
          this.vy[i2] = (Math.random() - 0.5) * 90;
          this.ttl[i2] = this.life[i2] = 0.3;
          this.size[i2] = 1.6 + Math.random() * 1.6;
          this.grav[i2] = 0;
          this.col[i2] = b.ci;
        }
      }
    }

    // rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const t = Math.max(0, (now - r.at) / r.dur);
      if (t >= 1) {
        this.rings.splice(i, 1);
        continue;
      }
      const e = 1 - (1 - t) ** 3;
      const rad = Math.max(0, r.r0 + (r.r1 - r.r0) * e);
      ctx.globalAlpha = (1 - t) ** 1.5;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      if (r.box) {
        const b = r.box;
        const rr = 10 + rad;
        const x = b.left - rad;
        const y = b.top - rad;
        const w = b.right - b.left + rad * 2;
        const h = b.bottom - b.top + rad * 2;
        ctx.moveTo(x + rr, y);
        ctx.arcTo(x + w, y, x + w, y + h, rr);
        ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr);
        ctx.arcTo(x, y, x + w, y, rr);
        ctx.closePath();
      } else ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    // particles: integrate, cull, draw; dead ones are swap-removed
    const glow = this.level >= 2;
    let lastCol = -1;
    for (let i = 0; i < this.n; ) {
      const life = (this.life[i] -= dt);
      const x = (this.px[i] += this.vx[i] * dt);
      const y = (this.py[i] += (this.vy[i] += this.grav[i] * dt) * dt);
      if (life <= 0 || x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) {
        const j = --this.n;
        if (i !== j) {
          this.px[i] = this.px[j];
          this.py[i] = this.py[j];
          this.vx[i] = this.vx[j];
          this.vy[i] = this.vy[j];
          this.life[i] = this.life[j];
          this.ttl[i] = this.ttl[j];
          this.size[i] = this.size[j];
          this.grav[i] = this.grav[j];
          this.col[i] = this.col[j];
        }
        continue;
      }
      const k = life / this.ttl[i];
      const sz = this.size[i] * (0.4 + 0.6 * k);
      const ci = this.col[i];
      ctx.globalAlpha = k;
      // halo on every other spark: half the scaled blits, visually the same density
      if (glow && (i & 1) === 0) ctx.drawImage(this.glows[ci], x - sz * 2.4, y - sz * 2.4, sz * 4.8, sz * 4.8);
      if (ci !== lastCol) {
        ctx.fillStyle = this.colors[ci];
        lastCol = ci;
      }
      ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      i++;
    }
    ctx.globalAlpha = 1;

    if (this.n || this.rings.length || this.beams.length) this.raf = requestAnimationFrame(this.frame);
    else {
      // idle: leave a clean canvas and stop the loop until the next spawn
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas!.width, this.canvas!.height);
      this.running = false;
      // no full-screen layer for the compositor while nothing is playing
      this.canvas!.style.display = 'none';
    }
  }
}

export const fx = new FxEngine();

/** Point on `box`'s edge closest to `p` — where energy coming from `p` enters the box. */
export function edgePoint(box: Box, p: Pt): Pt {
  const x = Math.max(box.left, Math.min(box.right, p.x));
  const y = Math.max(box.top, Math.min(box.bottom, p.y));
  if (x !== p.x || y !== p.y) return { x, y };
  // p is inside: push to the nearest edge
  const dl = p.x - box.left;
  const dr = box.right - p.x;
  const dt = p.y - box.top;
  const db = box.bottom - p.y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: box.left, y: p.y };
  if (m === dr) return { x: box.right, y: p.y };
  if (m === dt) return { x: p.x, y: box.top };
  return { x: p.x, y: box.bottom };
}
