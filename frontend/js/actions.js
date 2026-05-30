// Orchestration layer: every user action and data load lives here so UI modules
// stay thin. Imports only leaf modules (store/api/router/modals) — never
// components — to keep the dependency graph acyclic.
import { store } from './store.js';
import { api } from './api.js';
import { parseHash, navigate } from './router.js';
import { t } from './i18n.js';
import { toast } from './ui/Toasts.js';
import { confirm } from './ui/ConfirmModal.js';
import { prompt } from './ui/PromptModal.js';
import { openConflict } from './ui/ConflictModal.js';
import { openShare } from './ui/ShareModal.js';
import { openInfo } from './ui/InfoModal.js';
import { multipartUpload, abandonMultipart, MULTIPART_THRESHOLD } from './multipartUpload.js';
import { putTransfer, deleteTransfer, allTransfers } from './transferStore.js';

const EMPTY_LISTING = {
  status: 'idle',
  prefix: '',
  folders: [],
  files: [],
  isTruncated: false,
  nextContinuationToken: null,
  error: null,
};

const baseName = (key) => {
  const s = key.endsWith('/') ? key.slice(0, -1) : key;
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
};

// ---- Loads -----------------------------------------------------------------

// Monotonic token: a listing response is only applied if no newer load (from
// navigation / refresh / upload-settle) has started since it was issued. This
// prevents a slow response for an old folder clobbering the folder the user
// has since navigated to.
let listGen = 0;

async function loadProfiles() {
  try {
    const { profiles } = await api.listProfiles();
    store.setState({ profiles });
    return profiles;
  } catch (e) {
    toast({ kind: 'error', message: t('flow.loadProfilesFailed', { msg: e.message }) });
    return [];
  }
}

async function loadBuckets() {
  const pid = store.getState().activeProfileId;
  if (!pid) {
    store.setState({ buckets: [], bucketsStatus: 'idle', bucketsError: null });
    return;
  }
  store.setState({ bucketsStatus: 'loading', bucketsError: null });
  try {
    const { buckets } = await api.listBuckets();
    store.setState({ buckets, bucketsStatus: 'loaded' });
  } catch (e) {
    store.setState({ buckets: [], bucketsStatus: 'error', bucketsError: e.message });
    toast({ kind: 'error', message: t('flow.listBucketsFailed', { msg: e.message }) });
  }
}

async function loadListing() {
  const { activeProfileId, location } = store.getState();
  if (!activeProfileId || !location.bucket) {
    store.setState({ listing: { ...EMPTY_LISTING } });
    return;
  }
  const gen = (listGen += 1);
  store.setState((s) => ({ listing: { ...s.listing, status: 'loading', error: null, prefix: location.prefix } }));
  try {
    const r = await api.listObjects(location.bucket, location.prefix);
    if (gen !== listGen) return; // a newer load superseded this one
    store.setState({
      listing: {
        status: 'loaded',
        prefix: r.prefix,
        folders: r.folders,
        files: r.files,
        isTruncated: r.isTruncated,
        nextContinuationToken: r.nextContinuationToken,
        error: null,
      },
    });
  } catch (e) {
    if (gen !== listGen) return;
    store.setState({
      listing: { ...EMPTY_LISTING, status: 'error', prefix: location.prefix, error: { code: e.code, message: e.message } },
    });
  }
}

async function loadMore() {
  const { location, listing } = store.getState();
  if (!listing.nextContinuationToken) return;
  const gen = listGen; // part of the current listing; don't start a new generation
  const bucket = location.bucket;
  const prefix = location.prefix;
  store.setState((s) => ({ listing: { ...s.listing, status: 'loading' } }));
  try {
    const r = await api.listObjects(bucket, prefix, listing.nextContinuationToken);
    const cur = store.getState();
    // Bail if the user navigated (or refreshed) away while this page loaded.
    if (gen !== listGen || cur.location.bucket !== bucket || cur.location.prefix !== prefix) return;
    store.setState((s) => ({
      listing: {
        status: 'loaded',
        prefix: r.prefix,
        folders: [...s.listing.folders, ...r.folders],
        files: [...s.listing.files, ...r.files],
        isTruncated: r.isTruncated,
        nextContinuationToken: r.nextContinuationToken,
        error: null,
      },
    }));
  } catch (e) {
    if (gen !== listGen) return;
    toast({ kind: 'error', message: e.message });
    store.setState((s) => ({ listing: { ...s.listing, status: 'loaded' } }));
  }
}

const refresh = () => loadListing();

// Recursive search: scan all objects under the current prefix on the server.
async function runRecursiveSearch() {
  const { location, search } = store.getState();
  const q = (search || '').trim();
  if (!location.bucket || !q) return;
  const prefix = location.prefix;
  store.setState({ recursive: { query: q, prefix, status: 'loading', results: [], nextToken: null, loadingMore: false, error: null } });
  try {
    const r = await api.search(location.bucket, prefix, q);
    const cur = store.getState().recursive;
    if (!cur || cur.query !== q || cur.prefix !== prefix) return; // superseded
    store.setState({ recursive: { query: q, prefix, status: 'loaded', results: r.results, nextToken: r.nextToken || null, loadingMore: false, error: null } });
  } catch (e) {
    const cur = store.getState().recursive;
    if (!cur || cur.query !== q || cur.prefix !== prefix) return;
    store.setState({ recursive: { ...cur, status: 'error', error: e.message } });
  }
}

// Continue a recursive search from where it stopped: append the next page of
// matches. The server resumes from the continuation token, so nothing is missed
// or duplicated. Slow buckets keep their prior results visible while it loads.
async function loadMoreRecursive() {
  const cur = store.getState().recursive;
  if (!cur || cur.status !== 'loaded' || !cur.nextToken || cur.loadingMore) return;
  const { query, prefix, nextToken } = cur;
  const bucket = store.getState().location.bucket;
  store.setState({ recursive: { ...cur, loadingMore: true } });
  try {
    const r = await api.search(bucket, prefix, query, nextToken);
    const c2 = store.getState().recursive;
    if (!c2 || c2.query !== query || c2.prefix !== prefix) return; // superseded by a new search
    store.setState({ recursive: { ...c2, results: [...c2.results, ...r.results], nextToken: r.nextToken || null, loadingMore: false } });
  } catch (e) {
    const c2 = store.getState().recursive;
    if (c2 && c2.query === query && c2.prefix === prefix) store.setState({ recursive: { ...c2, loadingMore: false } });
    toast({ kind: 'error', message: e.message });
  }
}

function clearRecursiveSearch() {
  if (store.getState().recursive) store.setState({ recursive: null });
}

// ---- Routing ---------------------------------------------------------------

async function onRoute() {
  const { profileId, bucket, prefix } = parseHash();
  const st = store.getState();
  let activeProfileId = st.activeProfileId;
  const profileExists = profileId && st.profiles.some((p) => p.id === profileId);
  if (profileExists) activeProfileId = profileId;
  else if (profileId && !st.profiles.length) activeProfileId = profileId; // pre-load race; will reconcile

  const profileChanged = activeProfileId !== st.activeProfileId;
  store.setState({
    activeProfileId,
    location: { bucket: bucket || null, prefix: prefix || '' },
    selection: new Set(),
    recursive: null,
  });

  if (activeProfileId && (profileChanged || st.bucketsStatus === 'idle')) {
    await loadBuckets();
  } else if (!activeProfileId) {
    store.setState({ buckets: [], bucketsStatus: 'idle' });
  }

  if (activeProfileId && bucket) await loadListing();
  else store.setState({ listing: { ...EMPTY_LISTING } });
}

const selectProfile = (id) => navigate({ profileId: id });
const selectBucket = (name) => navigate({ profileId: store.getState().activeProfileId, bucket: name, prefix: '' });
const openPrefix = (prefix) =>
  navigate({ profileId: store.getState().activeProfileId, bucket: store.getState().location.bucket, prefix });

// ---- Mutations -------------------------------------------------------------

const nameValidator = (v) => {
  if (!v) return t('flow.nameRequired');
  if (/[\\/]/.test(v)) return t('flow.noSlashes');
  if (v === '.' || v === '..') return t('flow.badName');
  return null;
};

async function createFolderFlow() {
  const { location } = store.getState();
  if (!location.bucket) {
    toast({ kind: 'error', message: t('flow.openBucketFirst') });
    return;
  }
  const name = await prompt({ title: t('flow.newFolderTitle'), label: t('flow.folderName'), okText: t('flow.create'), validate: nameValidator });
  if (name == null) return;
  try {
    await api.createFolder(location.bucket, location.prefix, name);
    toast({ kind: 'success', message: t('flow.folderCreated', { name }) });
    await loadListing();
  } catch (e) {
    toast({ kind: 'error', message: t('flow.createFolderFailed', { msg: e.message }) });
  }
}

async function renameFlow(item) {
  const { location } = store.getState();
  const newName = await prompt({
    title: item.isFolder ? t('flow.renameTitleFolder') : t('flow.renameTitleFile'),
    label: t('flow.newName'),
    value: item.name,
    okText: t('action.rename'),
    validate: nameValidator,
  });
  if (newName == null || newName === item.name) return;
  const destKey = item.isFolder ? `${location.prefix}${newName}/` : `${location.prefix}${newName}`;

  const attempt = async (overwrite) => {
    const prog = toast({ kind: 'progress', message: t('flow.renaming', { name: item.name }), timeout: 0 });
    try {
      const r = await api.rename(location.bucket, item.key, destKey, overwrite);
      prog.dismiss();
      if (r.errors && r.errors.length) toast({ kind: 'error', message: t('flow.renamedErrors', { n: r.errors.length }) });
      else toast({ kind: 'success', message: t('flow.renamedTo', { name: newName }) });
      store.setState({ selection: new Set() });
      await loadListing();
    } catch (e) {
      prog.dismiss();
      if (e.code === 'DEST_EXISTS' && !overwrite) {
        const ok = await confirm({ title: t('flow.replaceTitle'), message: t('flow.replaceExists', { name: newName }), okText: t('flow.replace'), danger: true });
        if (ok) await attempt(true);
        return;
      }
      toast({ kind: 'error', message: t('flow.renameFailed', { msg: e.message }) });
    }
  };
  await attempt(false);
}

async function moveFlow(item) {
  const { location } = store.getState();
  const dest = await prompt({
    title: t('flow.moveTitle', { name: item.name }),
    label: t('flow.moveDest'),
    value: location.prefix,
    okText: t('flow.moveBtn'),
    validate: (v) => {
      if (v && !v.endsWith('/')) return t('flow.prefixSlash');
      if (v.split('/').includes('..')) return t('flow.invalidPrefix');
      return null;
    },
  });
  if (dest == null) return;
  const attempt = async (overwrite) => {
    try {
      const r = await api.move(location.bucket, item.key, dest, overwrite);
      if (r.errors && r.errors.length) toast({ kind: 'error', message: t('flow.renamedErrors', { n: r.errors.length }) });
      else toast({ kind: 'success', message: t('flow.moved', { name: item.name }) });
      store.setState({ selection: new Set() });
      await loadListing();
    } catch (e) {
      if (e.code === 'DEST_EXISTS' && !overwrite) {
        const ok = await confirm({ title: t('flow.replaceTitle'), message: t('flow.moveReplaceExists', { name: item.name }), okText: t('flow.replace'), danger: true });
        if (ok) await attempt(true);
        return;
      }
      toast({ kind: 'error', message: t('flow.moveFailed', { msg: e.message }) });
    }
  };
  await attempt(false);
}

async function deleteFlow(keys) {
  const { location } = store.getState();
  if (!keys || !keys.length) return;
  const hasFolder = keys.some((k) => k.endsWith('/'));
  const message =
    keys.length === 1
      ? t('flow.deleteOne', { name: baseName(keys[0]), extra: hasFolder ? t('flow.deleteFolderExtra') : '' })
      : t('flow.deleteMany', { n: keys.length, extra: hasFolder ? t('flow.deleteFolderExtraMany') : '' });
  const ok = await confirm({ title: t('flow.deleteTitle'), message, okText: t('action.delete'), danger: true });
  if (!ok) return;
  const prog = toast({ kind: 'progress', message: t('flow.deleting', { n: keys.length }), timeout: 0 });
  try {
    const r = await api.deleteKeys(location.bucket, keys);
    prog.dismiss();
    if (r.errors && r.errors.length) toast({ kind: 'error', message: t('flow.deletedPartial', { ok: r.deleted.length, failed: r.errors.length }) });
    else toast({ kind: 'success', message: t('flow.deleted', { n: r.deleted.length }) });
    store.setState({ selection: new Set() });
    await loadListing();
  } catch (e) {
    prog.dismiss();
    toast({ kind: 'error', message: t('flow.deleteFailed', { msg: e.message }) });
  }
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---- Download manager ------------------------------------------------------
// When the File System Access API is available (real browsers + Electron), we
// stream the response straight to a user-chosen file with live byte progress and
// cancel. Otherwise we fall back to the classic <a download> (no in-app progress,
// but the browser/Electron handles it natively).
const RUNTIME = /electron/i.test(navigator.userAgent) ? 'electron' : 'browser';
const MAX_CONCURRENT_DL = 2;
// Concurrent files for folder-to-disk downloads (downloadToDirectory). Set to the
// browser's ~6-connections-per-origin HTTP/1.1 cap: more workers just queue in the
// browser with no benefit. Raising this only helps if the proxy moves to HTTP/2.
const DIR_DL_CONCURRENCY = 6;
let downloadSeq = 0;
const dlControllers = new Map(); // id -> AbortController

// Stream-to-disk needs the File System Access API. Disabled under automation
// (navigator.webdriver) where its native picker can't be driven — those fall
// back to the classic <a download> the test harness can observe.
const canStreamToDisk = () => typeof window.showSaveFilePicker === 'function' && !navigator.webdriver;
// Directory picker (write files straight into a chosen folder). Same automation gate.
const canPickDirectory = () => typeof window.showDirectoryPicker === 'function' && !navigator.webdriver;

// Find a non-colliding "name (n).ext" within a directory handle (for Keep both).
async function uniqueFileName(dirHandle, filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 1; ; n += 1) {
    const candidate = `${base} (${n})${ext}`;
    try {
      // eslint-disable-next-line no-await-in-loop
      await dirHandle.getFileHandle(candidate, { create: false });
    } catch {
      return candidate; // not found -> free to use
    }
  }
}

// Download a folder / selection as actual files into a user-chosen directory,
// recreating the subfolder structure and detecting per-file conflicts (the
// File System Access API: streams to disk, no zip). `keys` is folder prefixes
// and/or file keys; paths are kept relative to `stripBase` (the current prefix).
//
// Files download through a bounded worker pool (DIR_DL_CONCURRENCY) — the single
// biggest win for many-small-files folders, which are latency-bound (a round trip
// per file), not bandwidth-bound. A 105k-file folder goes from ~hours to minutes.
// `_resume` (set when resuming a persisted folder download after a reload) carries
// the already-permissioned directory handle + the existing row id; in resume mode
// files already fully on disk are skipped instead of re-downloaded.
async function downloadToDirectory({ keys, stripBase, label, _resume }) {
  const resumeMode = !!_resume;
  let dirHandle;
  if (resumeMode) {
    dirHandle = _resume.dirHandle;
  } else {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user dismissed the picker
      toast({ kind: 'error', message: e.message });
      return;
    }
  }
  const bucket = resumeMode ? _resume.bucket : store.getState().location.bucket;
  const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

  // Register the row + controller IMMEDIATELY in a "scanning" state. Enumerating a
  // big multi-folder selection (one server listing per folder) can take a while, and
  // showing nothing during it looked like a hang — now there's a live indeterminate
  // bar ("Scanning… N files"), a running count, and a working Cancel from the start.
  const id = resumeMode ? _resume.id : `d${(downloadSeq += 1)}`;
  const dest = dirHandle.name; // the local folder the user picked — shown as the destination
  const foldersTotal = keys.filter((k) => k.endsWith('/')).length;
  const scanningRow = { kind: 'tree', name: label, bucket, srcBase: stripBase, dest, status: 'downloading', scanning: true, scanned: 0, foldersScanned: 0, foldersTotal, received: 0, total: 0, filesDone: 0, filesTotal: 0, present: 0, skipped: 0, failed: 0, rate: 0, active: [], recent: [], error: null, needsPermission: false, runtime: RUNTIME };
  if (resumeMode) patchDownload(id, scanningRow);
  else store.setState((s) => ({ downloads: [...s.downloads, { id, ...scanningRow }] }));
  const ctrl = new AbortController();
  dlControllers.set(id, ctrl);
  // Persist so an interruption survives a reload (handle goes in IndexedDB).
  putTransfer({ id, kind: 'tree', bucket, dirHandle, keys, stripBase, label }).catch(() => {});

  // Build the flat file list by STREAMING the server listing (NDJSON): the count
  // grows live even within one huge folder, and aborting the fetch stops the server
  // walk mid-stream. Patches are throttled so a million-object scan doesn't thrash.
  const files = [];
  let total = 0;
  let listTruncated = false;
  let foldersScanned = 0;
  let lastScanPatch = 0;
  const scanPatch = (force) => {
    const now = Date.now();
    if (!force && now - lastScanPatch < 200) return;
    lastScanPatch = now;
    patchDownload(id, { scanned: files.length, foldersScanned, filesTotal: files.length, total });
  };
  try {
    for (const k of keys) {
      if (ctrl.signal.aborted) throw aborted();
      if (k.endsWith('/')) {
        // eslint-disable-next-line no-await-in-loop
        const { truncated } = await api.listTreeStream(bucket, k, ctrl.signal, (batch) => {
          for (const e of batch) {
            files.push({ key: e.key, size: e.size, rel: e.key.slice(stripBase.length) });
            total += e.size || 0;
          }
          scanPatch();
        });
        if (truncated) listTruncated = true;
        foldersScanned += 1;
        scanPatch(true);
      } else {
        const f = store.getState().listing.files.find((x) => x.key === k);
        const size = f ? f.size : 0;
        files.push({ key: k, size, rel: k.slice(stripBase.length) });
        total += size || 0;
        scanPatch(true);
      }
    }
  } catch (e) {
    dlControllers.delete(id);
    if (e.name === 'AbortError') {
      deleteTransfer(id).catch(() => {});
      patchDownload(id, { status: 'cancelled', scanning: false });
    } else {
      patchDownload(id, { status: 'error', error: e.message, scanning: false });
    }
    return;
  }

  // Truncation = silent data loss. The backend cap sits far above any real
  // folder, so this only fires at a genuinely huge ceiling — block before
  // writing a single file rather than report a false "saved everything".
  if (listTruncated) {
    const ok = await confirm({
      title: t('download.truncatedTitle'),
      message: t('download.truncated', { n: files.length }),
      okText: t('download.truncatedContinue'),
      danger: true,
    });
    if (!ok) {
      deleteTransfer(id).catch(() => {});
      patchDownload(id, { status: 'cancelled', scanning: false });
      dlControllers.delete(id);
      return;
    }
  }

  // Scan complete -> switch to the downloading phase.
  patchDownload(id, { scanning: false, filesTotal: files.length, total });

  // Shared accumulators. JS is single-threaded, so ++ between awaits is atomic —
  // no locks needed. One throttled aggregate patch replaces ~105k per-file patches.
  // `present` = files already fully on disk on a resume (size match) — counted and
  // badged distinctly from freshly-downloaded ('done') and user-skipped ('skip') so
  // the user can see exactly what was re-used vs newly fetched after a reload.
  const agg = { received: 0, done: 0, present: 0, skipped: 0, failed: 0 };
  // Live detail for the expandable panel: which files are in flight right now, and
  // a small ring buffer of the most recent completions. Both BOUNDED (active <= the
  // worker count, recent <= RECENT_CAP) so a 100k-file job never retains the list.
  const RECENT_CAP = 25;
  const active = new Set(); // rel-paths currently downloading
  const recent = []; // newest-first: { rel, outcome: 'done'|'skip'|'fail', size }
  const recordRecent = (rel, outcome, size) => {
    recent.unshift({ rel, outcome, size });
    if (recent.length > RECENT_CAP) recent.length = RECENT_CAP;
  };
  let sampleBytes = 0;
  let sampleTs = Date.now();
  let lastPatch = 0;
  const maybePatch = () => {
    const now = Date.now();
    if (now - lastPatch < 250) return; // check-and-set with no await between = atomic
    const inst = ((agg.received - sampleBytes) * 1000) / (now - sampleTs || 1);
    sampleBytes = agg.received;
    sampleTs = now;
    lastPatch = now;
    const cur = store.getState().downloads.find((d) => d.id === id);
    patchDownload(id, { received: agg.received, filesDone: agg.done, present: agg.present, skipped: agg.skipped, failed: agg.failed, rate: cur && cur.rate ? cur.rate * 0.7 + inst * 0.3 : inst, active: [...active], recent: recent.slice() });
  };

  // Directory-handle cache. SYNCHRONOUS-set form: there is NO await between the
  // get() and the set(), so two workers needing the same not-yet-created subdir
  // share ONE in-flight getDirectoryHandle({create:true}) — race-free, and each
  // ancestor is created once instead of re-resolved per file. getDir MUST stay
  // non-async (an `await getDir(parent)` before the set would re-open the race).
  const dirCache = new Map();
  dirCache.set('', Promise.resolve(dirHandle));
  const getDir = (relDir) => {
    const hit = dirCache.get(relDir);
    if (hit) return hit;
    const slash = relDir.lastIndexOf('/');
    const parent = slash < 0 ? '' : relDir.slice(0, slash);
    const seg = slash < 0 ? relDir : relDir.slice(slash + 1);
    const p = getDir(parent).then((ph) => ph.getDirectoryHandle(seg, { create: true }));
    dirCache.set(relDir, p);
    // A rejected creation self-evicts (regardless of where in the chain it failed)
    // so a later worker can rebuild rather than awaiting a permanently-failed promise.
    p.catch(() => {
      if (dirCache.get(relDir) === p) dirCache.delete(relDir);
    });
    return p;
  };

  // Conflict resolution serialized behind one promise chain: at most one modal
  // mounted at a time; once the user picks "apply to all" every later conflict
  // short-circuits with no prompt. Each worker awaits ITS OWN link's returned
  // action — no shared mutable to clobber across the 6-worker fan-out.
  let applyAll = null; // 'overwrite' | 'skip' | 'keepboth'
  let conflictChain = Promise.resolve();
  const resolveConflict = (rel) => {
    if (applyAll) return Promise.resolve(applyAll);
    const link = conflictChain.then(async () => {
      if (applyAll) return applyAll;
      if (ctrl.signal.aborted) throw aborted();
      const res = await openConflict({ name: rel, signal: ctrl.signal }); // rejects AbortError on cancel
      if (res.all) applyAll = res.action;
      return res.action;
    });
    conflictChain = link.catch(() => {}); // an aborted link must not poison the chain
    return link;
  };

  // A backoff that wakes early (and rejects) on cancel, so a retry never re-enters
  // a doomed fetch after the user has cancelled.
  const sleep = (ms) =>
    new Promise((res, rej) => {
      const to = setTimeout(res, ms);
      ctrl.signal.addEventListener('abort', () => { clearTimeout(to); rej(aborted()); }, { once: true });
    });

  async function downloadOne(f) {
    active.add(f.rel); // shown live in "Downloading now"
    // finally guarantees the rel-path leaves `active` on EVERY exit — including a
    // thrown abort — so a cancelled job never shows phantom in-flight files.
    try {
      const slash = f.rel.lastIndexOf('/');
      const relDir = slash < 0 ? '' : f.rel.slice(0, slash);
      const name = slash < 0 ? f.rel : f.rel.slice(slash + 1);
      const dir = await getDir(relDir);

      // Conflict detection against the local folder.
      let exists = false;
      let existingSize = -1;
      try {
        const efh = await dir.getFileHandle(name, { create: false });
        exists = true;
        if (resumeMode) existingSize = (await efh.getFile()).size;
      } catch {
        exists = false;
      }
      // Resuming after a reload: a file already fully on disk is DONE — skip it
      // silently (no prompt) instead of re-downloading. A short/partial one is
      // re-downloaded (overwritten) from the start.
      if (resumeMode && exists && existingSize === f.size) {
        agg.present += 1;
        agg.done += 1; // keep files-complete progress reaching 100%…
        recordRecent(f.rel, 'present', f.size); // …but badge/count it as already-present
        return;
      }
      let target = name;
      if (exists && !resumeMode) {
        const action = await resolveConflict(f.rel);
        // Re-check abort BEFORE any create:true: a cancel during the prompt must
        // never fall through to "overwrite" and truncate the user's existing file.
        if (ctrl.signal.aborted) throw aborted();
        if (action === 'skip') {
          agg.skipped += 1;
          agg.done += 1;
          recordRecent(f.rel, 'skip', f.size);
          return;
        }
        if (action === 'keepboth') target = await uniqueFileName(dir, name);
        // 'overwrite' -> keep target = name (create:true truncates)
      }

      // Stream to disk with up to 2 transient retries. A single bad file is counted
      // as failed and the job CONTINUES — one blip must not lose hours of progress.
      for (let attempt = 0; ; attempt += 1) {
        if (ctrl.signal.aborted) throw aborted();
        const attemptStart = agg.received; // roll back on retry so bytes count once
        let writable;
        try {
          const fh = await dir.getFileHandle(target, { create: true });
          writable = await fh.createWritable();
          const res = await api.fetchDownload(bucket, f.key, ctrl.signal);
          if (!res.ok) {
            await writable.abort().catch(() => {});
            const transient = res.status >= 500 || res.status === 429;
            if (transient && attempt < 2) {
              agg.received = attemptStart;
              await sleep(300 * (attempt + 1)); // 300ms, 600ms
              continue;
            }
            agg.failed += 1;
            agg.done += 1;
            recordRecent(f.rel, 'fail', f.size);
            return;
          }
          const reader = res.body.getReader();
          for (;;) {
            // eslint-disable-next-line no-await-in-loop
            const { done: rdone, value } = await reader.read();
            if (rdone) break;
            // eslint-disable-next-line no-await-in-loop
            await writable.write(value);
            agg.received += value.length;
            maybePatch();
          }
          await writable.close();
          agg.done += 1;
          recordRecent(f.rel, 'done', f.size);
          return;
        } catch (e) {
          if (writable) await writable.abort().catch(() => {}); // discard the partial file
          // Cancel ALWAYS escalates to job-abort — checked before any retry/classify,
          // so a teardown surfacing as a generic rejection can't be mis-counted as failed.
          if (e.name === 'AbortError' || ctrl.signal.aborted) throw aborted();
          if (attempt < 2) {
            agg.received = attemptStart;
            await sleep(300 * (attempt + 1));
            continue;
          }
          agg.failed += 1;
          agg.done += 1;
          recordRecent(f.rel, 'fail', f.size);
          return;
        }
      }
    } finally {
      active.delete(f.rel);
    }
  }

  // Bounded worker pool. Chromium caps ~6 sockets/origin over HTTP/1.1, so >6
  // in-flight fetches just queue in the browser; DIR_DL_CONCURRENCY matches that
  // ceiling. cursor++ is atomic (single-threaded), so each file dispatches once.
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (ctrl.signal.aborted) throw aborted();
      const i = cursor;
      cursor += 1;
      if (i >= files.length) return;
      // eslint-disable-next-line no-await-in-loop
      await downloadOne(files[i]);
      maybePatch();
    }
  }

  try {
    const n = Math.min(DIR_DL_CONCURRENCY, files.length) || 1;
    await Promise.all(Array.from({ length: n }, () => worker()));
    deleteTransfer(id).catch(() => {}); // completed -> drop the resume entry
    // active is provably empty here (every worker returned), but send [] for clarity.
    patchDownload(id, { status: 'done', received: agg.received, rate: 0, filesDone: agg.done, present: agg.present, skipped: agg.skipped, failed: agg.failed, active: [], recent: recent.slice() });
    toast({ kind: 'success', message: t('tr.savedToFolder', { n: agg.done - agg.present - agg.skipped - agg.failed, skipped: agg.skipped + agg.present }) });
    if (agg.failed > 0) toast({ kind: 'error', message: t('tr.nFailed', { n: agg.failed }) });
  } catch (e) {
    // On cancel, up to 5 sibling workers are still mid-flight, so the live Set is
    // NOT empty — force active:[] so the terminal row shows no phantom "downloading".
    if (e.name === 'AbortError') {
      deleteTransfer(id).catch(() => {}); // user cancelled -> don't keep for resume
      patchDownload(id, { status: 'cancelled', received: agg.received, filesDone: agg.done, present: agg.present, skipped: agg.skipped, failed: agg.failed, rate: 0, active: [], recent: recent.slice() });
    } else {
      patchDownload(id, { status: 'error', error: e.message, active: [], recent: recent.slice() });
    }
  } finally {
    dlControllers.delete(id);
  }
}

function patchDownload(id, patch) {
  store.setState((s) => ({ downloads: s.downloads.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
}

function fallbackDownload(spec) {
  const b = spec.bucket;
  if (spec.kind === 'file') {
    triggerDownload(api.downloadUrl(b, spec.key), spec.name);
  } else if (spec.kind === 'folder-zip') {
    triggerDownload(api.downloadFolderUrl(b, spec.prefix), spec.name);
    toast({ kind: 'info', message: t('flow.preparingZip', { name: spec.name }) });
  } else {
    // batch-zip can't be a single <a> (POST body); fall back to staggered items.
    let i = 0;
    for (const k of spec.keys) {
      const fn = k.endsWith('/')
        ? () => triggerDownload(api.downloadFolderUrl(b, k), `${baseName(k)}.zip`)
        : () => triggerDownload(api.downloadUrl(b, k), baseName(k));
      setTimeout(fn, (i += 1) * 350);
    }
    toast({ kind: 'info', message: t('flow.downloadingItems', { n: spec.keys.length }) });
  }
}

// Must be invoked from a user gesture (the file picker requires one). spec:
// { kind:'file'|'folder-zip'|'batch-zip', name, bucket, key?|prefix?|keys? }.
async function startManagedDownload(spec) {
  if (!canStreamToDisk()) {
    fallbackDownload(spec);
    return;
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({ suggestedName: spec.name });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user dismissed the picker
    fallbackDownload(spec); // FSA unexpectedly unavailable
    return;
  }
  const id = `d${(downloadSeq += 1)}`;
  store.setState((s) => ({
    downloads: [
      ...s.downloads,
      { id, kind: spec.kind, name: spec.name, bucket: spec.bucket, key: spec.key, prefix: spec.prefix, keys: spec.keys, handle, received: 0, total: null, rate: 0, status: 'queued', error: null, runtime: RUNTIME },
    ],
  }));
  // Persist single-file downloads so an interrupted one survives a reload and can
  // be resumed (the FileSystemFileHandle is stored — only possible via IndexedDB).
  if (spec.kind === 'file') {
    putTransfer({ id, kind: 'file', bucket: spec.bucket, key: spec.key, name: spec.name, handle, committedLength: 0, guardEtag: null, total: null }).catch(() => {});
  }
  pumpDownloadQueue();
}

function pumpDownloadQueue() {
  let slots = MAX_CONCURRENT_DL - store.getState().downloads.filter((d) => d.status === 'downloading').length;
  for (const t of store.getState().downloads) {
    if (slots <= 0) break;
    if (t.status === 'queued') {
      startDownload(t);
      slots -= 1;
    }
  }
}

// Backoff that wakes early (and rejects) on cancel.
const dlBackoff = (ms, signal) =>
  new Promise((res, rej) => {
    const to = setTimeout(res, ms);
    signal.addEventListener('abort', () => { clearTimeout(to); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
  });
const MAX_DL_ATTEMPTS = 6;
// Durable-checkpoint cadence for single-file resumable downloads. createWritable()
// only makes bytes durable on close(), and reopening with keepExistingData copies
// the existing file (O(filesize)) — so we checkpoint on GEOMETRIC byte thresholds
// (4 MiB, 8, 16, 32, …): the total copy cost stays ~2× the file (amortized O(N))
// REGARDLESS of the first threshold — a smaller first checkpoint only adds a few
// extra cheap early copies. So we keep it SMALL: a reload a few seconds in should
// resume from real progress, not 0 (64 MiB took ~85 s on a 1.3 GB / 756 KB/s job —
// any normal-timing reload landed before the first checkpoint and lost everything).
const CHECKPOINT_MIN = 4 * 1024 * 1024; // first durable checkpoint after ~4 MiB
const CHECKPOINT_MS = 2000; // …but no more often than this (avoids thrash on fast links)

// Stream a response body to the task's writable with throttled progress. When an
// onCheckpoint callback is supplied (single-file downloads), it's invoked after each
// progress tick to optionally commit-and-reopen the writable; it RETURNS the writable
// to keep writing to (the same one if it didn't checkpoint), which we adopt locally.
async function pumpToWritable(task, writable, reader, startBytes, onCheckpoint) {
  let received = startBytes;
  let sampleBytes = startBytes;
  let sampleTs = Date.now();
  let lastPatch = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    // eslint-disable-next-line no-await-in-loop
    await writable.write(value);
    received += value.length;
    const now = Date.now();
    if (now - sampleTs >= 250) {
      const inst = ((received - sampleBytes) * 1000) / (now - sampleTs);
      sampleBytes = received;
      sampleTs = now;
      const cur = store.getState().downloads.find((d) => d.id === task.id);
      patchDownload(task.id, { received, rate: cur && cur.rate ? cur.rate * 0.7 + inst * 0.3 : inst });
      lastPatch = now;
    } else if (now - lastPatch >= 250) {
      patchDownload(task.id, { received });
      lastPatch = now;
    }
    // eslint-disable-next-line no-await-in-loop
    if (onCheckpoint) writable = await onCheckpoint(writable, received);
  }
  return received;
}

async function errMessage(res) {
  let msg = `Download failed (${res.status})`;
  try {
    const j = await res.json();
    msg = j?.error?.message || msg;
  } catch {
    /* non-JSON */
  }
  return msg;
}

// Zip/stream downloads (folder-zip, batch-zip): server-generated stream with no
// stable byte offset, so they can't byte-resume — single attempt, discard on fail.
async function runZipDownload(task, ctrl) {
  let writable;
  try {
    const res = task.kind === 'folder-zip'
      ? await api.fetchFolderZip(task.bucket, task.prefix, ctrl.signal)
      : await api.fetchZipSelection(task.bucket, task.keys, ctrl.signal, task.name.replace(/\.zip$/i, ''));
    if (!res.ok) throw Object.assign(new Error(await errMessage(res)), { status: res.status });
    const len = res.headers.get('content-length');
    const total = len ? Number(len) : null;
    patchDownload(task.id, { total });
    writable = await task.handle.createWritable();
    const received = await pumpToWritable(task, writable, res.body.getReader(), 0);
    await writable.close();
    patchDownload(task.id, { status: 'done', received, total: total ?? received, rate: 0 });
  } catch (e) {
    if (writable) await writable.abort().catch(() => {});
    patchDownload(task.id, { status: e.name === 'AbortError' ? 'cancelled' : 'error', error: e.name === 'AbortError' ? null : e.message });
  }
}

// Single-file download with auto-retry + byte RESUME. On a transient failure the
// partial is COMMITTED (writable.close()) — abort() would discard it — then the
// next attempt reopens with keepExistingData + seek and a Range request guarded by
// If-Match, so a changed object restarts cleanly instead of splicing a stale prefix.
async function runResumableDownload(task, ctrl) {
  // Seed from persisted state (a resumed-after-reload task carries these).
  let committed = task.committedLength || 0; // bytes on disk (committed by a prior close)
  let etag = task.guardEtag || null; // resume guard (object ETag)
  let objectSize = task.total || null;
  // Trust the bytes ACTUALLY on disk, not just the persisted number (a checkpoint
  // that never committed is discarded by the FS), so we never Range past the file.
  if (committed > 0) {
    try {
      const f = await task.handle.getFile();
      committed = Math.min(committed, f.size);
    } catch {
      committed = 0;
    }
  }
  const persist = () => putTransfer({ id: task.id, kind: 'file', bucket: task.bucket, key: task.key, name: task.name, handle: task.handle, committedLength: committed, guardEtag: etag, total: objectSize }).catch(() => {});

  for (let attempt = 0; ; attempt += 1) {
    if (ctrl.signal.aborted) {
      patchDownload(task.id, { status: 'cancelled' });
      return;
    }
    let writable;
    try {
      const resuming = committed > 0 && !!etag;
      const res = await api.fetchDownload(task.bucket, task.key, ctrl.signal, resuming ? { rangeStart: committed, ifMatch: etag } : {});

      if (!res.ok) {
        // 412/416 = object changed or bad range -> drop the partial and restart from 0.
        if (res.status === 412 || res.status === 416) {
          committed = 0;
          etag = null;
          objectSize = null;
          if (attempt < MAX_DL_ATTEMPTS) continue;
          throw Object.assign(new Error('Object changed during download'), { status: res.status });
        }
        const transient = res.status >= 500 || res.status === 429;
        if (transient && attempt < MAX_DL_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await dlBackoff(400 * 2 ** attempt, ctrl.signal);
          continue;
        }
        throw Object.assign(new Error(await errMessage(res)), { status: res.status });
      }

      const respEtag = res.headers.get('etag');
      if (!etag && respEtag) etag = respEtag;
      if (resuming) {
        // Expect a 206 whose range starts exactly where we left off; anything else
        // (200 = range ignored, or a start/total mismatch) means restart from 0.
        const m = (res.headers.get('content-range') || '').match(/bytes (\d+)-\d+\/(\d+)/);
        if (res.status !== 206 || !m || Number(m[1]) !== committed || (objectSize != null && Number(m[2]) !== objectSize)) {
          committed = 0;
        } else {
          objectSize = Number(m[2]);
        }
      } else {
        const len = res.headers.get('content-length');
        objectSize = len ? Number(len) : null;
      }

      patchDownload(task.id, { total: objectSize, received: committed });
      // Persist the resume guard NOW (etag + total, committed so far) so even a
      // reload before the first byte-checkpoint has a valid Range+If-Match to retry
      // with — previously the only durable record was the all-zero enqueue row.
      persist();
      writable = committed > 0 ? await task.handle.createWritable({ keepExistingData: true }) : await task.handle.createWritable();
      if (committed > 0) await writable.seek(committed);
      // Periodic durable checkpoint: commit the swap file, record the new offset in
      // IndexedDB, then reopen (keepExistingData + seek) so a reload resumes here.
      // Geometric thresholds bound the total copy cost; the time gate avoids churn
      // when 64 MiB streams in under a few seconds. Mutates the outer `writable` so
      // the catch/finally below always closes the live one.
      let nextCp = committed + CHECKPOINT_MIN;
      let lastCpTs = Date.now();
      const onCheckpoint = async (w, received) => {
        if (received < nextCp || Date.now() - lastCpTs < CHECKPOINT_MS) return w;
        await w.close(); // commit bytes streamed so far to the real file
        const f = await task.handle.getFile();
        committed = f.size; // trust the bytes actually on disk as the resume point
        persist();
        nextCp = committed + Math.max(CHECKPOINT_MIN, committed); // geometric: 4,8,16,32,… MiB
        lastCpTs = Date.now();
        const nw = await task.handle.createWritable({ keepExistingData: true });
        await nw.seek(committed);
        writable = nw;
        return nw;
      };
      const received = await pumpToWritable(task, writable, res.body.getReader(), committed, onCheckpoint);
      await writable.close(); // commit
      deleteTransfer(task.id).catch(() => {}); // completed -> drop the resume entry
      patchDownload(task.id, { status: 'done', received, total: objectSize ?? received, rate: 0 });
      return;
    } catch (e) {
      if (e.name === 'AbortError' || ctrl.signal.aborted) {
        if (writable) await writable.abort().catch(() => {}); // discard this attempt's temp
        deleteTransfer(task.id).catch(() => {}); // user cancelled -> don't keep it for resume
        patchDownload(task.id, { status: 'cancelled' });
        return;
      }
      // Mid-stream/network failure: COMMIT what we streamed so the retry resumes
      // from there (abort would discard it). On close failure, fall back to the
      // last committed offset.
      if (writable) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await writable.close();
          // Trust the bytes actually on disk as the new resume point.
          // eslint-disable-next-line no-await-in-loop
          const f = await task.handle.getFile();
          committed = f.size;
        } catch {
          await writable.abort().catch(() => {});
        }
      }
      persist(); // checkpoint the committed offset + guard so a reload can resume here
      if (attempt < MAX_DL_ATTEMPTS) {
        patchDownload(task.id, { received: committed });
        // eslint-disable-next-line no-await-in-loop
        try {
          await dlBackoff(400 * 2 ** attempt, ctrl.signal);
        } catch {
          patchDownload(task.id, { status: 'cancelled' });
          return;
        }
        continue;
      }
      patchDownload(task.id, { status: 'error', error: e.message });
      return;
    }
  }
}

async function startDownload(task) {
  patchDownload(task.id, { status: 'downloading', received: 0, rate: 0, error: null });
  const ctrl = new AbortController();
  dlControllers.set(task.id, ctrl);
  try {
    if (task.kind === 'file') await runResumableDownload(task, ctrl);
    else await runZipDownload(task, ctrl);
  } finally {
    dlControllers.delete(task.id);
    pumpDownloadQueue();
  }
}

function cancelDownload(id) {
  const ctrl = dlControllers.get(id);
  if (ctrl) ctrl.abort();
  else patchDownload(id, { status: 'cancelled' });
}

function retryDownload(id) {
  const t = store.getState().downloads.find((d) => d.id === id);
  if (!t || (t.status !== 'error' && t.status !== 'cancelled')) return;
  patchDownload(id, { status: 'queued', received: 0, rate: 0, error: null });
  pumpDownloadQueue();
}

function cancelAllDownloads() {
  for (const d of [...store.getState().downloads]) {
    if (d.status === 'queued' || d.status === 'downloading') cancelDownload(d.id);
  }
}

// Prune any expanded-detail ids that no longer match a live download row, so the
// expandedDownloads set can never outgrow the rows it points at.
function pruneExpanded(ui, keptIds) {
  const cur = ui.expandedDownloads || [];
  return { ...ui, expandedDownloads: cur.filter((x) => keptIds.has(x)) };
}

function clearFinishedDownloads() {
  store.setState((s) => {
    const kept = s.downloads.filter((d) => d.status !== 'done');
    return { downloads: kept, ui: pruneExpanded(s.ui, new Set(kept.map((d) => d.id))) };
  });
}

function dismissDownload(id) {
  deleteTransfer(id).catch(() => {}); // drop any persisted resume entry too
  store.setState((s) => {
    const kept = s.downloads.filter((d) => d.id !== id);
    return { downloads: kept, ui: pruneExpanded(s.ui, new Set(kept.map((d) => d.id))) };
  });
}

// At boot, restore interrupted single-file downloads from IndexedDB as PAUSED rows
// the user can resume. They can't auto-resume: requestPermission({readwrite}) needs
// a user gesture, so resuming is gated behind the "Resume" button. Entries whose
// handle no longer resolves are pruned.
async function hydrateTransfers() {
  let saved = [];
  try {
    saved = await allTransfers();
  } catch {
    return;
  }
  const rows = [];
  const uploadRows = [];
  for (const r of saved) {
    // Interrupted multipart UPLOAD: no handle (the File must be re-picked); the
    // in-progress upload lives in S3, so verify it still exists via ListParts and
    // restore an "interrupted" row whose Resume re-selects the file.
    if (r && r.kind === 'upload') {
      // Don't verify via ListParts here: hydration runs at boot BEFORE a profile is
      // active, so the call would fail. Restore the row optimistically; the actual
      // reconcile (and re-upload-from-scratch if the S3 upload is gone) happens on
      // Resume, when multipartUpload calls ListParts with the active profile.
      if (!r.uploadId || !r.bucket || !r.uploadName) {
        deleteTransfer(r.id).catch(() => {});
        // eslint-disable-next-line no-continue
        continue;
      }
      const tid = String(r.id).replace(/^mpu-/, '');
      // If a FileSystemFileHandle was captured at pick/drop time it's structured-cloned
      // in the pointer; queryPermission (no gesture needed) tells us whether Resume can
      // re-read it silently or must request permission. No handle -> re-pick fallback.
      let granted = false;
      if (r.handle && r.handle.queryPermission) {
        try {
          // eslint-disable-next-line no-await-in-loop
          granted = (await r.handle.queryPermission({ mode: 'read' })) === 'granted';
        } catch { granted = false; }
      }
      uploadRows.push({
        id: tid, name: r.name, uploadName: r.uploadName, file: null, sent: r.sentBytes || 0, total: r.fileSize || 0,
        rate: 0, attempts: 0, status: 'interrupted', error: null, bucket: r.bucket, prefix: r.prefix,
        resumeUploadId: r.uploadId, fileSize: r.fileSize, lastModified: r.lastModified,
        handle: r.handle || null, needsPermission: !!r.handle && !granted,
      });
      // eslint-disable-next-line no-continue
      continue;
    }
    // 'file' downloads keep a file handle; 'tree' (folder) downloads keep the
    // picked directory handle + the scope to re-scan and skip already-saved files.
    const handle = r && (r.kind === 'file' ? r.handle : r.dirHandle);
    if (!r || (r.kind !== 'file' && r.kind !== 'tree') || !handle) {
      deleteTransfer(r && r.id).catch(() => {});
      // eslint-disable-next-line no-continue
      continue;
    }
    let granted = false;
    try {
      // queryPermission needs no gesture; if already granted (rare) we can show a
      // one-click resume; otherwise the Resume button will request it.
      // eslint-disable-next-line no-await-in-loop
      granted = (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch {
      // Handle no longer valid -> prune and skip.
      deleteTransfer(r.id).catch(() => {});
      // eslint-disable-next-line no-continue
      continue;
    }
    if (r.kind === 'file') {
      rows.push({
        id: r.id, kind: 'file', name: r.name, bucket: r.bucket, key: r.key, handle: r.handle,
        committedLength: r.committedLength || 0, guardEtag: r.guardEtag || null,
        received: r.committedLength || 0, total: r.total || null, rate: 0,
        status: 'paused', needsPermission: !granted, error: null, runtime: RUNTIME,
      });
    } else {
      rows.push({
        id: r.id, kind: 'tree', name: r.label, bucket: r.bucket, srcBase: r.stripBase, dest: r.dirHandle.name,
        // carried so Resume can re-run the folder download against the same handle/scope
        _dirHandle: r.dirHandle, _keys: r.keys, _stripBase: r.stripBase, _label: r.label,
        received: 0, total: 0, filesDone: 0, filesTotal: 0, present: 0, skipped: 0, failed: 0, rate: 0,
        active: [], recent: [], status: 'paused', needsPermission: !granted, error: null, runtime: RUNTIME,
      });
    }
  }
  // Bump the seqs so new transfers this session can't collide with restored ids.
  for (const row of rows) {
    const n = Number(String(row.id).replace(/^d/, ''));
    if (Number.isFinite(n) && n >= downloadSeq) downloadSeq = n + 1;
  }
  for (const u of uploadRows) {
    const n = Number(String(u.id).replace(/^u/, ''));
    if (Number.isFinite(n) && n >= uploadSeq) uploadSeq = n + 1;
  }
  if (rows.length || uploadRows.length) {
    store.setState((s) => ({ downloads: [...rows, ...s.downloads], uploads: [...uploadRows, ...s.uploads] }));
  }
}

// Resume a paused (restored-after-reload) download: re-acquire write permission
// (this click is the required user gesture), then run the normal resume path which
// continues from the committed byte offset guarded by the object ETag.
async function resumePersistedDownload(id) {
  const task = store.getState().downloads.find((d) => d.id === id);
  if (!task || task.status !== 'paused') return;
  const handle = task.kind === 'tree' ? task._dirHandle : task.handle;
  try {
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      patchDownload(id, { needsPermission: true });
      toast({ kind: 'error', message: t('tr.permissionDenied') });
      return;
    }
  } catch (e) {
    toast({ kind: 'error', message: e.message });
    return;
  }
  if (task.kind === 'tree') {
    // Re-run the folder download against the same directory, skipping files already
    // fully on disk (resume mode), reusing the existing row id.
    downloadToDirectory({ keys: task._keys, stripBase: task._stripBase, label: task._label, _resume: { id, dirHandle: handle, bucket: task.bucket } });
    return;
  }
  patchDownload(id, { status: 'queued', needsPermission: false, error: null });
  pumpDownloadQueue();
}

const downloadsPending = () => store.getState().downloads.some((d) => d.status === 'queued' || d.status === 'downloading');

function downloadKey(key) {
  const bucket = store.getState().location.bucket;
  startManagedDownload({ kind: 'file', name: baseName(key), bucket, key });
}

// Download a whole folder. Preferred: write the actual files into a folder you
// pick (recreating structure, with per-file overwrite/skip detection). Falls
// back to a structure-preserving .zip where the directory picker isn't available.
function downloadFolder(prefix) {
  const { bucket, prefix: cur } = store.getState().location;
  if (canPickDirectory()) {
    downloadToDirectory({ keys: [prefix], stripBase: cur, label: baseName(prefix) });
  } else {
    startManagedDownload({ kind: 'folder-zip', name: `${baseName(prefix)}.zip`, bucket, prefix });
  }
}

// Download the current multi-selection. With a single file -> direct file save.
// Otherwise: write all selected files/folders into a chosen folder (structure +
// conflict detection), or fall back to ONE .zip when that's unavailable.
function bulkDownload() {
  const { selection, location } = store.getState();
  const keys = [...selection];
  if (!keys.length) {
    toast({ kind: 'info', message: t('flow.downloadSelectHint') });
    return;
  }
  if (keys.length === 1 && !keys[0].endsWith('/')) {
    downloadKey(keys[0]);
    return;
  }
  if (canPickDirectory()) {
    downloadToDirectory({ keys, stripBase: location.prefix, label: t('tr.savingToFolder') });
    return;
  }
  if (keys.length === 1) {
    downloadFolder(keys[0]);
    return;
  }
  startManagedDownload({ kind: 'batch-zip', name: 'download.zip', bucket: location.bucket, keys });
}

// Open the share dialog (presigned link with a chosen expiry: 1h / 1d / 7d).
function shareLink(key) {
  const { location } = store.getState();
  openShare({ bucket: location.bucket, key, name: baseName(key) });
}

// Open the read-only Info / Properties panel (file HEAD or folder size rollup).
function showInfo(item) {
  const { location } = store.getState();
  openInfo({ bucket: location.bucket, key: item.key, name: item.name, isFolder: item.isFolder });
}

// ---- Profile CRUD ----------------------------------------------------------

async function saveProfile({ mode, id, data }) {
  if (mode === 'edit') {
    await api.updateProfile(id, data);
    toast({ kind: 'success', message: t('profile.updated') });
  } else {
    const { profile } = await api.addProfile(data);
    toast({ kind: 'success', message: t('profile.added', { name: profile.name }) });
    await loadProfiles();
    selectProfile(profile.id);
    return profile;
  }
  await loadProfiles();
  // If creds for the active profile changed, reload buckets/listing.
  if (id === store.getState().activeProfileId) {
    await loadBuckets();
    await loadListing();
  }
  return null;
}

async function deleteProfileFlow(id) {
  const prof = store.getState().profiles.find((p) => p.id === id);
  const ok = await confirm({
    title: t('profile.removeTitle'),
    message: t('profile.removeMsg', { name: prof?.name || id }),
    okText: t('profile.remove'),
    danger: true,
  });
  if (!ok) return false;
  try {
    await api.deleteProfile(id);
    toast({ kind: 'success', message: t('profile.removed') });
    const wasActive = store.getState().activeProfileId === id;
    await loadProfiles();
    if (wasActive) {
      const next = store.getState().profiles[0];
      if (next) selectProfile(next.id);
      else navigate({});
    }
    return true;
  } catch (e) {
    toast({ kind: 'error', message: t('profile.removeFailed', { msg: e.message }) });
    return false;
  }
}

// ---- Uploads ---------------------------------------------------------------

let uploadSeq = 0;
const MAX_CONCURRENT = 3;
const MAX_UPLOAD_ATTEMPTS = 3;
const activeXhrs = new Map();
const lastSample = new Map(); // id -> { sent, ts } for rate calc
const lastPatchTs = new Map(); // id -> ts, to throttle store writes (~4/sec)
let settleTimer = null;
let settleArmed = false;
const reportedUploadIds = new Set(); // tasks already counted in a settle toast

function patchUpload(id, patch) {
  store.setState((s) => ({ uploads: s.uploads.map((u) => (u.id === id ? { ...u, ...patch } : u)) }));
}

function forgetUpload(id) {
  lastSample.delete(id);
  lastPatchTs.delete(id);
  activeXhrs.delete(id);
}

// Throttled progress -> bytes sent + smoothed transfer rate.
function onUploadProgress(task, sent) {
  const now = Date.now();
  const prev = lastSample.get(task.id);
  let rate;
  if (prev && now > prev.ts) {
    const inst = ((sent - prev.sent) * 1000) / (now - prev.ts);
    const cur = store.getState().uploads.find((u) => u.id === task.id);
    rate = cur && cur.rate ? cur.rate * 0.7 + inst * 0.3 : inst;
  }
  if (!prev || now - prev.ts >= 250) lastSample.set(task.id, { sent, ts: now });
  const lp = lastPatchTs.get(task.id) || 0;
  if (now - lp >= 250 || sent >= task.total) {
    lastPatchTs.set(task.id, now);
    patchUpload(task.id, rate != null ? { sent: Math.min(sent, task.total), rate } : { sent: Math.min(sent, task.total) });
  }
}

// Accepts a FileList/File[] or an array of { file, relPath }. The subdirectory
// (relPath, ending in '/') under the current prefix comes from either the
// drag-drop walker OR, for the "Upload folder" picker, the File's
// webkitRelativePath — so a chosen folder tree keeps its structure. Async: it
// HEAD-checks for name collisions.
async function enqueueUploads(items) {
  const { location } = store.getState();
  if (!location.bucket) {
    toast({ kind: 'error', message: t('tr.openBucketUpload') });
    return;
  }
  const list = [...items]
    .map((it) => {
      if (it instanceof File) {
        const rp = it.webkitRelativePath || '';
        const slash = rp.lastIndexOf('/');
        return { file: it, relPath: slash > 0 ? rp.slice(0, slash + 1) : '' };
      }
      return it;
    })
    .filter((it) => it && it.file);
  if (!list.length) return;
  const tasks = list.map(({ file, relPath = '', handle = null }) => ({
    id: `u${(uploadSeq += 1)}`,
    name: `${relPath}${file.name}`,
    uploadName: file.name,
    file,
    // Captured at pick/drop time when available (showOpenFilePicker / a dropped file's
    // getAsFileSystemHandle); persisted with the multipart pointer so a reload-interrupted
    // upload can resume by re-reading the handle instead of forcing a disk re-pick.
    handle,
    sent: 0,
    total: file.size,
    rate: 0,
    attempts: 0,
    status: 'checking',
    error: null,
    bucket: location.bucket,
    prefix: `${location.prefix}${relPath}`,
  }));
  store.setState((s) => ({ uploads: [...s.uploads, ...tasks] }));
  await detectConflicts(tasks);
  pumpQueue();
}

// Upload-button entry that captures a FileSystemFileHandle per file (so a reload-
// interrupted upload can resume without a disk re-pick). The Toolbar only calls this
// when window.showOpenFilePicker exists and we're not under webdriver; otherwise it
// uses the hidden <input> directly (keeping the e2e suite on the <input> path).
async function pickFilesAndUpload() {
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user dismissed the picker
    toast({ kind: 'error', message: e.message });
    return;
  }
  const items = [];
  for (const handle of handles) {
    // eslint-disable-next-line no-await-in-loop
    items.push({ file: await handle.getFile(), handle, relPath: '' });
  }
  if (items.length) enqueueUploads(items);
}

// Mark tasks whose target key already exists as 'conflict' (held until the user
// chooses); others -> 'queued'. Small batches use HEAD (accurate); large folder
// drops fall back to the current listing to avoid N round-trips stalling start.
async function detectConflicts(tasks) {
  const setStatus = (t, status, extra = {}) => {
    const cur = store.getState().uploads.find((u) => u.id === t.id);
    if (cur && cur.status === 'checking') patchUpload(t.id, { status, ...extra });
  };
  if (tasks.length > 30) {
    const existing = new Set(store.getState().listing.files.map((f) => f.key));
    for (const t of tasks) setStatus(t, existing.has(`${t.prefix}${t.uploadName}`) ? 'conflict' : 'queued');
    return;
  }
  let i = 0;
  const worker = async () => {
    while (i < tasks.length) {
      const t = tasks[i++];
      let conflict = false;
      try {
        await api.headObject(t.bucket, `${t.prefix}${t.uploadName}`);
        conflict = true;
      } catch (e) {
        conflict = false; // 404 (and any uncertainty) => proceed
      }
      setStatus(t, conflict ? 'conflict' : 'queued');
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, tasks.length) }, worker));
}

function uniqueUploadName(prefix, filename) {
  const existing = new Set();
  for (const f of store.getState().listing.files) existing.add(f.key);
  for (const u of store.getState().uploads) {
    if (u.status !== 'cancelled' && u.status !== 'error') existing.add(`${u.prefix}${u.uploadName}`);
  }
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let n = 1;
  let candidate;
  do {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  } while (existing.has(`${prefix}${candidate}`));
  return candidate;
}

function resolveConflict(id, action) {
  const t = store.getState().uploads.find((u) => u.id === id);
  if (!t || t.status !== 'conflict') return;
  if (action === 'skip') {
    patchUpload(id, { status: 'cancelled', error: 'Skipped (already exists)' });
  } else if (action === 'replace') {
    patchUpload(id, { status: 'queued' });
    pumpQueue();
  } else if (action === 'keepboth') {
    const newName = uniqueUploadName(t.prefix, t.uploadName);
    patchUpload(id, { uploadName: newName, name: newName, status: 'queued' });
    pumpQueue();
  }
}

function applyConflictAll(action) {
  for (const t of store.getState().uploads) if (t.status === 'conflict') resolveConflict(t.id, action);
}

function pumpQueue() {
  let slots = MAX_CONCURRENT - store.getState().uploads.filter((u) => u.status === 'uploading').length;
  for (const task of store.getState().uploads) {
    if (slots <= 0) break;
    if (task.status === 'queued') {
      startUpload(task);
      slots -= 1;
    }
  }
}

function startUpload(task) {
  const attempts = (store.getState().uploads.find((u) => u.id === task.id)?.attempts || 0) + 1;
  patchUpload(task.id, { status: 'uploading', attempts, error: null, sent: 0, rate: 0 });
  lastSample.delete(task.id);
  // Track only bytes sent; keep total = file.size (the XHR's e.total includes
  // multipart-form overhead, which would make the bar never reach 100%).
  // Large files use RESUMABLE multipart (slice + persist part ETags), so a retry
  // continues from the last completed part instead of byte 0; small files use the
  // simpler single-shot POST. Both expose the same { promise, abort } contract.
  const useMultipart = task.file && task.file.size > MULTIPART_THRESHOLD;
  const { promise, abort } = useMultipart
    ? multipartUpload(task.bucket, task.prefix, task.file, (sent) => onUploadProgress(task, sent), task.uploadName, task.id, task.resumeUploadId, task.handle)
    : api.uploadFile(task.bucket, task.prefix, task.file, (sent) => onUploadProgress(task, sent), task.uploadName);
  activeXhrs.set(task.id, abort);
  promise
    .then(() => {
      patchUpload(task.id, { status: 'done', sent: task.total, rate: 0 });
      forgetUpload(task.id);
    })
    .catch((e) => {
      if (e.code === 'ABORTED') {
        patchUpload(task.id, { status: 'cancelled' });
        forgetUpload(task.id);
        return;
      }
      const transient = e.code === 'NETWORK' || (e.status && e.status >= 500);
      if (transient && attempts < MAX_UPLOAD_ATTEMPTS) {
        patchUpload(task.id, { status: 'retrying', error: e.message });
        setTimeout(() => {
          const cur = store.getState().uploads.find((u) => u.id === task.id);
          if (cur && cur.status === 'retrying') {
            patchUpload(task.id, { status: 'queued', error: null });
            pumpQueue();
          }
        }, 500 * 2 ** attempts);
      } else {
        patchUpload(task.id, { status: 'error', error: e.message });
        forgetUpload(task.id);
      }
    })
    .finally(() => {
      activeXhrs.delete(task.id);
      scheduleSettle();
      pumpQueue();
    });
}

function retryUpload(id) {
  const t = store.getState().uploads.find((u) => u.id === id);
  if (!t || (t.status !== 'error' && t.status !== 'cancelled')) return;
  reportedUploadIds.delete(id);
  patchUpload(id, { status: 'queued', sent: 0, rate: 0, error: null });
  pumpQueue();
}

function retryAllFailed() {
  for (const t of store.getState().uploads) if (t.status === 'error') retryUpload(t.id);
}

function pickOneFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files && input.files[0] ? input.files[0] : null); input.remove(); }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

// Resume an upload interrupted by a reload/crash: the in-progress multipart upload
// still exists in S3, so the user re-selects the file (its bytes can't be persisted)
// and — only if it matches by size + last-modified, so we never splice a different
// file onto already-uploaded parts — we continue from the last completed part.
async function resumeInterruptedUpload(id) {
  const task = store.getState().uploads.find((u) => u.id === id);
  if (!task || task.status !== 'interrupted') return;
  let file = null;
  let handle = task.handle || null;
  try {
    // Preferred: re-read the handle captured at pick/drop time. This Resume click is
    // the gesture requestPermission needs, so no disk re-pick is required.
    if (handle && handle.requestPermission) {
      const perm = await handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') file = await handle.getFile();
      else handle = null; // refused -> fall through to a manual re-pick
    }
    // Fallback (no handle captured, permission refused, or non-FSA browser): re-pick.
    if (!file) {
      if (window.showOpenFilePicker) {
        const [picked] = await window.showOpenFilePicker();
        handle = picked;
        file = await picked.getFile();
      } else {
        file = await pickOneFile();
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user dismissed the picker
    toast({ kind: 'error', message: e.message });
    return;
  }
  if (!file) return; // cancelled
  // Guard even with a stored handle: the file on disk could have been edited since.
  if (file.size !== task.fileSize || file.lastModified !== task.lastModified) {
    toast({ kind: 'error', message: t('tr.uploadResumeMismatch', { name: task.uploadName }) });
    return;
  }
  // resumeUploadId is read by startUpload -> multipartUpload (reconciles via ListParts);
  // re-persisting `handle` lets a second interruption resume without a re-pick too.
  patchUpload(id, { file, handle, status: 'queued', error: null, needsPermission: false });
  pumpQueue();
}

// Stop the whole upload batch: abort in-flight transfers and drop everything
// still queued / waiting (incl. unresolved conflicts).
function cancelAllUploads() {
  for (const u of [...store.getState().uploads]) {
    if (['checking', 'queued', 'uploading', 'retrying', 'conflict'].includes(u.status)) cancelUpload(u.id);
  }
}

function scheduleSettle() {
  const pending = store.getState().uploads.some((u) => u.status === 'queued' || u.status === 'uploading');
  if (pending || settleArmed) return;
  settleArmed = true;
  store.beginRequest(); // keep settle() pending until the post-upload refresh completes
  clearTimeout(settleTimer);
  settleTimer = setTimeout(async () => {
    try {
      const ups = store.getState().uploads;
      // Only count tasks that became terminal since the last settle (per-batch).
      const freshDone = ups.filter((u) => u.status === 'done' && !reportedUploadIds.has(u.id));
      const freshErr = ups.filter((u) => u.status === 'error' && !reportedUploadIds.has(u.id));
      [...freshDone, ...freshErr].forEach((u) => reportedUploadIds.add(u.id));
      if (freshDone.length) toast({ kind: 'success', message: t('tr.uploadedN', { n: freshDone.length }) });
      if (freshErr.length) toast({ kind: 'error', message: t('tr.failedN', { n: freshErr.length }) });
      await loadListing();
    } finally {
      settleArmed = false;
      store.endRequest();
    }
  }, 60);
}

function cancelUpload(id) {
  const abort = activeXhrs.get(id);
  if (abort) abort(); // active XHR -> onabort marks cancelled
  else {
    patchUpload(id, { status: 'cancelled' });
    forgetUpload(id);
  }
}

// "Clear completed" removes only succeeded tasks; failures/cancellations stay
// visible until explicitly dismissed so they never silently vanish.
function clearFinishedUploads() {
  store.setState((s) => ({ uploads: s.uploads.filter((u) => u.status !== 'done') }));
}

// Reclaim a failed/cancelled task's open multipart upload (if any) so dismissing
// it never leaves an orphaned, still-billed upload in the bucket. Best-effort.
function reclaimMultipart(task) {
  if (task && (task.status === 'error' || task.status === 'cancelled') && task.file && task.file.size > MULTIPART_THRESHOLD) {
    abandonMultipart(task.id, task.bucket, task.prefix, task.file, task.uploadName);
  }
}

function dismissUpload(id) {
  const task = store.getState().uploads.find((u) => u.id === id);
  reclaimMultipart(task);
  // Dismissing a restored-but-interrupted upload abandons its open S3 multipart
  // upload (so it isn't billed) and drops the resume pointer.
  if (task && task.status === 'interrupted' && task.resumeUploadId) {
    api.mpAbort(task.bucket, `${task.prefix}${task.uploadName}`, task.resumeUploadId).catch(() => {});
    deleteTransfer(`mpu-${id}`).catch(() => {});
  }
  store.setState((s) => ({ uploads: s.uploads.filter((u) => u.id !== id) }));
}

function dismissFailedUploads() {
  for (const u of store.getState().uploads) if (u.status === 'error' || u.status === 'cancelled') reclaimMultipart(u);
  store.setState((s) => ({ uploads: s.uploads.filter((u) => u.status !== 'error' && u.status !== 'cancelled') }));
}

// Orphan sweep: list in-progress multipart uploads in the current bucket and abort
// the stale ones (older than `olderThanMs`, default 24h) that no live task owns.
// Reclaims uploads left open by a hard crash/close. Returns the count aborted.
async function cleanupIncompleteUploads(olderThanMs = 24 * 60 * 60 * 1000) {
  const bucket = store.getState().location.bucket;
  if (!bucket) return 0;
  const { uploads } = await api.mpListUploads(bucket);
  const cutoff = Date.now() - olderThanMs;
  const stale = uploads.filter((u) => !u.initiated || new Date(u.initiated).getTime() < cutoff);
  let aborted = 0;
  for (const u of stale) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await api.mpAbort(bucket, u.key, u.uploadId);
      aborted += 1;
    } catch {
      /* skip ones we can't abort */
    }
  }
  return aborted;
}

const UPLOAD_PENDING = ['checking', 'queued', 'uploading', 'retrying'];
const uploadsPending = () => store.getState().uploads.some((u) => UPLOAD_PENDING.includes(u.status));

export const actions = {
  loadProfiles,
  loadBuckets,
  loadListing,
  loadMore,
  refresh,
  runRecursiveSearch,
  loadMoreRecursive,
  clearRecursiveSearch,
  onRoute,
  selectProfile,
  selectBucket,
  openPrefix,
  createFolderFlow,
  renameFlow,
  moveFlow,
  deleteFlow,
  downloadKey,
  downloadFolder,
  bulkDownload,
  canPickDirectory,
  shareLink,
  showInfo,
  saveProfile,
  deleteProfileFlow,
  enqueueUploads,
  pickFilesAndUpload,
  cancelUpload,
  cancelAllUploads,
  retryUpload,
  retryAllFailed,
  resumeInterruptedUpload,
  resolveConflict,
  applyConflictAll,
  clearFinishedUploads,
  dismissUpload,
  dismissFailedUploads,
  cleanupIncompleteUploads,
  uploadsPending,
  // downloads
  cancelDownload,
  cancelAllDownloads,
  retryDownload,
  clearFinishedDownloads,
  dismissDownload,
  hydrateTransfers,
  resumePersistedDownload,
  downloadsPending,
};
