// Per-browser preferences (localStorage) and per-tab seat tokens (sessionStorage,
// so two tabs in one browser are two different players).

import { DEFAULT_HANDLING, clampHandling, type Handling } from '../../shared/engine/rules';

export type Design = 'classic' | 'neon';
export type FxQuality = 'high' | 'medium' | 'low';

export interface Prefs {
  name: string;
  sound: boolean;
  handling: Handling;
  /** Visual skin only — never read by game logic or networking. */
  design: Design;
  /** Upper bound for effects; the runtime may drop below it when frames are slow. */
  fx: FxQuality;
}

const KEY = 'linebreak.prefs';
/** Bumped when the display defaults change. Display choices saved under an older
    version were mostly the old default written alongside a name or sound change,
    not a choice, so they are replaced by the new default once. */
const VERSION = 2;
const DEFAULTS: Prefs = { name: '', sound: true, handling: DEFAULT_HANDLING, design: 'neon', fx: 'high' };

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 16) : '',
      sound: raw.sound !== false,
      handling: clampHandling(raw.handling),
      design: raw.v === VERSION && raw.design === 'classic' ? 'classic' : DEFAULTS.design,
      fx: raw.v === VERSION && (raw.fx === 'low' || raw.fx === 'medium') ? raw.fx : DEFAULTS.fx,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let current = read();
const listeners = new Set<(p: Prefs) => void>();

export const prefs = {
  get: () => current,
  set(patch: Partial<Prefs>) {
    current = { ...current, ...patch };
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...current, v: VERSION }));
    } catch {
      /* private mode: keep in memory */
    }
    for (const l of listeners) l(current);
  },
  subscribe(l: (p: Prefs) => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export const seat = {
  get(room: string): string | undefined {
    try {
      return sessionStorage.getItem(`linebreak.seat.${room}`) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(room: string, token: string) {
    try {
      sessionStorage.setItem(`linebreak.seat.${room}`, token);
    } catch {
      /* ignore */
    }
  },
  clear(room: string) {
    try {
      sessionStorage.removeItem(`linebreak.seat.${room}`);
    } catch {
      /* ignore */
    }
  },
};

/** Personal best per mode, kept in this browser only. */
export const hiScore = {
  get(mode: 'solo' | 'battle'): number {
    try {
      return Number(localStorage.getItem(`linebreak.hi.${mode}`)) || 0;
    } catch {
      return 0;
    }
  },
  set(mode: 'solo' | 'battle', v: number) {
    try {
      localStorage.setItem(`linebreak.hi.${mode}`, String(v));
    } catch {
      /* ignore */
    }
  },
};
