/**
 * Played games as files: one game as SGF, many as a zip of SGF files, and saving a file from the page.
 * Board-size agnostic: the same file serves nine and thirteen.
 */

const columns = 'ABCDEFGHJKLMNOPQRST';
const sgfLetters = 'abcdefghijklmnopqrs';
const colorLetter = { 1: 'B', 2: 'W' };

/** `D4` on a board of `size` → SGF `dj`; `pass` → an empty value. */
export function sgfPoint(gtp, size) {
  if (gtp === 'pass') return '';
  const column = columns.indexOf(gtp[0]);
  const row = size - Number(gtp.slice(1));
  if (column < 0 || column >= size || !(row >= 0 && row < size)) throw new Error(`Неверный ход: ${gtp}`);
  return sgfLetters[column] + sgfLetters[row];
}

/** Ranks in SGF: `5k`, `2d`. */
const sgfRank = (kyu) => (kyu >= 1 ? `${kyu}k` : `${1 - kyu}d`);
const escape = (text) => String(text).replace(/[\\\]]/g, (match) => `\\${match}`);
const pad = (number) => String(number).padStart(2, '0');
const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The SGF result: `B+8.5`, `W+R`. */
function sgfResult({ winner, margin, how }) {
  if (how === 'resign') return `${colorLetter[winner]}+R`;
  if (margin === 0) return '0';
  return `${colorLetter[winner]}+${margin}`;
}

/**
 * One saved game as SGF. `entry` is a history record: `{ date, kyu, color, komi, moves, winner, margin, how }`
 * with moves as GTP points; `stones` are the handicap stones as GTP points; `botKyu` is the bot's rank.
 */
export function gameSgf(entry, { size, stones = [], botKyu, app }) {
  const you = entry.color;
  const ranks = { [you]: sgfRank(entry.kyu), [3 - you]: sgfRank(botKyu) };
  const names = { [you]: 'Ты', [3 - you]: 'Бот' };
  let text = `(;GM[1]FF[4]CA[UTF-8]AP[${escape(app)}]SZ[${size}]RU[Japanese]KM[${entry.komi}]`;
  text += `DT[${localDate(new Date(entry.date))}]PB[${names[1]}]BR[${ranks[1]}]PW[${names[2]}]WR[${ranks[2]}]`;
  text += `RE[${sgfResult(entry)}]`;
  if (stones.length) text += `HA[${stones.length}]AB${stones.map((gtp) => `[${sgfPoint(gtp, size)}]`).join('')}`;
  let color = stones.length ? 2 : 1;
  const moves = entry.moves ? entry.moves.split(' ') : [];
  for (const gtp of moves) {
    text += `\n;${colorLetter[color]}[${sgfPoint(gtp, size)}]`;
    color = 3 - color;
  }
  return `${text})\n`;
}

/** A file name from the game's local start time: `g13-2026-11-17-1925.sgf`. */
export function gameFileName(entry, prefix) {
  const date = new Date(entry.date);
  return `${prefix}-${localDate(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.sgf`;
}

/* A zip without compression: SGF files are small, and a stored zip needs no library. */
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** `files` is `[{ name, text, date }]`; returns the zip's bytes. */
export function zipFiles(files) {
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const date = file.date ?? new Date();
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    // Version 2.0, UTF-8 names (bit 11), stored.
    const common = [[20, 2], [0x0800, 2], [0, 2], [dosTime, 2], [dosDate, 2], [crc, 4], [data.length, 4], [data.length, 4], [name.length, 2], [0, 2]];
    const local = fields([[0x04034b50, 4], ...common]);
    parts.push(local, name, data);
    directory.push(fields([[0x02014b50, 4], [20, 2], ...common, [0, 2], [0, 2], [0, 2], [0, 4], [offset, 4]]), name);
    offset += local.length + name.length + data.length;
  }
  const size = directory.reduce((sum, part) => sum + part.length, 0);
  const end = fields([[0x06054b50, 4], [0, 2], [0, 2], [files.length, 2], [files.length, 2], [size, 4], [offset, 4], [0, 2]]);
  const all = [...parts, ...directory, end];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of all) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
function fields(list) {
  const bytes = new Uint8Array(list.reduce((sum, [, width]) => sum + width, 0));
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const [value, width] of list) {
    if (width === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += width;
  }
  return bytes;
}

/**
 * Saves a file from the page. A phone gets the share sheet («Сохранить в Файлы»); elsewhere the file downloads —
 * the Mac window puts it into Downloads.
 */
export function saveFile(name, data, type) {
  const file = new File([data], name, { type });
  const touch = matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => { /* closed without saving */ });
    return;
  }
  const url = URL.createObjectURL(file);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
