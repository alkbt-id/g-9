/**
 * KataGo's human SL net in the page, for the build without a Mac (GitHub Pages). It answers the two questions
 * nine asks KataGo, in the same JSON: the human policy for the bot's move, and who owns each point at the end.
 * There is no search: the net is asked once. The bot passes when a pass is the net's most likely move;
 * the end is counted by the net's ownership. Both were checked against KataGo on real games of nine.
 */
import { fillInputs, profileMeta, spatialFeatures, globalFeatures, metaFeatures } from './katago-inputs.mjs';
import { replay, isLegal } from './rules.mjs';

const ortDir = 'ort-1.31.1/';
const ortModule = `${ortDir}ort.wasm.min.mjs`;
/** The net, cut in parts: GitHub keeps files under 100 MB. */
const modelParts = ['model/human-9.onnx.0', 'model/human-9.onnx.1'];
const modelCache = 'nine-model-v1';
/** Set while the net loads: if the page dies on the way, the next start does not load it again on its own. */
const loadingFlag = 'nine-engine-loading';
const flag = {
  get() { try { return localStorage.getItem(loadingFlag) === '1'; } catch { return false; } },
  set(on) { try { if (on) localStorage.setItem(loadingFlag, '1'); else localStorage.removeItem(loadingFlag); } catch { /* fine */ } },
};
const columns = 'ABCDEFGHJKLMNOPQRST';

/** The net's input and output for symmetry `s` (0..7), as KataGo turns the board: transpose, then flips. */
function symmetric(point, size, s) {
  let x = point % size;
  let y = Math.floor(point / size);
  if (s & 4) [x, y] = [y, x];
  if (s & 2) x = size - 1 - x;
  if (s & 1) y = size - 1 - y;
  return y * size + x;
}

/** The model's bytes: from the cache after the first time, otherwise downloaded with progress. */
async function modelBytes(onProgress) {
  let cache = null;
  try { cache = await caches.open(modelCache); } catch { /* no Cache API: download each time */ }
  const responses = [];
  for (const part of modelParts) {
    let response = await cache?.match(part);
    if (!response) {
      response = await fetch(part);
      if (!response.ok) throw new Error(`модель бота не скачалась (${response.status})`);
      if (cache) {
        await cache.put(part, response.clone());
        response = await cache.match(part);
      }
    }
    responses.push(response);
  }
  const sizes = responses.map((response) => Number(response.headers.get('Content-Length') || 0));
  const total = sizes.every(Boolean) ? sizes.reduce((sum, size) => sum + size, 0) : 0;
  // One buffer of the full size when the sizes are known: a phone has little memory to spare for copies.
  let bytes = new Uint8Array(total);
  let loaded = 0;
  for (const response of responses) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > bytes.length) {
        const grown = new Uint8Array(Math.max(loaded + value.length, bytes.length * 2));
        grown.set(bytes.subarray(0, loaded));
        bytes = grown;
      }
      bytes.set(value, loaded);
      loaded += value.length;
      onProgress?.(loaded, total);
    }
  }
  return loaded === bytes.length ? bytes : bytes.slice(0, loaded);
}

export function createBrowserEngine() {
  let session = null;
  let loading = null;
  let progressHandler = () => {};
  let ort = null;

  async function load() {
    loading ??= (async () => {
      flag.set(true);
      ort = await import(`./${ortModule}`);
      ort.env.wasm.wasmPaths = new URL(ortDir, import.meta.url).href;
      // GitHub Pages cannot turn on cross-origin isolation, so WebAssembly runs on one thread.
      ort.env.wasm.numThreads = 1;
      const bytes = await modelBytes((loaded, total) => progressHandler({ loaded, total }));
      progressHandler({ loaded: 1, total: 1, preparing: true });
      // WebAssembly only: WebGPU took about twice the memory on this net, and Safari on the iPhone closed the page.
      // No memory arena and plain graph optimization: the same speed here, a faster start.
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'], graphOptimizationLevel: 'basic', enableCpuMemArena: false, enableMemPattern: false,
      });
      flag.set(false);
      progressHandler(null);
    })().catch((error) => {
      flag.set(false);
      loading = null;
      progressHandler(null);
      throw error;
    });
    return loading;
  }

  /** One look of the net at the position, the board turned by a random symmetry as KataGo does. */
  async function evaluate(game, profile) {
    await load();
    const { size } = game;
    const area = size * size;
    const { spatial, global, pla } = fillInputs(game);
    const s = Math.floor(Math.random() * 8);
    const turned = new Float32Array(spatial.length);
    for (let feature = 0; feature < spatialFeatures; feature++) {
      for (let point = 0; point < area; point++) turned[feature * area + symmetric(point, size, s)] = spatial[feature * area + point];
    }
    const outputs = await session.run({
      spatial: new ort.Tensor('float32', turned, [1, spatialFeatures, size, size]),
      global: new ort.Tensor('float32', global, [1, globalFeatures]),
      meta: new ort.Tensor('float32', profileMeta(profile ?? 'rank_5k', size), [1, metaFeatures]),
    });
    const policy = outputs.policy.data;
    const ownership = outputs.ownership.data;
    const logits = new Float64Array(area + 1);
    const owner = new Array(area);
    for (let point = 0; point < area; point++) {
      const at = symmetric(point, size, s);
      logits[point] = policy[at];
      // The net speaks for the side to move; nine counts from black's side.
      owner[point] = Math.tanh(ownership[at]) * (pla === 1 ? 1 : -1);
    }
    logits[area] = policy[area];
    return { logits, owner };
  }

  return {
    onProgress(handler) { progressHandler = handler; },
    /** Starts the download before the first move needs it, unless the last load killed the page. */
    warmUp() { return flag.get() ? Promise.resolve() : load(); },
    /** The subset of KataGo's analysis JSON that nine sends. */
    async query(fields) {
      const size = fields.boardXSize;
      const pointOf = (gtp) => (gtp === 'pass' ? null : (size - Number(gtp.slice(1))) * size + columns.indexOf(gtp[0]));
      const stones = fields.initialStones.map(([, gtp]) => pointOf(gtp));
      const moves = fields.moves.map(([, gtp]) => pointOf(gtp));
      const { logits, owner } = await evaluate({ size, stones, moves, komi: fields.komi }, fields.overrideSettings?.humanSLProfile);
      const position = replay(size, moves, stones);
      const legal = (point) => point === size * size || isLegal(position, point);
      let max = -Infinity;
      logits.forEach((value, point) => { if (legal(point)) max = Math.max(max, value); });
      let sum = 0;
      const policy = Array.from(logits, (value, point) => {
        if (!legal(point)) return -1;
        const weight = Math.exp(value - max);
        sum += weight;
        return weight;
      });
      policy.forEach((value, point) => { if (value >= 0) policy[point] = value / sum; });
      let best = size * size;
      policy.forEach((value, point) => { if (value > policy[best]) best = point; });
      const answer = { id: fields.id, humanPolicy: policy, moveInfos: [{ move: best === size * size ? 'pass' : columns[best % size] + (size - Math.floor(best / size)) }] };
      if (fields.includeOwnership) answer.ownership = owner;
      return answer;
    },
  };
}
