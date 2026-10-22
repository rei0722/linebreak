// Shared UI pieces: router, top bar, toast, settings dialog, viewport hook.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { prefs } from './prefs';
import type { ConnStatus } from './net/connection';

// ------------------------------------------------------------ router

const routeListeners = new Set<() => void>();
window.addEventListener('popstate', () => routeListeners.forEach((l) => l()));

export function navigate(path: string, replace = false) {
  if (replace) history.replaceState(null, '', path);
  else history.pushState(null, '', path);
  routeListeners.forEach((l) => l());
}

export function usePath(): string {
  return useSyncExternalStore(
    (l) => {
      routeListeners.add(l);
      return () => routeListeners.delete(l);
    },
    () => location.pathname,
  );
}

// ------------------------------------------------------------ viewport

export function useViewport() {
  const [size, set] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => set({ w: window.innerWidth, h: window.innerHeight }));
    };
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      cancelAnimationFrame(raf);
    };
  }, []);
  return size;
}

export function usePrefs() {
  return useSyncExternalStore(prefs.subscribe, prefs.get);
}

// ------------------------------------------------------------ toast

let toastSet: ((t: string | null) => void) | null = null;
export function toast(text: string) {
  toastSet?.(text);
}

export function ToastHost() {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    toastSet = setText;
    return () => {
      toastSet = null;
    };
  }, []);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), 2200);
    return () => clearTimeout(t);
  }, [text]);
  return text ? (
    <div className="toast" role="status" key={text + Date.now()}>
      {text}
    </div>
  ) : null;
}

// ------------------------------------------------------------ top bar

const MARK = ['var(--p-t)', 'var(--p-i)', 'var(--p-o)', 'var(--p-z)'];

export function Wordmark() {
  return (
    <a
      className="wordmark"
      href="/"
      onClick={(e) => {
        e.preventDefault();
        navigate('/');
      }}
    >
      <span className="wordmark-mark" aria-hidden>
        {MARK.map((c) => (
          <i key={c} style={{ background: c }} />
        ))}
      </span>
      LINEBREAK
    </a>
  );
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '接続中',
  open: 'オンライン',
  reconnecting: '再接続中',
  failed: '接続できません',
  closed: '切断',
};

export function ConnBadge({ status }: { status: ConnStatus }) {
  return (
    <span className="conn" data-s={status}>
      {STATUS_TEXT[status]}
    </span>
  );
}

export function SoundToggle() {
  const p = usePrefs();
  return (
    <button
      className="btn btn-quiet btn-sm"
      onClick={() => prefs.set({ sound: !p.sound })}
      aria-pressed={p.sound}
      title="効果音のオン・オフ"
    >
      <SpeakerIcon on={p.sound} />
      {p.sound ? '効果音オン' : '効果音オフ'}
    </button>
  );
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 6h3l4-3v10L5 10H2z" fill="currentColor" stroke="none" />
      {on ? <path d="M11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6 6 0 0 1 0 9" /> : <path d="M11 6l4 4M15 6l-4 4" />}
    </svg>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <Wordmark />
      {children}
      <span className="topbar-spacer" />
      <SoundToggle />
    </header>
  );
}

// ------------------------------------------------------------ handling settings

export function HandlingDialog({ onClose }: { onClose: () => void }) {
  const p = usePrefs();
  const h = p.handling;
  const ms = (t: number) => Math.round((t * 1000) / 60);
  const row = (key: 'das' | 'arr' | 'sdf', label: string, min: number, max: number, fmt: (v: number) => string, help: string) => (
    <label className="hrow">
      <span className="hrow-head">
        <span>{label}</span>
        <span className="num hrow-val">{fmt(h[key])}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        value={h[key]}
        onChange={(e) => prefs.set({ handling: { ...h, [key]: Number(e.target.value) } })}
      />
      <span className="hrow-help">{help}</span>
    </label>
  );
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" role="dialog" aria-label="操作設定" onClick={(e) => e.stopPropagation()}>
        <h2>操作設定</h2>
        {row('das', '長押しで連続移動するまで', 1, 20, (v) => `${ms(v)} ms`, '短いほど早く横移動が始まります')}
        {row('arr', '連続移動の間隔', 0, 5, (v) => (v === 0 ? '即時' : `${ms(v)} ms`), '0 にすると壁まで一気に移動します')}
        {row('sdf', 'ソフトドロップの速さ', 5, 41, (v) => (v >= 41 ? '即時' : `×${v}`), '通常の落下速度に対する倍率')}
        <p className="hrow-note">変更は次のゲームから反映されます。</p>
        <div className="dialog-actions">
          <button className="btn btn-primary" onClick={onClose} autoFocus>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function ControlsList() {
  const rows: [ReactNode, string][] = [
    [<><kbd>←</kbd> <kbd>→</kbd></>, '左右に移動'],
    [<><kbd>↑</kbd> <kbd>X</kbd></>, '右回転'],
    [<kbd>Z</kbd>, '左回転'],
    [<kbd>↓</kbd>, 'ソフトドロップ'],
    [<kbd>Space</kbd>, 'ハードドロップ'],
    [<><kbd>C</kbd> <kbd>Shift</kbd></>, 'ホールド'],
    [<kbd>Esc</kbd>, 'メニュー'],
  ];
  return (
    <dl className="controls">
      {rows.map(([k, v]) => (
        <div key={v}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
