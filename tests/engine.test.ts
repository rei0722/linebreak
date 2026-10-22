import { describe, expect, test } from 'bun:test';
import { Game, Input } from '../shared/engine/game';
import { BATTLE_RULES, DEFAULT_HANDLING, SOLO_RULES, BOARD_W, BOARD_H, HIDDEN_H } from '../shared/engine/rules';
import { SHAPES } from '../shared/engine/pieces';

const mk = (seed = 1, rules = SOLO_RULES) => new Game({ seed, rules, handling: DEFAULT_HANDLING });

/** Fill rows from the bottom with a pattern string per row ('#' filled, '.' empty), bottom row last. */
function setRows(g: Game, rows: string[]) {
  g.board.fill(0);
  rows.forEach((row, i) => {
    const y = BOARD_H - rows.length + i;
    for (let x = 0; x < BOARD_W; x++) g.board[y * BOARD_W + x] = row[x] === '#' ? 8 : 0;
  });
}

function force(g: Game, p: number, x: number, y: number, r = 0) {
  g.cur = { p, x, y, r };
  g.lowestY = y;
  g.lockTimer = 0;
  g.lockResets = 0;
}

describe('7-bag randomizer', () => {
  test('every group of 7 contains each piece exactly once', () => {
    const g = mk(12345);
    const seen: number[] = [g.cur!.p];
    // pull pieces via hard drop on an empty board, clearing it each time
    for (let i = 0; i < 69; i++) {
      g.board.fill(0);
      g.input(Input.HardDrop);
      seen.push(g.cur!.p);
    }
    for (let b = 0; b < 10; b++) {
      const bag = seen.slice(b * 7, b * 7 + 7).sort();
      expect(bag).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
  });

  test('same seed gives same sequence, different seed differs', () => {
    expect(mk(7).next).toEqual(mk(7).next);
    expect([mk(7).cur!.p, ...mk(7).next]).not.toEqual([mk(8).cur!.p, ...mk(8).next]);
  });
});

describe('movement and rotation', () => {
  test('pieces spawn centered and dropped one row into the buffer', () => {
    const g = mk();
    const c = g.cur!;
    expect(c.x).toBe(c.p === 2 ? 4 : 3);
    expect(c.y).toBe(HIDDEN_H - 1);
  });

  test('left/right tap moves one column, walls stop movement', () => {
    const g = mk();
    force(g, 3, 3, 30);
    g.input(Input.LeftDown);
    g.input(Input.LeftUp);
    expect(g.cur!.x).toBe(2);
    for (let i = 0; i < 10; i++) {
      g.input(Input.LeftDown);
      g.input(Input.LeftUp);
    }
    expect(g.cur!.x).toBe(0);
  });

  test('DAS charges then ARR repeats', () => {
    const g = new Game({ seed: 1, rules: { ...SOLO_RULES, lockDelay: 999 }, handling: { das: 10, arr: 2, sdf: 20 } });
    force(g, 3, 3, 30);
    g.input(Input.RightDown);
    expect(g.cur!.x).toBe(4);
    for (let i = 0; i < 9; i++) g.step();
    expect(g.cur!.x).toBe(4);
    g.step(); // das reached
    expect(g.cur!.x).toBe(5);
    g.step();
    g.step();
    expect(g.cur!.x).toBe(6);
  });

  test('ARR 0 slides to the wall instantly once DAS is charged', () => {
    const g = new Game({ seed: 1, rules: { ...SOLO_RULES, lockDelay: 999 }, handling: { das: 6, arr: 0, sdf: 20 } });
    force(g, 3, 3, 30);
    g.input(Input.LeftDown);
    g.advanceTo(g.tick + 6);
    expect(g.cur!.x).toBe(0);
  });

  test('later key wins, releasing it falls back to the other held key', () => {
    const g = new Game({ seed: 1, rules: { ...SOLO_RULES, lockDelay: 999 }, handling: { das: 5, arr: 1, sdf: 20 } });
    force(g, 3, 4, 30);
    g.input(Input.LeftDown);
    g.input(Input.RightDown);
    expect(g.cur!.x).toBe(4);
    g.input(Input.RightUp);
    g.advanceTo(g.tick + 5);
    expect(g.cur!.x).toBeLessThan(4);
  });

  test('CW then CCW returns to the same state', () => {
    const g = mk();
    force(g, 3, 4, 30);
    g.input(Input.RotateCW);
    expect(g.cur!.r).toBe(1);
    g.input(Input.RotateCCW);
    expect(g.cur).toMatchObject({ x: 4, y: 30, r: 0 });
  });

  test('wall kick: vertical I against the right wall rotates by kicking left', () => {
    const g = mk();
    // I in state R occupies box column 2 -> x+2. Place it at the right wall.
    force(g, 1, 7, 30, 1);
    g.input(Input.RotateCW); // R -> 2, horizontal; must kick to fit
    expect(g.cur!.r).toBe(2);
    for (const [cx] of SHAPES[1][2]) expect(g.cur!.x + cx).toBeLessThan(BOARD_W);
  });

  test('O piece does not move when rotated', () => {
    const g = mk();
    force(g, 2, 4, 30);
    g.input(Input.RotateCW);
    expect(g.cur).toMatchObject({ x: 4, y: 30 });
  });

  test('hard drop locks at the bottom and scores 2 per row', () => {
    const g = mk();
    force(g, 2, 4, 20);
    g.input(Input.HardDrop);
    expect(g.cell(4, BOARD_H - 1)).toBe(2);
    expect(g.cell(5, BOARD_H - 2)).toBe(2);
    expect(g.score).toBe((BOARD_H - 2 - 20) * 2);
  });

  test('soft drop speeds falling and scores 1 per row', () => {
    const g = mk();
    force(g, 2, 4, 20);
    g.input(Input.SoftDown);
    g.advanceTo(g.tick + 30);
    expect(g.cur!.y).toBeGreaterThan(24);
    expect(g.score).toBe(g.cur!.y - 20);
  });

  test('gravity moves pieces down over time and lock delay locks them', () => {
    const g = mk();
    const start = g.cur!.y;
    g.advanceTo(120);
    expect(g.cur!.y).toBeGreaterThan(start);
    const g2 = mk();
    force(g2, 2, 4, BOARD_H - 2);
    g2.advanceTo(g2.tick + SOLO_RULES.lockDelay);
    expect(g2.pieces).toBe(1);
  });

  test('lock resets are capped so a piece cannot stall forever', () => {
    const g = mk();
    force(g, 3, 4, BOARD_H - 2);
    for (let i = 0; i < 200 && g.pieces === 0; i++) {
      g.input(i % 2 ? Input.RotateCW : Input.RotateCCW);
      g.advanceTo(g.tick + 5);
    }
    expect(g.pieces).toBe(1);
  });
});

describe('hold', () => {
  test('hold swaps once per piece', () => {
    const g = mk();
    const first = g.cur!.p;
    const nextUp = g.next[0];
    g.input(Input.Hold);
    expect(g.hold).toBe(first);
    expect(g.cur!.p).toBe(nextUp);
    g.input(Input.Hold);
    expect(g.cur!.p).toBe(nextUp);
    g.input(Input.HardDrop);
    g.input(Input.Hold);
    expect(g.cur!.p).toBe(first);
  });
});

describe('line clears and scoring', () => {
  const cases: [number, number][] = [
    [1, 100],
    [2, 300],
    [3, 500],
    [4, 800],
  ];
  for (const [n, pts] of cases) {
    test(`${n} line clear scores ${pts} × level`, () => {
      const g = mk();
      setRows(g, [...Array(n)].map(() => '#########.'));
      g.board[(BOARD_H - n - 1) * BOARD_W] = 8; // keep the board from being a perfect clear
      force(g, 1, 7, 25, 1); // vertical I, box column 2 -> x=9
      g.input(Input.HardDrop);
      expect(g.lines).toBe(n);
      const dropped = g.score - pts;
      expect(dropped % 2).toBe(0);
      expect(dropped).toBeGreaterThan(0);
    });
  }

  test('back-to-back tetris gets 1.5x and +1 attack', () => {
    const g = mk(1, BATTLE_RULES);
    const ev: any[] = [];
    for (let k = 0; k < 2; k++) {
      setRows(g, ['#.........', ...[...Array(4)].map(() => '#########.')]);
      force(g, 1, 7, 25, 1);
      g.input(Input.HardDrop);
      ev.push(...g.events.filter((e) => e.k === 'clear'));
      g.events = [];
    }
    expect(ev[0]).toMatchObject({ lines: 4, b2b: false, attack: 4 });
    expect(ev[1]).toMatchObject({ lines: 4, b2b: true });
    expect(ev[1].attack).toBe(4 + 1 + 0); // base + b2b + combo table[1]
  });

  test('T-spin double is detected (3-corner rule)', () => {
    const g = mk();
    setRows(g, [
      '##........',
      '#...######',
      '##.#######',
    ]);
    // Overhang at (0..1, top row). T pointing down slots into the gap at x=1..3.
    force(g, 3, 1, BOARD_H - 3, 0);
    g.input(Input.RotateCW);
    g.input(Input.RotateCW);
    g.input(Input.HardDrop);
    const clear = g.events.find((e) => e.k === 'clear') as any;
    expect(clear).toBeTruthy();
    expect(clear.spin).not.toBe('none');
    expect(clear.lines).toBe(2);
  });

  test('perfect clear adds bonus attack', () => {
    const g = mk(1, BATTLE_RULES);
    setRows(g, ['#########.']);
    force(g, 1, 7, 25, 1);
    // vertical I needs 4 rows; use a horizontal O-free setup instead: clear 1 row with I leaves 3 cells.
    setRows(g, ['######....']);
    force(g, 1, 6, BOARD_H - 2, 0);
    g.input(Input.HardDrop);
    const clear = g.events.find((e) => e.k === 'clear') as any;
    expect(clear.pc).toBe(true);
    expect(clear.attack).toBe(BATTLE_RULES.attack.perfectClear);
  });

  test('top out when spawn is blocked', () => {
    const g = mk();
    for (let y = HIDDEN_H - 2; y < BOARD_H; y++) for (let x = 0; x < 9; x++) g.board[y * BOARD_W + x] = 8;
    g.input(Input.HardDrop);
    expect(g.over).toBe('topout');
  });

  test('solo marathon finishes at the goal line count', () => {
    const g = new Game({ seed: 1, rules: { ...SOLO_RULES, goalLines: 4 }, handling: DEFAULT_HANDLING });
    setRows(g, ['#.........', ...[...Array(4)].map(() => '#########.')]);
    force(g, 1, 7, 25, 1);
    g.input(Input.HardDrop);
    expect(g.over).toBe('finish');
  });

  test('level rises every 10 lines', () => {
    const g = mk();
    g.lines = 19;
    setRows(g, ['#.........', '#########.']);
    force(g, 1, 7, 25, 1);
    g.input(Input.HardDrop);
    expect(g.level).toBe(3);
  });
});

describe('garbage', () => {
  test('incoming garbage is inserted on a non-clearing lock with one hole', () => {
    const g = mk(1, BATTLE_RULES);
    g.receiveGarbage({ id: 1, lines: 3, hole: 4 });
    force(g, 2, 0, 20);
    g.input(Input.HardDrop);
    for (let y = BOARD_H - 3; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) expect(g.cell(x, y)).toBe(x === 4 ? 0 : 8);
    }
    expect(g.pending.length).toBe(0);
  });

  test('line clear attack cancels pending garbage first', () => {
    const g = mk(1, BATTLE_RULES);
    g.receiveGarbage({ id: 1, lines: 3, hole: 0 });
    setRows(g, ['#.........', ...[...Array(4)].map(() => '#########.')]);
    force(g, 1, 7, 25, 1);
    g.input(Input.HardDrop);
    const clear = g.events.find((e) => e.k === 'clear') as any;
    expect(clear.attack).toBe(4);
    expect(clear.sent).toBe(1);
    expect(g.pendingLines).toBe(0);
  });

  test('garbage per lock is capped', () => {
    const g = mk(1, BATTLE_RULES);
    g.receiveGarbage({ id: 1, lines: 12, hole: 0 });
    force(g, 2, 4, 20);
    g.input(Input.HardDrop);
    expect(g.pendingLines).toBe(12 - BATTLE_RULES.garbageCap);
  });
});

describe('determinism', () => {
  function play(seed: number, script: [number, number][]) {
    const g = new Game({ seed, rules: BATTLE_RULES, handling: DEFAULT_HANDLING });
    for (const [t, code] of script) {
      g.advanceTo(t);
      g.input(code);
    }
    g.advanceTo(3000);
    return g;
  }
  const script: [number, number][] = [];
  let t = 0;
  let s = 99;
  for (let i = 0; i < 400; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    t += s % 7;
    script.push([t, s % 10]);
  }

  test('replaying the same input log gives an identical state', () => {
    const a = play(42, script);
    const b = play(42, script);
    expect(a.hash()).toBe(b.hash());
    expect(a.save()).toEqual(b.save());
  });

  test('save/load round trip continues identically', () => {
    const a = play(42, script.slice(0, 200));
    const snap = a.save();
    const b = new Game({ seed: 42, rules: BATTLE_RULES, handling: DEFAULT_HANDLING }, JSON.parse(JSON.stringify(snap)));
    expect(b.hash()).toBe(a.hash());
    for (const g of [a, b]) {
      g.input(Input.RotateCW);
      g.input(Input.HardDrop);
      g.advanceTo(4000);
    }
    expect(b.hash()).toBe(a.hash());
  });
});
