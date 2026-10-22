// Small synthesized sound set (no audio files). WebAudio starts on first user gesture.

import { prefs } from '../prefs';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ac(): AudioContext | null {
  if (!prefs.get().sound) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = 'square', vol = 1, slide = 0, delay = 0) {
  const a = ac();
  if (!a || !master) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur: number, vol = 0.6, hp = 800) {
  const a = ac();
  if (!a || !master) return;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'highpass';
  f.frequency.value = hp;
  const g = a.createGain();
  g.gain.value = vol;
  src.connect(f).connect(g).connect(master);
  src.start();
}

let lastMove = 0;

export const sfx = {
  unlock() {
    ac();
  },
  move() {
    const now = performance.now();
    if (now - lastMove < 28) return; // ARR spam
    lastMove = now;
    tone(880, 0.025, 'square', 0.18);
  },
  rotate() {
    tone(620, 0.04, 'triangle', 0.4, 180);
  },
  hold() {
    tone(440, 0.06, 'triangle', 0.45, -120);
  },
  lock() {
    tone(150, 0.07, 'sine', 0.8, -60);
    noise(0.04, 0.25, 2000);
  },
  hard() {
    tone(110, 0.1, 'sine', 1, -50);
    noise(0.06, 0.4, 1200);
  },
  clear(lines: number, special: boolean) {
    const base = [0, 523, 587, 659, 784][Math.min(4, lines)] || 523;
    tone(base, 0.12, 'triangle', 0.6);
    tone(base * 1.5, 0.14, 'triangle', 0.45, 0, 0.05);
    if (lines >= 4 || special) {
      tone(base * 2, 0.22, 'triangle', 0.45, 0, 0.1);
      noise(0.18, 0.2, 4000);
    }
  },
  garbage() {
    tone(90, 0.18, 'sawtooth', 0.35, -30);
  },
  warn() {
    tone(330, 0.08, 'square', 0.25);
  },
  count(final: boolean) {
    tone(final ? 988 : 659, final ? 0.3 : 0.12, 'square', 0.35);
  },
  ko() {
    tone(392, 0.12, 'square', 0.4, -200);
    tone(262, 0.3, 'square', 0.35, -150, 0.12);
  },
  win() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.22, 'triangle', 0.5, 0, i * 0.11));
  },
};
