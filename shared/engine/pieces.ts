// Piece definitions and SRS kick tables.
// Coordinates are y-down (row 0 is the top of the 40-row matrix).

export const PIECES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;
export type PieceName = (typeof PIECES)[number];
/** Cell values: 0 empty, 1..7 = PIECES index + 1, 8 = garbage. */
export type PieceId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export const GARBAGE = 8;

export const pieceName = (id: number): PieceName => PIECES[id - 1];

type Cell = readonly [number, number];

const SPAWN_SHAPES: Record<PieceName, { size: number; cells: Cell[] }> = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { size: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

/** SHAPES[pieceId][rotation] -> list of [x, y] offsets inside the bounding box. */
export const SHAPES: Cell[][][] = [[]];
for (const name of PIECES) {
  const { size, cells } = SPAWN_SHAPES[name];
  const rots: Cell[][] = [cells];
  for (let r = 1; r < 4; r++) {
    // clockwise rotation in a y-down box: (x, y) -> (size-1-y, x)
    rots.push(rots[r - 1].map(([x, y]) => [size - 1 - y, x] as const));
  }
  SHAPES.push(rots);
}

export const BOX_SIZE = [0, 4, 2, 3, 3, 3, 3, 3];

// Kick tables from the SRS guideline, written y-up as in the spec and converted below.
type KickTable = Record<string, Cell[]>;
const JLSTZ_UP: KickTable = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};
const I_UP: KickTable = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};
const toDown = (t: KickTable): KickTable =>
  Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.map(([x, y]) => [x, -y] as const)]));

const JLSTZ_KICKS = toDown(JLSTZ_UP);
const I_KICKS = toDown(I_UP);

export function kicks(piece: number, from: number, to: number): Cell[] {
  if (piece === 2) return [[0, 0]];
  return (piece === 1 ? I_KICKS : JLSTZ_KICKS)[`${from}>${to}`];
}
