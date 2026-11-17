/** One screen: the board, your rank, a game with a bot of that rank, then the result and territory. */
import { play, replay, startPosition, isLegal } from './rules.mjs';
import { boardSize, botFloorKyu, botFor, chooseBotMove, evenKomi, finalOwnership, gtpOf, handicapFor, handicapStones, nextKyu, rankText, strongestKyu, weakestKyu } from './bot.mjs';
import { countGame } from './score.mjs';
import { createBackend } from './backend.mjs';
import { playStone, wakeSound } from './sound.mjs';

const historyLimit = 5000;
const botPause = 400;

const backend = createBackend();
const { engine } = backend;
const root = document.getElementById('app');
// With no saved games the rank starts at the weakest.
const firstState = () => ({ version: 1, kyu: weakestKyu, game: null, history: [] });
let state = firstState();
/** What runs now: 'bot' while the bot picks a move, 'count' while KataGo counts the end. */
let busy = '';
/** KataGo failed; the game waits for «Повторить». */
let problem = '';
/** A one-line remark: an illegal move or a failed save. */
let note = '';
let ghost = null;
/** The bot's net downloading in the page-only build: `{ loaded, total }`, or null. */
let download = null;
let resignAsked = false;

function validState(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  if (!Number.isInteger(value.kyu) || value.kyu > weakestKyu || value.kyu < strongestKyu) return null;
  const { game } = value;
  if (game !== null) {
    if (typeof game !== 'object' || ![1, 2].includes(game.color) || !Array.isArray(game.moves)) return null;
    if (!['playing', 'over'].includes(game.status) || !Number.isInteger(game.kyu)) return null;
    // Games saved before the handicap was added are even games.
    game.stones ??= [];
    game.komi ??= evenKomi;
    if (!Array.isArray(game.stones) || typeof game.komi !== 'number') return null;
    try { replay(boardSize, game.moves, game.stones); } catch { return null; }
  }
  return { ...value, history: Array.isArray(value.history) ? value.history : [] };
}

/* The game */
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const gamePosition = () => replay(boardSize, state.game.moves, state.game.stones);
const yourTurn = () => state.game?.status === 'playing' && !busy && !problem && gamePosition().toPlay === state.game.color;
const save = () => backend.save(state);

/** Even games alternate colors; with a handicap you are black. */
function startGame() {
  const last = state.game;
  const { stones, komi } = handicapFor(state.kyu);
  const handicap = stones > 0 || komi !== evenKomi;
  const color = handicap || !last ? 1 : 3 - last.color;
  state.game = { kyu: state.kyu, color, stones: handicapStones(stones), komi, moves: [], status: 'playing', end: null };
  note = '';
  problem = '';
  save();
  render();
  continueGame();
}
/** The bot moves when it is its turn; two passes end the game. */
function continueGame() {
  const { game } = state;
  if (game?.status !== 'playing') return;
  const current = gamePosition();
  if (current.passes >= 2) finishGame('count');
  else if (current.toPlay !== game.color) botTurn();
}
function addMove(point) {
  state.game.moves.push(point);
  if (point !== null) playStone();
  save();
}
function userMove(point) {
  if (!yourTurn()) return;
  if (point !== null) {
    try { play(gamePosition(), point); } catch (error) {
      note = error.message;
      render();
      return;
    }
  }
  note = '';
  ghost = null;
  resignAsked = false;
  addMove(point);
  render();
  continueGame();
}
async function botTurn() {
  const { game } = state;
  busy = 'bot';
  render();
  try {
    const [point] = await Promise.all([chooseBotMove(engine, game, gamePosition(), botFor(game.kyu)), pause(botPause)]);
    if (state.game !== game) return;
    busy = '';
    addMove(point);
  } catch (error) {
    if (state.game !== game) return;
    busy = '';
    problem = error.message;
    render();
    return;
  }
  render();
  continueGame();
}
async function finishGame(how) {
  const { game } = state;
  let end = { how, winner: 3 - game.color };
  if (how === 'count') {
    busy = 'count';
    render();
    try {
      const ownership = await finalOwnership(engine, game);
      if (state.game !== game) return;
      end = { how, ...countGame(ownership, gamePosition(), game.komi) };
    } catch (error) {
      if (state.game !== game) return;
      busy = '';
      problem = error.message;
      render();
      return;
    }
    busy = '';
  }
  end.kyuAfter = nextKyu(game.kyu, end.winner === game.color);
  state.kyu = end.kyuAfter;
  game.status = 'over';
  game.end = end;
  state.history.push({
    date: new Date().toISOString(),
    kyu: game.kyu,
    color: game.color,
    handicap: game.stones.length,
    komi: game.komi,
    moves: game.moves.map((point) => gtpOf(point, boardSize)).join(' '),
    winner: end.winner,
    margin: end.margin ?? null,
    how,
  });
  if (state.history.length > historyLimit) state.history.splice(0, state.history.length - historyLimit);
  resignAsked = false;
  save();
  render();
}
function resign() {
  if (!yourTurn()) return;
  if (!resignAsked) {
    resignAsked = true;
    render();
    return;
  }
  finishGame('resign');
}
function retry() {
  problem = '';
  render();
  continueGame();
}

/* The board */
const svgSpace = 'http://www.w3.org/2000/svg';
const cell = 64;
const edge = cell * 0.95;
const boardSide = edge * 2 + cell * (boardSize - 1);
const stoneRadius = cell * 0.47;
const stars = [20, 24, 56, 60, 40];
const boardLetters = 'ABCDEFGHJ';
const center = (index) => edge + index * cell;
const inks = { 1: '#0e0f11', 2: '#f7f6f1' };

function svgNode(tag, attributes = {}, text = null) {
  const node = document.createElementNS(svgSpace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  return node;
}
function stoneNode(point, color, opacity = 1) {
  const x = center(point % boardSize);
  const y = center(Math.floor(point / boardSize));
  const group = svgNode('g', { opacity });
  group.append(svgNode('circle', { cx: x + 1, cy: y + 2.5, r: stoneRadius, fill: '#28190a', opacity: 0.35 }));
  group.append(svgNode('circle', { cx: x, cy: y, r: stoneRadius, fill: `url(#stone-${color})` }));
  return group;
}
function drawBoard(svg, shown, owners) {
  svg.replaceChildren();
  const defs = svgNode('defs');
  for (const [color, stops] of [[1, [['0%', '#5b5e63'], ['55%', '#1c1d20'], ['100%', '#0e0f11']]], [2, [['0%', '#ffffff'], ['60%', '#efede6'], ['100%', '#c8c5ba']]]]) {
    const gradient = svgNode('radialGradient', { id: `stone-${color}`, cx: '36%', cy: '30%', r: '75%' });
    for (const [offset, ink] of stops) gradient.append(svgNode('stop', { offset, 'stop-color': ink }));
    defs.append(gradient);
  }
  svg.append(defs, svgNode('rect', { width: boardSide, height: boardSide, rx: 10, fill: '#ddb56c' }));
  const first = center(0);
  const last = center(boardSize - 1);
  let lines = '';
  for (let i = 0; i < boardSize; i++) lines += `M${first} ${center(i)}H${last}M${center(i)} ${first}V${last}`;
  svg.append(svgNode('path', { d: lines, stroke: '#6e5228', 'stroke-width': 1.4, fill: 'none' }));
  for (const point of stars) svg.append(svgNode('circle', { cx: center(point % boardSize), cy: center(Math.floor(point / boardSize)), r: 4.5, fill: '#5a4320' }));
  const labels = svgNode('g', { fill: '#5a4320', 'font-size': 17, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': 'ui-monospace, Menlo, monospace' });
  for (let i = 0; i < boardSize; i++) {
    for (const at of [edge * 0.36, boardSide - edge * 0.36]) {
      labels.append(svgNode('text', { x: center(i), y: at }, boardLetters[i]), svgNode('text', { x: at, y: center(i) }, boardSize - i));
    }
  }
  svg.append(labels);
  shown.board.forEach((color, point) => {
    if (color) svg.append(stoneNode(point, color, owners?.[point] ? 0.45 : 1));
  });
  if (ghost !== null) svg.append(stoneNode(ghost, state.game.color, 0.5));
  if (owners) {
    owners.forEach((owner, point) => {
      if (!owner) return;
      const side = cell * (shown.board[point] ? 0.3 : 0.36);
      svg.append(svgNode('rect', { x: center(point % boardSize) - side / 2, y: center(Math.floor(point / boardSize)) - side / 2, width: side, height: side, fill: inks[owner], stroke: inks[3 - owner], 'stroke-opacity': 0.5, 'stroke-width': 1.2 }));
    });
  }
  if (shown.last !== null && !owners) {
    const point = shown.last;
    svg.append(svgNode('circle', { cx: center(point % boardSize), cy: center(Math.floor(point / boardSize)), r: stoneRadius * 0.55, fill: 'none', stroke: inks[3 - shown.board[point]], 'stroke-width': 3 }));
  }
}
/** A finger aims this far above itself, so it does not cover the stone it carries. */
const fingerLift = cell * 0.75;
function pointAt(svg, event) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const lift = event.pointerType === 'touch' ? fingerLift : 0;
  const x = Math.round((local.x - edge) / cell);
  const y = Math.round((local.y - lift - edge) / cell);
  return x >= 0 && y >= 0 && x < boardSize && y < boardSize ? y * boardSize + x : null;
}
function boardView(shown) {
  const { game } = state;
  const owners = game?.status === 'over' ? game.end.owners ?? null : null;
  const svg = svgNode('svg', { id: 'board', viewBox: `0 0 ${boardSide} ${boardSide}`, role: 'img', 'aria-label': 'Доска 9 × 9' });
  const active = yourTurn();
  svg.classList.toggle('active', active);
  drawBoard(svg, shown, owners);
  if (active) {
    // A mouse shows the ghost stone on hover. A finger shows it while pressed, three quarters of a point above
    // itself, and drags it about; the stone lands where the ghost is when the finger lifts, and a ghost
    // off the board puts nothing.
    let pressed = false;
    const showGhost = (event) => {
      const point = pointAt(svg, event);
      const next = point !== null && isLegal(shown, point) ? point : null;
      if (next === ghost) return;
      ghost = next;
      drawBoard(svg, shown, owners);
    };
    svg.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      pressed = true;
      try { svg.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone */ }
      showGhost(event);
    });
    svg.addEventListener('pointermove', (event) => {
      if (pressed || event.pointerType === 'mouse') showGhost(event);
    });
    svg.addEventListener('pointerup', (event) => {
      if (!pressed) return;
      pressed = false;
      const point = pointAt(svg, event);
      if (point !== null) userMove(point);
      else if (ghost !== null) {
        ghost = null;
        drawBoard(svg, shown, owners);
      }
    });
    const drop = () => {
      pressed = false;
      if (ghost === null) return;
      ghost = null;
      drawBoard(svg, shown, owners);
    };
    svg.addEventListener('pointercancel', drop);
    svg.addEventListener('pointerleave', (event) => {
      if (!pressed && event.pointerType === 'mouse') drop();
    });
  }
  const area = el('div', 'board-area');
  area.append(svg);
  return area;
}

/* The panel */
const numberText = (value) => value.toLocaleString('ru-RU').replace('-', '−');
const sideName = { 1: 'Чёрные', 2: 'Белые' };
function el(tag, className = '', text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}
function button(label, className, action, disabled = false) {
  const node = el('button', className, label);
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}
const stoneWord = (count) => (count < 5 ? 'камня' : 'камней');
/** The handicap of a game in words, empty for an even game. */
function handicapText({ stones, komi }) {
  if (!stones.length && komi === evenKomi) return '';
  const parts = stones.length ? [`${stones.length} ${stoneWord(stones.length)}`] : [];
  parts.push(`коми ${numberText(komi)}`);
  return `Фора: ${parts.join(', ')}`;
}
function playerRow(color, name, prisoners) {
  const row = el('div', 'player');
  row.append(el('span', `stone-mark ${color === 1 ? 'black' : 'white'}`), el('span', 'name', name), el('span', 'prisoners', `пленные ${prisoners}`));
  return row;
}
const megabytes = (bytes) => Math.round(bytes / 1e6);
/** The first start of the page-only build downloads the bot's net once. */
function downloadText() {
  if (!download) return '';
  if (download.preparing) return 'Готовлю бота…';
  const total = download.total ? ` из ${megabytes(download.total)}` : '';
  return `Загружаю бота: ${megabytes(download.loaded)}${total} МБ, только в первый раз`;
}
function statusText(shown) {
  if (busy && download) return downloadText();
  if (busy === 'bot') return 'Бот думает…';
  if (busy === 'count') return 'Считаем территорию…';
  if (shown.passes === 1) return 'Бот спасовал. Твой пас в ответ закончит партию.';
  return 'Твой ход';
}
function countTable({ sides }) {
  const table = el('table', 'count');
  const rows = [
    ['', sideName[1], sideName[2]],
    ['Территория', sides[1].territory, sides[2].territory],
    ['Пленные', sides[1].prisoners, sides[2].prisoners],
    ['Коми', '', numberText(sides[2].komi)],
    ['Итого', numberText(sides[1].total), numberText(sides[2].total)],
  ];
  rows.forEach((cells, index) => {
    const row = el('tr', index === rows.length - 1 ? 'total' : '');
    cells.forEach((value, column) => row.append(el(index === 0 || column === 0 ? 'th' : 'td', '', String(value))));
    table.append(row);
  });
  return table;
}
function resultBlock(game) {
  const { end } = game;
  const won = end.winner === game.color;
  const block = el('section', 'result');
  const head = el('div', 'verdict-line');
  head.append(el('p', `verdict ${won ? 'won' : 'lost'}`, won ? 'Победа' : 'Поражение'),
    el('p', 'margin', end.how === 'resign' ? 'Ты сдался' : `${sideName[end.winner]} +${numberText(end.margin)}`));
  block.append(head);
  if (end.how !== 'resign') block.append(countTable(end));
  const moved = end.kyuAfter !== game.kyu;
  block.append(el('p', 'rank-change', moved ? `Ранг: ${rankText(game.kyu)} → ${rankText(end.kyuAfter)}` : `Ранг остался ${rankText(game.kyu)}`));
  return block;
}
function sidePanel(shown) {
  const { game } = state;
  const side = el('aside', 'side');
  const rank = el('div', 'rank');
  rank.append(el('span', 'rank-label', 'Твой ранг'), el('span', 'rank-value', rankText(state.kyu)));
  side.append(rank);
  if (!game) {
    side.append(el('p', 'muted', `Партия 9 × 9 с ботом твоего ранга. Победа поднимает ранг на ступень, поражение опускает. Слабее ${rankText(botFloorKyu)} бот играет как ${rankText(botFloorKyu)} и даёт фору.`),
      button('Начать партию', 'primary', startGame));
  } else {
    const players = el('div', 'players');
    players.append(playerRow(game.color, 'Ты', shown.captured[game.color]), playerRow(3 - game.color, `Бот · ${rankText(Math.min(game.kyu, botFloorKyu))}`, shown.captured[3 - game.color]));
    side.append(players);
    const handicap = handicapText(game);
    if (handicap) side.append(el('p', 'handicap', handicap));
    if (game.status === 'over') side.append(resultBlock(game), button('Новая партия', 'primary', startGame));
    else if (problem) {
      side.append(el('p', 'status error', `KataGo не ответил: ${problem}`), button('Повторить', 'primary', retry));
    } else {
      const actions = el('div', 'actions');
      const open = yourTurn();
      actions.append(button('Пас', 'outline', () => userMove(null), !open),
        button(resignAsked ? 'Точно сдаться?' : 'Сдаться', resignAsked ? 'outline danger' : 'outline', resign, !open));
      const status = el('p', 'status', statusText(shown));
      if (busy && download) status.id = 'download';
      side.append(status, actions);
    }
  }
  if (download && !busy) side.append(Object.assign(el('p', 'muted', downloadText()), { id: 'download' }));
  if (note) side.append(el('p', 'note', note));
  side.append(el('p', 'rules muted', `9 × 9 · японские правила · коми ${numberText(game?.komi ?? evenKomi)}`));
  return side;
}

function render() {
  const shown = state.game ? gamePosition() : startPosition(boardSize);
  root.classList.toggle('over', state.game?.status === 'over');
  root.replaceChildren(boardView(shown), sidePanel(shown));
}

/** Another screen moved on: this one shows its state and goes on from there. */
function adopt(fresh) {
  const next = validState(fresh);
  if (!next) return;
  state = next;
  busy = '';
  problem = '';
  note = '';
  ghost = null;
  resignAsked = false;
  render();
  continueGame();
}
function offlineView(message) {
  const box = el('section', 'offline');
  box.append(el('p', 'status', 'Нет связи с Mac'),
    el('p', 'muted', `Сервис nine на Mac не ответил: ${message}. Mac должен быть включён и не спать.`),
    button('Повторить', 'primary', () => location.reload()));
  root.replaceChildren(box);
}

async function start() {
  let loaded;
  try {
    loaded = await backend.load();
  } catch (error) {
    offlineView(error instanceof TypeError ? 'нет ответа' : error.message);
    return;
  }
  const saved = validState(loaded.state);
  state = saved ?? firstState();
  note = loaded.error || (loaded.state && !saved ? 'Сохранение не прочитано, начато заново.' : '');
  backend.onSave((detail) => {
    if (detail.ok) return;
    note = `Не сохранено: ${detail.error}`;
    render();
  });
  backend.onConflict(adopt);
  // A phone keeps the page asleep in the background: on return it catches up with the other screens.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const fresh = await backend.refresh().catch(() => null);
    if (fresh) adopt(fresh);
  });
  document.addEventListener('pointerdown', wakeSound);
  // Progress changes only its own line: a full redraw would break a stone being dragged.
  backend.onEngineProgress?.((progress) => {
    const started = !download !== !progress;
    download = progress;
    if (started) render();
    else document.getElementById('download')?.replaceChildren(downloadText());
  });
  backend.warmUp?.().catch(() => { /* the first move shows the error */ });
  render();
  continueGame();
}
start();
