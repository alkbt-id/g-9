/**
 * Where the saved state and KataGo live. Two builds of the same page:
 * - the service on the Mac (`server.mjs`): one state for every screen, KataGo with search;
 * - the page alone (GitHub Pages, `<html data-mode="local">`): the state in this browser, the net in the page.
 */

const writeHeaders = { 'X-Nine': '1', 'Content-Type': 'application/json' };
const offline = 'нет связи с Mac';

async function failure(response) {
  return new Error((await response.text()) || `ошибка ${response.status}`);
}

export function createBackend() {
  return document.documentElement.dataset.mode === 'local' ? localBackend() : serviceBackend();
}

const localKey = 'nine-state';
function localBackend() {
  let saveHandler = () => {};
  let engine = null;
  const engineReady = import('./browser-engine.mjs').then(({ createBrowserEngine }) => (engine = createBrowserEngine()));
  return {
    async load() {
      try {
        return { state: JSON.parse(localStorage.getItem(localKey) ?? 'null'), error: '' };
      } catch (error) {
        return { state: null, error: `Сохранение не прочитано: ${error.message}` };
      }
    },
    save(state) {
      try {
        localStorage.setItem(localKey, JSON.stringify(state));
      } catch (error) {
        saveHandler({ ok: false, error: error.message });
      }
    },
    onSave(handler) { saveHandler = handler; },
    onConflict() {},
    async refresh() { return null; },
    /** Download of the bot's net: `{ loaded, total }` while it runs, `null` when done. */
    onEngineProgress(handler) { engineReady.then((ready) => ready.onProgress(handler)); },
    warmUp() { return engineReady.then((ready) => ready.warmUp()); },
    engine: { query: async (fields) => (engine ?? await engineReady).query(fields) },
  };
}

function serviceBackend() {
  let revision = null;
  /** The latest state waiting to be sent: saves in a row collapse into one, it is a full snapshot. */
  let pending = null;
  let sending = false;
  let saveHandler = () => {};
  let conflictHandler = () => {};

  async function flush() {
    if (sending) return;
    sending = true;
    while (pending !== null) {
      const text = pending;
      pending = null;
      try {
        const response = await fetch('api/state', { method: 'PUT', headers: writeHeaders, body: `{"rev":${JSON.stringify(revision)},"state":${text}}` });
        if (response.status === 409) {
          // Another screen saved first: its state wins, what was waiting here is dropped.
          const fresh = await response.json();
          revision = fresh.rev;
          pending = null;
          conflictHandler(fresh.state);
        } else if (!response.ok) {
          saveHandler({ ok: false, error: (await failure(response)).message });
        } else {
          revision = (await response.json()).rev;
        }
      } catch {
        saveHandler({ ok: false, error: offline });
      }
    }
    sending = false;
  }

  return {
    async load() {
      const response = await fetch('api/state');
      if (!response.ok) throw await failure(response);
      const body = await response.json();
      revision = body.rev;
      return { state: body.state, error: body.error };
    },
    save(state) {
      pending = JSON.stringify(state);
      flush();
    },
    onSave(handler) { saveHandler = handler; },
    /** Called with the state another screen saved, when it overwrote this one's. */
    onConflict(handler) { conflictHandler = handler; },
    /** The state if another screen changed it since, otherwise `null`. */
    async refresh() {
      if (sending || pending !== null) return null;
      const response = await fetch('api/state');
      if (!response.ok || sending || pending !== null) return null;
      const body = await response.json();
      if (body.rev === revision) return null;
      revision = body.rev;
      return body.state;
    },
    /** KataGo's analysis engine: one query, one answer. */
    engine: {
      async query(fields) {
        let response;
        try {
          response = await fetch('api/engine', { method: 'POST', headers: writeHeaders, body: JSON.stringify(fields) });
        } catch {
          throw new Error(offline);
        }
        if (!response.ok) throw await failure(response);
        return response.json();
      },
    },
  };
}
