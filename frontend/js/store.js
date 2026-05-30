// Minimal observable store: shallow-merge setState, subscribe, and a request
// counter so tests can await `settle()` instead of sleeping.

function createStore(initial) {
  let state = initial;
  const subscribers = new Set();
  let inFlight = 0;
  let waiters = [];

  function notify() {
    for (const fn of subscribers) fn(state);
  }

  return {
    getState: () => state,
    setState(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      notify();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    beginRequest() {
      inFlight += 1;
    },
    endRequest() {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0 && waiters.length) {
        const pending = waiters;
        waiters = [];
        pending.forEach((r) => r());
      }
    },
    inFlight: () => inFlight,
    settle() {
      return inFlight === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

export const store = createStore({
  locale: 'en', // set by initLocale() at boot (saved choice or browser language)
  profiles: [],
  activeProfileId: null,
  buckets: [],
  bucketsStatus: 'idle', // idle | loading | loaded | error
  bucketsError: null,
  location: { bucket: null, prefix: '' },
  listing: {
    status: 'idle', // idle | loading | loaded | error
    prefix: '',
    folders: [],
    files: [],
    isTruncated: false,
    nextContinuationToken: null,
    error: null,
  },
  selection: new Set(),
  search: '',
  recursive: null, // null | { query, prefix, status, results, nextToken, loadingMore, error } — paginated recursive search
  sort: { col: 'name', dir: 'asc' },
  uploads: [], // { id, name, sent, total, status: checking|queued|uploading|retrying|conflict|done|error|cancelled, error, rate, attempts }
  downloads: [], // { id, kind, name, received, total, status: queued|downloading|done|error|cancelled, error, rate, runtime }
  transferExpanded: false, // transfer center maximized to a full-window panel
  ui: {
    profileModal: null, // null | { mode:'add'|'edit', profileId? }
    confirm: null, // null | { title, message, danger, resolve }
    prompt: null, // null | { title, label, value, okText, validate, resolve }
    expandedDownloads: [], // ids of folder-to-disk downloads whose detail panel is open
  },
});
