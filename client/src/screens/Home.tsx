import { useEffect, useRef, useState } from 'react';
import { Game } from '../../../shared/engine/game';
import { BATTLE_RULES, DEFAULT_HANDLING, VISIBLE_H } from '../../../shared/engine/rules';
import { ROOM_ALPHABET, ROOM_ID_LENGTH } from '../../../shared/protocol';
import { playOne } from '../game/ai';
import { TOP_ROWS, drawMainBoard, inDanger, newFx, setupCanvas } from '../game/render';
import { NEWS, markNewsSeen, seenNews } from '../news';
import { prefs } from '../prefs';
import { ControlsList, HandlingDialog, TopBar, navigate, toast, usePrefs, useViewport } from '../ui';

/** Self-playing board: the first thing you see is the game itself. */
function DemoBoard({ cell }: { cell: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = setupCanvas(ref.current!, cell * 10, cell * (VISIBLE_H + TOP_ROWS));
    const fx = newFx();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let g = new Game({ seed: (Math.random() * 1e9) | 0, rules: { ...BATTLE_RULES, levelUpTicks: 0 }, handling: DEFAULT_HANDLING });
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      if (now - last > (reduced ? 900 : 260)) {
        last = now;
        if (g.over) g = new Game({ seed: (Math.random() * 1e9) | 0, rules: BATTLE_RULES, handling: DEFAULT_HANDLING });
        playOne(g);
        for (const e of g.events) if (e.k === 'clear' && e.lines) fx.flash = { rows: e.rows.map((r) => r - 20), at: now };
        g.events = [];
        // keep the demo readable: occasionally lift in garbage so the stack moves
        if (g.pieces % 23 === 22) g.receiveGarbage({ id: g.pieces, lines: 2, hole: (g.pieces * 7) % 10 });
      }
      fx.danger = inDanger(g);
      drawMainBoard(c, g, cell, fx, now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [cell]);
  return <canvas ref={ref} className="demo-canvas" aria-hidden />;
}

const fmtDate = (d: string) => {
  const [, m, day] = d.split('-').map(Number);
  return `${m}/${day}`;
};

/** お知らせ: what changed recently. Items the visitor has not seen yet get a NEW mark. */
function NewsBoard() {
  const [all, setAll] = useState(false);
  const [fresh] = useState(() => {
    const seen = seenNews();
    if (seen) return new Set(NEWS.filter((n) => !seen.has(n.id)).map((n) => n.id));
    // first visit: only the last week counts as new
    const newest = Date.parse(NEWS[0]?.date ?? '');
    return new Set(NEWS.filter((n) => newest - Date.parse(n.date) <= 7 * 864e5).map((n) => n.id));
  });
  useEffect(() => markNewsSeen(), []);
  const list = all ? NEWS : NEWS.slice(0, 3);
  return (
    <section className="news" aria-labelledby="news-title">
      <header className="news-head">
        <h2 id="news-title">お知らせ</h2>
        {fresh.size > 0 && <span className="news-count">{fresh.size}件の新着</span>}
      </header>
      <ol className="news-list">
        {list.map((n) => (
          <li key={n.id} className="news-item" data-new={fresh.has(n.id)}>
            <div className="news-meta">
              <time className="num" dateTime={n.date}>
                {fmtDate(n.date)}
              </time>
              {n.tag && (
                <span className="news-tag" data-tag={n.tag}>
                  {n.tag}
                </span>
              )}
              {fresh.has(n.id) && <span className="news-new">NEW</span>}
            </div>
            <b className="news-title">{n.title}</b>
            <p className="news-body">{n.body}</p>
          </li>
        ))}
      </ol>
      {NEWS.length > 3 && (
        <button className="btn btn-quiet btn-sm news-more" onClick={() => setAll((v) => !v)}>
          {all ? '閉じる' : `すべて見る（${NEWS.length}件）`}
        </button>
      )}
    </section>
  );
}

function parseCode(raw: string): string | null {
  const m = raw.trim().toUpperCase().match(new RegExp(`([${ROOM_ALPHABET}]{${ROOM_ID_LENGTH}})\\s*$`));
  return m ? m[1] : null;
}

export function Home() {
  const p = usePrefs();
  const vp = useViewport();
  const [name, setName] = useState(p.name);
  const [code, setCode] = useState('');
  const [settings, setSettings] = useState(false);
  const cell = Math.max(16, Math.min(30, Math.floor((vp.h - 52 - 96) / (VISIBLE_H + TOP_ROWS))));

  const saveName = () => prefs.set({ name: name.trim().slice(0, 16) });
  const join = () => {
    const id = parseCode(code);
    if (!id) {
      toast('6文字の部屋コードか招待リンクを入力してください');
      return;
    }
    saveName();
    navigate(`/room/${id}`);
  };

  return (
    <div className="screen">
      <TopBar />
      <main className="screen-body home">
        <p className="credit">制作者　3-5　伊藤 璃晴</p>
        <section className="home-main">
          {NEWS[0] && (
            <button
              className="news-ticker"
              onClick={() => document.getElementById('news-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="news-ticker-label">お知らせ</span>
              <span className="news-ticker-text">{NEWS[0].title}</span>
              <span aria-hidden>↓</span>
            </button>
          )}
          <h1 className="home-title">
            部屋を作って、
            <br />
            リンクを送るだけ。
          </h1>
          <p className="home-lede">
            最大8人で同時にプレイするサバイバル対戦。ラインを消すと相手におじゃまブロックが送られ、最後まで積み上がらずに残った人が勝ちです。登録やインストールは要りません。
          </p>

          <div className="home-form">
            <label className="label" htmlFor="name">
              表示名
            </label>
            <input
              id="name"
              className="field"
              placeholder="プレイヤー"
              maxLength={16}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
            />
            <div className="home-actions">
              <button
                className="btn btn-primary"
                onClick={() => {
                  saveName();
                  navigate('/room/new');
                }}
              >
                部屋を作る
              </button>
              <button
                className="btn"
                onClick={() => {
                  saveName();
                  navigate('/solo');
                }}
              >
                ひとりで練習
              </button>
            </div>

            <form
              className="home-join"
              onSubmit={(e) => {
                e.preventDefault();
                join();
              }}
            >
              <label className="label" htmlFor="code">
                招待コードで参加
              </label>
              <div className="home-join-row">
                <input
                  id="code"
                  className="field num code-field"
                  placeholder="AB12CD"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn" type="submit" disabled={!code.trim()}>
                  参加する
                </button>
              </div>
            </form>
          </div>

          <div className="home-help">
            <ControlsList />
            <button className="btn btn-quiet btn-sm" onClick={() => setSettings(true)}>
              操作設定を変更
            </button>
          </div>
        </section>
        <section className="home-demo" aria-hidden>
          <DemoBoard cell={cell} />
        </section>
        <NewsBoard />
      </main>
      {settings && <HandlingDialog onClose={() => setSettings(false)} />}
    </div>
  );
}
