/**
 * What KataGo's net sees, built the way KataGo v1.15 builds it (cpp/neuralnet/nninputs.cpp, fillRowV7, and the
 * ladder search of cpp/game/board.cpp), for the human SL net in the page. Japanese rules: simple ko, territory
 * scoring with seki tax, no suicide. A point is `y * size + x` from the top-left corner; 1 is black, 2 is white.
 */

export const spatialFeatures = 22;
export const globalFeatures = 19;
export const metaFeatures = 192;
const ladderNodeBudget = 25000;

/** Neighbors in KataGo's order: up, left, right, down. */
const adjacency = new Map();
function adjacent(size) {
  if (!adjacency.has(size)) {
    adjacency.set(size, Array.from({ length: size * size }, (_, point) => {
      const x = point % size;
      const list = [];
      if (point >= size) list.push(point - size);
      if (x > 0) list.push(point - 1);
      if (x < size - 1) list.push(point + 1);
      if (point < size * (size - 1)) list.push(point + size);
      return list;
    }));
  }
  return adjacency.get(size);
}

/** A board with KataGo's simple-ko point: where the side to move may not play right now, or -1. */
export class Board {
  constructor(size, colors = new Int8Array(size * size), ko = -1) {
    this.size = size;
    this.colors = colors;
    this.ko = ko;
    this.adj = adjacent(size);
    this.chains = null;
  }
  /** Chain of every stone: a chain id per point, and per id its stones and liberties. */
  #chainData() {
    if (this.chains) return this.chains;
    const { colors, adj } = this;
    const id = new Int16Array(colors.length).fill(-1);
    const stones = [];
    const liberties = [];
    for (let start = 0; start < colors.length; start++) {
      if (!colors[start] || id[start] !== -1) continue;
      const chain = stones.length;
      const members = [start];
      const libs = new Set();
      id[start] = chain;
      for (let i = 0; i < members.length; i++) {
        for (const near of adj[members[i]]) {
          if (!colors[near]) libs.add(near);
          else if (colors[near] === colors[start] && id[near] === -1) {
            id[near] = chain;
            members.push(near);
          }
        }
      }
      stones.push(members);
      liberties.push(libs);
    }
    this.chains = { id, stones, liberties };
    return this.chains;
  }
  chainId(point) { return this.#chainData().id[point]; }
  stonesOf(point) { return this.#chainData().stones[this.chainId(point)]; }
  libertySet(point) { return this.#chainData().liberties[this.chainId(point)]; }
  libs(point) { return this.libertySet(point).size; }
  immediateLibs(point) { return this.adj[point].filter((near) => !this.colors[near]).length; }

  isLegal(point, pla) {
    if (this.colors[point] || point === this.ko) return false;
    for (const near of this.adj[point]) {
      const color = this.colors[near];
      if (!color) return true;
      if (color === pla && this.libs(near) > 1) return true;
      if (color === 3 - pla && this.libs(near) === 1) return true;
    }
    return false;
  }
  /** The board after a legal move, with the ko point KataGo would set. */
  play(point, pla) {
    if (point === null) return new Board(this.size, this.colors, -1);
    const colors = Int8Array.from(this.colors);
    colors[point] = pla;
    let captured = 0;
    let capturedAt = -1;
    const seen = new Set();
    for (const near of this.adj[point]) {
      if (this.colors[near] !== 3 - pla) continue;
      const chain = this.chainId(near);
      if (seen.has(chain)) continue;
      seen.add(chain);
      const libs = this.libertySet(near);
      if (libs.size === 1 && libs.has(point)) {
        for (const stone of this.stonesOf(near)) colors[stone] = 0;
        captured += this.stonesOf(near).length;
        capturedAt = near;
      }
    }
    const next = new Board(this.size, colors, -1);
    if (captured === 1 && next.stonesOf(point).length === 1 && next.libs(point) === 1) next.ko = capturedAt;
    return next;
  }
}

/* The ladder search, as in KataGo: a group in atari, or with two liberties and the attacker to move, that cannot escape. */

function libertiesInOrder(board, point) {
  const list = [];
  for (const stone of board.stonesOf(point)) {
    for (const near of board.adj[stone]) if (!board.colors[near] && !list.includes(near)) list.push(near);
  }
  return list;
}
function libertyGainingCaptures(board, point, list) {
  const opp = 3 - board.colors[point];
  const checked = new Set();
  for (const stone of board.stonesOf(point)) {
    for (const near of board.adj[stone]) {
      if (board.colors[near] !== opp || board.libs(near) !== 1 || checked.has(board.chainId(near))) continue;
      checked.add(board.chainId(near));
      for (const lib of libertiesInOrder(board, near)) if (!list.includes(lib)) list.push(lib);
    }
  }
  return list;
}
function hasLibertyGainingCaptures(board, point) {
  const opp = 3 - board.colors[point];
  return board.stonesOf(point).some((stone) => board.adj[stone].some((near) => board.colors[near] === opp && board.libs(near) === 1));
}
function boundLibsAfterPlay(board, point, pla) {
  let immediate = 0, caps = 0, fromCaps = 0, connection = 0, maxConnection = 0;
  for (const near of board.adj[point]) {
    const color = board.colors[near];
    if (!color) immediate++;
    else if (color === 3 - pla) {
      if (board.libs(near) === 1) {
        caps++;
        fromCaps += board.stonesOf(near).length;
      }
    } else {
      const libs = board.libs(near) - 1;
      connection += libs;
      maxConnection = Math.max(maxConnection, libs);
    }
  }
  return [caps + Math.max(maxConnection, immediate), immediate + fromCaps + connection];
}
function libsAfterPlay(board, point, pla, max) {
  const opp = 3 - pla;
  const libs = new Set();
  const capturedChains = new Set();
  for (const near of board.adj[point]) {
    if (!board.colors[near]) libs.add(near);
    else if (board.colors[near] === opp && board.libs(near) === 1) {
      libs.add(near);
      capturedChains.add(board.chainId(near));
    }
    if (libs.size >= max) return max;
  }
  const wouldBeEmpty = (at) => !board.colors[at] || (board.colors[at] === opp && capturedChains.has(board.chainId(at)));
  const connected = new Set();
  for (const near of board.adj[point]) {
    if (board.colors[near] !== pla || connected.has(board.chainId(near))) continue;
    connected.add(board.chainId(near));
    for (const stone of board.stonesOf(near)) {
      for (const lib of board.adj[stone]) {
        if (lib !== point && wouldBeEmpty(lib)) libs.add(lib);
        if (libs.size >= max) return max;
      }
    }
  }
  return libs.size;
}
function wouldBeKoCapture(board, point, pla) {
  if (board.colors[point]) return false;
  const opp = 3 - pla;
  let capturable = -1;
  for (const near of board.adj[point]) {
    if (board.colors[near] !== opp) return false;
    if (board.libs(near) === 1) {
      if (capturable !== -1) return false;
      capturable = near;
    }
  }
  return capturable !== -1 && board.stonesOf(capturable).length === 1;
}
function connectionLibsX2(board, point, pla) {
  let total = 0;
  for (const near of board.adj[point]) {
    if (board.colors[near] !== pla) continue;
    const libs = board.libs(near);
    if (libs > 1) total += libs * 2 - 3;
  }
  return total;
}
const touching = (a, b, size) => (Math.abs(a - b) === size) || (Math.abs(a - b) === 1 && Math.floor(a / size) === Math.floor(b / size));

class OutOfBudget extends Error {}

/** Whether the group on `point` is caught in a ladder; `defenderFirst`: the group's side moves first. */
export function ladderCaptured(start, point, defenderFirst) {
  const libsAtStart = start.libs(point);
  if (libsAtStart > 2 || (defenderFirst && libsAtStart > 1)) return false;
  const pla = start.colors[point];
  const opp = 3 - pla;
  const stackSize = Math.floor(start.size * start.size * 3 / 2) + 1;
  let nodes = 0;
  const budget = () => { if (nodes >= ladderNodeBudget) throw new OutOfBudget(); };
  function search(board, depth) {
    if (depth >= stackSize - 1) return true;
    budget();
    const isDefender = defenderFirst ? depth % 2 === 0 : depth % 2 === 1;
    const libs = board.libs(point);
    if (!isDefender && libs <= 1) return true;
    if (!isDefender && libs >= 3) return false;
    if (isDefender && libs >= 2) return false;
    // A ko left for the defender: KataGo does not call ladders that hang on a ko.
    if (isDefender && board.ko !== -1) return false;
    let moves;
    if (isDefender) {
      moves = libertyGainingCaptures(board, point, []);
      for (const lib of libertiesInOrder(board, point)) if (!moves.includes(lib)) moves.push(lib);
      const [lower, upper] = boundLibsAfterPlay(board, moves.at(-1), pla);
      if (lower >= 3) return false;
      if (moves.length === 1 && upper <= 1) return true;
    } else {
      moves = libertiesInOrder(board, point);
      let [libs0, libs1] = moves.map((move) => board.immediateLibs(move));
      if (libs0 === 0 && libs1 === 0 && wouldBeKoCapture(board, moves[0], opp) && wouldBeKoCapture(board, moves[1], opp)
        && libsAfterPlay(board, moves[0], pla, 3) <= 2 && libsAfterPlay(board, moves[1], pla, 3) <= 2
        && !hasLibertyGainingCaptures(board, point)) return true;
      if (!touching(moves[0], moves[1], board.size)) {
        if (libs0 >= 3 && libs1 >= 3) return false;
        if (libs0 >= 3) moves = [moves[0]];
        else if (libs1 >= 3) moves = [moves[1]];
      }
      if (moves.length > 1) {
        libs0 = libs0 * 2 + connectionLibsX2(board, moves[0], pla);
        libs1 = libs1 * 2 + connectionLibsX2(board, moves[1], pla);
        if (libs1 > libs0) moves = [moves[1], moves[0]];
      }
    }
    const mover = isDefender ? pla : opp;
    for (const move of moves) {
      budget();
      if (!board.isLegal(move, mover)) continue;
      nodes++;
      const captured = search(board.play(move, mover), depth + 1);
      if (isDefender && !captured) return false;
      if (!isDefender && captured) return true;
    }
    return isDefender;
  }
  try {
    // At the root every ko is assumed to work for the defender.
    return search(defenderFirst ? new Board(start.size, start.colors, -1) : start, 0);
  } catch (error) {
    if (error instanceof OutOfBudget) return false;
    throw error;
  }
}

/** A group with two liberties that the attacker can ladder: the attacking moves that work, or none. */
export function ladderMovesFor2Libs(board, point) {
  if (board.libs(point) !== 2) return [];
  const opp = 3 - board.colors[point];
  return libertiesInOrder(board, point).filter((move) => board.isLegal(move, opp) && ladderCaptured(board.play(move, opp), point, true));
}

/** Calls `mark(point, workingMoves)` for every stone of a group that is, or can be put, in an inescapable atari. */
function eachLaddered(board, mark) {
  const solved = new Map();
  for (let point = 0; point < board.colors.length; point++) {
    if (!board.colors[point]) continue;
    const libs = board.libs(point);
    if (libs !== 1 && libs !== 2) continue;
    const chain = board.chainId(point);
    if (solved.has(chain)) {
      if (solved.get(chain)) mark(point, []);
      continue;
    }
    const working = libs === 1 ? [] : ladderMovesFor2Libs(board, point);
    const laddered = libs === 1 ? ladderCaptured(board, point, true) : working.length > 0;
    solved.set(chain, laddered);
    if (laddered) mark(point, working);
  }
}

/**
 * The boards of a game as KataGo keeps them: handicap stones on the first, then one per move.
 * `moves` are points or `null` for a pass; black moves first, or white after handicap stones.
 */
export function gameBoards(size, stones, moves) {
  const colors = new Int8Array(size * size);
  for (const point of stones) colors[point] = 1;
  const boards = [new Board(size, colors)];
  let pla = stones.length ? 2 : 1;
  for (const move of moves) {
    boards.push(boards.at(-1).play(move, pla));
    pla = 3 - pla;
  }
  return { boards, toPlay: pla };
}

/**
 * The net's inputs for the side to move: `spatial` is [22][size][size] flattened, `global` has 19 values.
 * Two passes in a row end the main phase by Japanese rules: KataGo then moves to the encore, where the
 * history starts over (the last count of a game asks the net in that state).
 */
export function fillInputs({ size, stones = [], moves, komi }) {
  const { boards, toPlay: pla } = gameBoards(size, stones, moves);
  const opp = 3 - pla;
  const board = boards.at(-1);
  const area = size * size;
  const spatial = new Float32Array(spatialFeatures * area);
  const global = new Float32Array(globalFeatures);
  const set = (feature, point) => { spatial[feature * area + point] = 1; };

  // Phases: two passes in a row move the game to the encore.
  let encorePhase = 0;
  let turnsThisPhase = 0;
  let endingPasses = 0;
  for (const move of moves) {
    turnsThisPhase++;
    endingPasses = move === null ? endingPasses + 1 : 0;
    if (endingPasses >= 2) {
      encorePhase++;
      turnsThisPhase = 0;
      endingPasses = 0;
    }
  }

  for (let point = 0; point < area; point++) {
    set(0, point);
    const stone = board.colors[point];
    if (stone === pla) set(1, point);
    else if (stone === opp) set(2, point);
    if (stone) {
      const libs = board.libs(point);
      if (libs === 1) set(3, point);
      else if (libs === 2) set(4, point);
      else if (libs === 3) set(5, point);
    }
  }
  if (encorePhase === 0 && board.ko !== -1) set(6, board.ko);

  // The last five moves of this phase; moves here always alternate, as KataGo requires.
  const history = Math.min(5, turnsThisPhase);
  let included = 0;
  for (let back = 1; back <= history; back++) {
    const move = moves[moves.length - back];
    included = back;
    if (move === null) global[back - 1] = 1;
    else set(8 + back, move);
  }

  eachLaddered(board, (point, working) => {
    set(14, point);
    if (board.colors[point] === opp && board.libs(point) > 1) for (const move of working) set(17, move);
  });
  const prevBoard = included < 1 ? board : boards.at(-2);
  eachLaddered(prevBoard, (point) => set(15, point));
  const prevPrevBoard = included < 2 ? prevBoard : boards.at(-3);
  eachLaddered(prevPrevBoard, (point) => set(16, point));

  // Komi as KataGo sees it under territory scoring: every stone played, handicap stones too, is worth a point,
  // so the score works like area scoring.
  const first = stones.length ? 2 : 1;
  let whiteBonus = stones.length;
  moves.forEach((move, index) => {
    if (move === null || phaseAt(moves, index) > 1) return;
    whiteBonus += (index % 2 === 0 ? first : 3 - first) === 1 ? 1 : -1;
  });
  let selfKomi = (pla === 2 ? 1 : -1) * (komi + whiteBonus);
  selfKomi = Math.max(-area - 1, Math.min(area + 1, selfKomi));
  global[5] = selfKomi / 20;
  global[9] = 1; // territory scoring
  global[10] = 1; // seki tax
  if (encorePhase > 0) global[12] = 1;
  if (encorePhase > 1) global[13] = 1;
  // A pass ends the phase when the last move was a pass.
  global[14] = endingPasses >= 1 ? 1 : 0;
  return { spatial, global, pla, board };
}

function phaseAt(moves, index) {
  let phase = 0;
  let passes = 0;
  for (let i = 0; i < index; i++) {
    passes = moves[i] === null ? passes + 1 : 0;
    if (passes >= 2) {
      phase++;
      passes = 0;
    }
  }
  return phase;
}

/* The player's rank for the human SL net: KataGo's profile `rank_<r>` as SGF metadata (cpp/neuralnet/sgfmetadata.cpp). */

const inverseRanks = (() => {
  const table = {};
  for (let d = 9; d >= 1; d--) table[`${d}d`] = 10 - d;
  for (let k = 1; k <= 20; k++) table[`${k}k`] = 9 + k;
  return table;
})();

/** The 192 metadata inputs of profile `rank_5k` and the like: a KGS game, byo-yomi 20 min + 5 × 30 s, March 2020. */
export function profileMeta(profile, size) {
  const rank = inverseRanks[profile.replace(/^rank_/, '')];
  if (!rank) throw new Error(`Unknown human SL profile: ${profile}`);
  const meta = new Float32Array(metaFeatures);
  meta[0] = 1; // player is human
  meta[1] = 1; // opponent is human
  for (let i = 0; i < Math.min(rank, 34); i++) {
    meta[6 + i] = 1;
    meta[6 + 34 + i] = 1;
  }
  meta[74] = 0.5; // ratedness unknown
  meta[79] = 1; // byo-yomi
  meta[82] = Math.fround(0.4 * (Math.log(1200 + 60) - 6.5));
  meta[83] = Math.fround(0.3 * (Math.log(30 + 1) - 3));
  meta[84] = Math.fround(0.5 * (Math.log(5 + 2) - 1.5));
  meta[85] = Math.fround(0.25 * (Math.log(0 + 2) - 1.5));
  meta[86] = Math.fround(0.5 * Math.log(size * size / 361));
  const days = Math.round((Date.UTC(2020, 2, 1) - Date.UTC(1970, 0, 1)) / 86400000);
  let period = 7;
  const factor = Math.pow(80000, 1 / 31);
  for (let i = 0; i < 32; i++) {
    const turns = days / period;
    meta[87 + i * 2] = Math.cos(turns * 2 * Math.PI);
    meta[88 + i * 2] = Math.sin(turns * 2 * Math.PI);
    period *= factor;
  }
  meta[151 + 2] = 1; // source: KGS
  return meta;
}
