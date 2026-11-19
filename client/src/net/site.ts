// Site-wide extras: the live player count and ¥50 tips.

import { useSyncExternalStore } from 'react';
import type { SiteStats } from '../../../shared/protocol';
import { serverBase } from './session';

// ------------------------------------------------------------ live count

const POLL_MS = 20_000;
let stats: SiteStats | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

let fallbackId: string | undefined;

/** Random id per browser so the server counts people, not tabs. Not linked to anything else. */
function visitorId(): string {
  const KEY = 'linebreak.visitor';
  try {
    let v = localStorage.getItem(KEY);
    if (!v || !/^[a-z0-9]{16,40}$/.test(v)) {
      v = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY, v);
    }
    return v;
  } catch {
    return (fallbackId ??= Math.random().toString(36).slice(2).padEnd(16, '0'));
  }
}

async function poll() {
  timer = null;
  if (document.visibilityState !== 'hidden') {
    try {
      const r = await fetch(`${serverBase()}/api/stats?v=${visitorId()}`, { cache: 'no-store' });
      if (r.ok) {
        stats = (await r.json()) as SiteStats;
        listeners.forEach((l) => l());
      }
    } catch {
      /* offline: keep the last value */
    }
  }
  if (listeners.size) timer = setTimeout(poll, POLL_MS);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && listeners.size) {
    if (timer) clearTimeout(timer);
    void poll();
  }
});

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1 && !timer) void poll();
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

export function useSiteStats(): SiteStats | null {
  return useSyncExternalStore(subscribe, () => stats);
}

// ------------------------------------------------------------ supporter token

const SUP_KEY = 'linebreak.supporter';
const supListeners = new Set<() => void>();

export const supporter = {
  get(): string | undefined {
    try {
      return localStorage.getItem(SUP_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string) {
    try {
      localStorage.setItem(SUP_KEY, token);
    } catch {
      /* private mode: the tag lasts for this page only */
      memoryToken = token;
    }
    supListeners.forEach((l) => l());
  },
};
let memoryToken: string | undefined;
export const supToken = () => supporter.get() ?? memoryToken;

export function useIsSupporter(): boolean {
  return useSyncExternalStore(
    (l) => {
      supListeners.add(l);
      return () => supListeners.delete(l);
    },
    () => Boolean(supToken()),
  );
}

// ------------------------------------------------------------ tipping

/** Sends the browser to Stripe's payment page. */
export async function startTip(): Promise<void> {
  const r = await fetch(`${serverBase()}/api/tip/checkout`, { method: 'POST' });
  if (!r.ok) throw new Error(String(r.status));
  const { url } = (await r.json()) as { url: string };
  location.assign(url);
}

/** After Stripe sends the browser back with `?tip=<session id>`: trade it for a supporter token.
    Returns 'thanks' | 'cancel' | 'failed', or null when the URL has no tip result. */
export async function claimTipFromUrl(): Promise<'thanks' | 'cancel' | 'failed' | null> {
  const url = new URL(location.href);
  const sid = url.searchParams.get('tip');
  if (sid === null) return null;
  url.searchParams.delete('tip');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  if (sid === 'cancel') return 'cancel';
  try {
    const r = await fetch(`${serverBase()}/api/tip/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: sid }),
    });
    if (!r.ok) return 'failed';
    const { token } = (await r.json()) as { token: string };
    supporter.set(token);
    return 'thanks';
  } catch {
    return 'failed';
  }
}
