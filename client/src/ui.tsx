// Shared UI pieces: router, top bar, toast, settings dialog, viewport hook.

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { prefs, type Design, type FxQuality } from './prefs';
import type { ConnStatus } from './net/connection';
import { startTip, useIsSupporter, useSiteStats } from './net/site';

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

const DESIGNS: { id: Design; label: string; short: string }[] = [
  { id: 'classic', label: 'CLASSIC', short: 'CLASSIC' },
  { id: 'neon', label: 'NEON CYBER ARENA', short: 'NEON' },
];
const FX_LEVELS: FxQuality[] = ['high', 'medium', 'low'];

/** Skin and effects switches. Safe mid-game: they only change how things are drawn. */
export function DisplayControls() {
  const p = usePrefs();
  // drop focus after a click so Space / arrows keep going to the game
  const pick = (e: React.MouseEvent<HTMLButtonElement>, patch: Parameters<typeof prefs.set>[0]) => {
    e.currentTarget.blur();
    prefs.set(patch);
  };
  return (
    <div className="display-controls">
      <div className="seg seg-sm" role="group" aria-label="デザイン">
        {DESIGNS.map((d) => (
          <button key={d.id} aria-pressed={p.design === d.id} title={`デザイン：${d.label}`} onClick={(e) => pick(e, { design: d.id })}>
            <span className="wide">{d.label}</span>
            <span className="narrow">{d.short}</span>
          </button>
        ))}
      </div>
      <div className="seg seg-sm seg-fx" role="group" aria-label="エフェクト品質">
        {FX_LEVELS.map((q) => (
          <button key={q} aria-pressed={p.fx === q} title={`エフェクト品質：${q.toUpperCase()}`} onClick={(e) => pick(e, { fx: q })}>
            <span className="wide">{q.toUpperCase()}</span>
            <span className="narrow">{q[0].toUpperCase()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <Wordmark />
      {children}
      <span className="topbar-spacer" />
      <LiveCount />
      <TipButton />
      <DisplayControls />
      <SoundToggle />
    </header>
  );
}

// ------------------------------------------------------------ live count & tips

/** "● 12人がオンライン（対戦中 4人）" — polled every 20 s from /api/stats. */
export function LiveCount() {
  const st = useSiteStats();
  if (!st) return null;
  return (
    <span className="live-count" title={`いまサイトを開いている人 ${st.online}人／対戦中 ${st.playing}人`}>
      <i className="live-dot" aria-hidden />
      <b className="num">{st.online}</b>
      <span className="live-label">人がオンライン</span>
      <span className="live-playing">
        対戦中 <b className="num">{st.playing}</b>
      </span>
    </span>
  );
}

export function TipButton() {
  const st = useSiteStats();
  const isSup = useIsSupporter();
  const [open, setOpen] = useState(false);
  if (!st?.tips) return null;
  return (
    <>
      <button
        className="btn btn-sm tip-btn"
        data-supporter={isSup}
        onClick={(e) => {
          e.currentTarget.blur();
          setOpen(true);
        }}
        title="50円で応援する"
      >
        <span aria-hidden>🎍</span>
        <span className="wide">{isSup ? '応援ありがとう' : '¥50で応援'}</span>
      </button>
      {open && <TipDialog supporter={isSup} onClose={() => setOpen(false)} />}
    </>
  );
}

function TipDialog({ supporter, onClose }: { supporter: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await startTip();
    } catch {
      setBusy(false);
      toast('支払い画面を開けませんでした。少し待ってからもう一度お試しください');
    }
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog tip-dialog" role="dialog" aria-label="応援する" onClick={(e) => e.stopPropagation()}>
        <h2>50円で応援する</h2>
        <p className="tip-lede">
          LINEBREAK を応援してくれた方には、お礼として対戦ロビーで<b>お正月の赤いネームタグ</b>が付きます。
        </p>
        <div className="tip-preview" aria-hidden>
          <span className="player" data-supporter="true">
            <span className="supporter-mark">寿</span>
            <span className="player-name">
              <span className="player-name-text">あなたの名前</span>
              <SupporterBadge />
            </span>
          </span>
        </div>
        <ul className="tip-notes">
          <li>支払いは Stripe の画面で行います（カード・Apple Pay など）。</li>
          <li>ネームタグは、支払ったこのブラウザに付きます。</li>
          {supporter && <li>すでにネームタグは付いています。もう一度応援することもできます。</li>}
        </ul>
        <div className="dialog-actions">
          <button className="btn btn-primary tip-go" onClick={go} disabled={busy}>
            {busy ? '支払い画面を開いています…' : '¥50 で応援する'}
          </button>
          <button className="btn btn-quiet" onClick={onClose}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

export function SupporterBadge({ small = false }: { small?: boolean }) {
  return (
    <span className="supporter-badge" data-small={small} title="50円で応援してくれた人">
      応援
    </span>
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
