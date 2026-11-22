// Sokoban solver: push-optimal, one room at a time.
//
// A level is a hallway with one to four rooms off it, and a box pushed out
// of a room into the hallway can never come back, so every box stays in its
// own room and the level's push-optimal count is the sum of its rooms'
// optima. This program therefore splits a level into its rooms, solves
// each room with a breadth-first search over pushes (the first solved state
// a BFS meets is push-optimal), and stitches the rooms' move strings
// together with the player's walks between them.
//
// Two prunes keep the search small: a box standing on a dead square (no
// push from there, ignoring the other boxes, can ever reach a goal) is
// hopeless, and a box in a frozen 2 x 2 block of walls and boxes is stuck.
// The player's exact square never matters, only which open region it
// stands in, so a state is the boxes plus its region's lowest square.
// No clock, no randomness: the same input always gives the same output.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Work budget per search, never the clock: the generator keeps a room only
// when this same search solves it within this many states.
const MAX_STATES = 250_000;

type Board = {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

// [dx, dy, walk letter, push letter] — up, down, left, right.
const DIRS = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
] as const;

/** Parse XSB text (# wall, space floor, . goal, $ box, * box on goal, @ player). */
function parseLevel(text: string): Board {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/** Squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(bd: Board): Uint8Array {
  const { w, wall, goals } = bd;
  const size = wall.length;
  const live = new Uint8Array(size);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      const behind = y - d;
      if (y < 0 || y >= size || behind < 0 || behind >= size) continue;
      if (!wall[y] && !wall[behind] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the player's region from `from` around walls and the boxes in
 * `occupied`, marking it in `seen` with `stamp`; returns its lowest square.
 * The lowest square names the region: two regions sharing a square are one.
 */
function regionLow(
  bd: Board,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = bd;
  const size = wall.length;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (let k = 0; k < 4; k++) {
      const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
      if (q < 0 || q >= size) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(bd: Board, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = bd;
  const size = wall.length;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= size) continue;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

// A state's key: the region's lowest square and the boxes' squares. Numeric
// while it stays exact (five boxes or fewer on these boards); a string key
// for the whole-level fallback, where the box count is larger.
function keyOf(boxes: number[], low: number, size: number): number | string {
  if (boxes.length <= 5) {
    let k = low;
    for (const b of boxes) k = k * size + b;
    return k;
  }
  return `${low}|${boxes.join(',')}`;
}

/**
 * The push-optimal solution of `bd` ({pushes, moves}, moves in LURD with an
 * upper letter marking a push), or null when the search gives up (or the
 * level has no solution). BFS over pushes: the first solved state met is
 * push-optimal.
 */
function solvePush(bd: Board, maxStates = MAX_STATES): { pushes: number; moves: string } | null {
  const { w, wall, goals } = bd;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(bd);
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b]);
  if (bd.boxes.some((b) => !live[b])) return null;

  // The states in the order found: their boxes, the player's square after
  // the push that made them, and the parent state.
  const statesBoxes: number[][] = [bd.boxes.slice()];
  const statesPlayer: number[] = [bd.player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  for (const b of bd.boxes) occupied[b] = 1;
  index.set(keyOf(bd.boxes, regionLow(bd, occupied, bd.player, seen, ++stamp, stack), size), 0);
  for (const b of bd.boxes) occupied[b] = 0;
  let found = solved(bd.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const boxes = statesBoxes[head];
    for (const b of boxes) occupied[b] = 1;
    regionLow(bd, occupied, statesPlayer[head], seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi];
      for (let k = 0; k < 4; k++) {
        const [dx, dy] = DIRS[k];
        const d = dy * w + dx;
        const t = b + d;
        // The player must stand on the square behind the box, and the box
        // must land on open floor that can still reach a goal.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(bd, occupied, goal, t);
        let key: number | string = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          // The successor's region goes in `mark`, not `seen`: marking it
          // in `seen` would wipe the region this expansion is checking
          // its pushes against.
          key = keyOf(next, regionLow(bd, occupied, b, mark, ++stamp, stack), size);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;
  // The path of states, then the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = bd.player;
  let boxes = statesBoxes[0];
  for (const s of path) {
    const nextBoxes = statesBoxes[s];
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(bd, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(bd: Board, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = bd;
  const size = wall.length;
  if (from === to) return '';
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (q < 0 || q >= size || wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

type Room = { squares: number[]; boxes: number[]; goals: number[]; done: boolean };

/**
 * The level's rooms: cut the hallway row's dead squares (a box there reaches
 * no goal) out of the floor, and each part left that holds a box is a room.
 * Null when some part holds more or fewer boxes than goals, or a box starts
 * in the hallway: then the level is no set of rooms.
 */
function roomsOf(bd: Board): Room[] | null {
  const { w, wall, goals, boxes, player } = bd;
  const live = liveSquares(bd);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) if (part[g] >= 0) rooms[part[g]].goals.push(g);
  if (goals.some((g) => part[g] < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * The level solved room by room: each room's push-optimal solution in turn,
 * the other rooms' boxes standing as walls (on their goals once their room
 * is done), the player walking on from where the last room left it. A box
 * never leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(bd: Board): { pushes: number; moves: string } | null {
  const rooms = roomsOf(bd);
  if (rooms === null) return solvePush(bd);
  let player = bd.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = bd.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    }
    const sub: Board = {
      w: bd.w,
      h: bd.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePush(sub);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(bd.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for one level: an empty string when it cannot be solved. */
function solve(text: string): string {
  const bd = parseLevel(text);
  const solved = solveByRooms(bd);
  return solved === null ? '' : solved.moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
