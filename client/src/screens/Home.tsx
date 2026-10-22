import { useEffect, useRef, useState } from 'react';
import { Game } from '../../../shared/engine/game';
import { BATTLE_RULES, DEFAULT_HANDLING, VISIBLE_H } from '../../../shared/engine/rules';
import { ROOM_ALPHABET, ROOM_ID_LENGTH } from '../../../shared/protocol';
import { playOne } from '../game/ai';
import { TOP_ROWS, drawMainBoard, inDanger, newFx, setupCanvas } from '../game/render';
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
        <section className="home-main">
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
      </main>
      {settings && <HandlingDialog onClose={() => setSettings(false)} />}
    </div>
  );
}
