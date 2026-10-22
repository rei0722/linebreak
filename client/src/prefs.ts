// Per-browser preferences (localStorage) and per-tab seat tokens (sessionStorage,
// so two tabs in one browser are two different players).

import { DEFAULT_HANDLING, clampHandling, type Handling } from '../../shared/engine/rules';

export interface Prefs {
  name: string;
  sound: boolean;
  handling: Handling;
}

const KEY = 'linebreak.prefs';
const DEFAULTS: Prefs = { name: '', sound: true, handling: DEFAULT_HANDLING };

function read(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      name: typeof raw.name === 'string' ? raw.name.slice(0, 16) : '',
      sound: raw.sound !== false,
      handling: clampHandling(raw.handling),
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
      localStorage.setItem(KEY, JSON.stringify(current));
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
