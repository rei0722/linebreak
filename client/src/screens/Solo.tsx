import { useEffect, useMemo, useState } from 'react';
import { TICK_RATE, VISIBLE_H } from '../../../shared/engine/rules';
import { GameView } from '../game/GameView';
import { SoloSource } from '../game/sources';
import { TOP_ROWS } from '../game/render';
import { sfx } from '../game/audio';
import { HandlingDialog, TopBar, navigate, useViewport } from '../ui';

/** Below this width the layout is a phone: touch pad under the board, opponents above it. */
export const NARROW = 760;
export const TOUCHPAD_H = 132;

export function boardCell(h: number, max = 38, w = Infinity, reserve = 0) {
  // topbar 52 + vertical padding; board is 20 rows plus the 2-row spawn margin
  const byH = Math.floor((h - 52 - 40 - reserve) / (VISIBLE_H + TOP_ROWS));
  // board (10) + two side panels (4.2 each) + gaps must fit the width
  const byW = Math.floor((w - 64) / 18.4);
  return Math.max(w < NARROW ? 12 : 16, Math.min(max, byH, byW));
}

export function Solo() {
  const vp = useViewport();
  const source = useMemo(() => new SoloSource(), []);
  const [menu, setMenu] = useState(false);
  const [settings, setSettings] = useState(false);
  const [over, setOver] = useState<null | 'topout' | 'finish'>(null);
  const [, force] = useState(0);
  const cell = boardCell(vp.h, 38, vp.w, vp.w < NARROW ? TOUCHPAD_H : 0);

  useEffect(() => {
    const onVis = () => {
      if (document.hidden && !source.game().over) {
        source.pause();
        setMenu(true);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [source]);

  const toggleMenu = () => {
    if (over) return;
    if (source.paused()) {
      source.resume();
      setMenu(false);
      setSettings(false);
    } else {
      source.pause();
      setMenu(true);
    }
  };

  const restart = () => {
    source.reset();
    setOver(null);
    setMenu(false);
    force((n) => n + 1);
  };

  const g = source.game();
  return (
    <div className="screen">
      <TopBar>
        <span className="topbar-room">ひとりで練習 — 150ライン</span>
      </TopBar>
      <main className="screen-body arena arena-solo">
        <GameView
          source={source}
          cell={cell}
          onMenu={toggleMenu}
          inputEnabled={!menu && !over}
          showMeter={false}
          mode="solo"
          onEvent={(e) => {
            if (e.k === 'over') {
              setOver(e.reason);
              if (e.reason === 'finish') sfx.win();
              else sfx.ko();
            }
          }}
        >
          {menu && !over && (
            <div className="board-panel">
              <h2>一時停止中</h2>
              <div className="dialog-actions">
                <button className="btn btn-primary" autoFocus onClick={toggleMenu}>
                  続ける
                </button>
                <button className="btn" onClick={restart}>
                  最初からやり直す
                </button>
                <button className="btn" onClick={() => setSettings(true)}>
                  操作設定
                </button>
                <button className="btn btn-quiet" onClick={() => navigate('/')}>
                  ホームに戻る
                </button>
              </div>
              <p className="board-panel-hint">
                <kbd>Esc</kbd> で再開
              </p>
            </div>
          )}
          {over && (
            <div className="board-panel">
              <h2>{over === 'finish' ? '150ライン達成' : 'ゲームオーバー'}</h2>
              <dl className="final-stats">
                <div>
                  <dt>スコア</dt>
                  <dd className="num">{g.score.toLocaleString('ja-JP')}</dd>
                </div>
                <div>
                  <dt>ライン</dt>
                  <dd className="num">{g.lines}</dd>
                </div>
                <div>
                  <dt>タイム</dt>
                  <dd className="num">
                    {Math.floor(g.tick / TICK_RATE / 60)}:{String(Math.floor(g.tick / TICK_RATE) % 60).padStart(2, '0')}
                  </dd>
                </div>
              </dl>
              <div className="dialog-actions">
                <button className="btn btn-primary" autoFocus onClick={restart}>
                  もう一度
                </button>
                <button className="btn btn-quiet" onClick={() => navigate('/')}>
                  ホームに戻る
                </button>
              </div>
            </div>
          )}
        </GameView>
      </main>
      {settings && <HandlingDialog onClose={() => setSettings(false)} />}
    </div>
  );
}
