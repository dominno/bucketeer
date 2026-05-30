// Upload dock: aggregate progress + speed/ETA + per-file rows with retry,
// cancel, conflict resolution, and a "what finished" summary. Plus global
// drag-and-drop (folder structure preserved via webkitGetAsEntry).
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { humanFileSize, formatRate, formatDuration } from '../format.js';
import { t as tr } from '../i18n.js';
import { toast } from './Toasts.js';

const ACTIVE = ['checking', 'queued', 'uploading', 'retrying'];
const STMAP = { checking: 'checking', queued: 'queued', uploading: 'uploading', retrying: 'retrying', conflict: 'conflict', interrupted: 'interrupted', done: 'done', error: 'failed', cancelled: 'cancelled' };
const statusLabel = (s) => tr(`st.${STMAP[s] || s}`);

function pct(t) {
  if (t.status === 'done') return 100;
  return t.total > 0 ? Math.min(100, Math.round((t.sent / t.total) * 100)) : 0;
}

export function initUploadManager() {
  const dock = qs('upload-manager');

  function iconBtn(testid, name, title, onClick) {
    return h('button', { class: 'btn btn-ghost btn-icon', testid, title, 'aria-label': title, onClick }, icon(name, { size: 14 }));
  }

  function renderRow(t) {
    // "Preparing" = checking for name conflicts, or the gap before the first part is
    // confirmed (multipart create + first upload). Show an INDETERMINATE bar so the
    // row isn't a frozen 0% — progress only counts server-confirmed bytes, which are 0
    // until the first part lands.
    const preparing = t.status === 'checking' || (t.status === 'uploading' && !t.sent);
    const sub = [];
    if (preparing) {
      sub.push(tr('tr.preparing'));
    } else if (t.status === 'uploading' && t.rate) {
      const eta = t.rate > 0 ? (t.total - t.sent) / t.rate : null;
      sub.push(`${formatRate(t.rate)}${eta != null ? ` · ~${formatDuration(eta)}` : ''}`);
    } else if (t.status === 'error') {
      sub.push(t.error || 'Failed');
    } else if (t.status === 'interrupted') {
      // Now that completed bytes are persisted, show how far it got. With a captured
      // handle, Resume re-reads silently; without one it still needs a disk re-pick.
      const params = { sent: humanFileSize(t.sent || 0), total: humanFileSize(t.total) };
      sub.push(tr(t.handle ? 'tr.uploadInterruptedProgress' : 'tr.uploadInterrupted', params));
    } else if (t.prefix) {
      sub.push(t.prefix || 'bucket root');
    }

    let buttons;
    if (t.status === 'interrupted') {
      buttons = h(
        'div',
        { class: 'row-mini-actions' },
        h('button', { class: 'btn btn-mini btn-primary', testid: `upload-resume-${t.id}`, onClick: () => actions.resumeInterruptedUpload(t.id) }, tr('tr.resume')),
        iconBtn(`upload-dismiss-${t.id}`, 'close', tr('tr.dismiss'), () => actions.dismissUpload(t.id)),
      );
    } else if (t.status === 'conflict') {
      buttons = h(
        'div',
        { class: 'row-mini-actions' },
        h('button', { class: 'btn btn-mini', testid: `upload-replace-${t.id}`, onClick: () => actions.resolveConflict(t.id, 'replace') }, tr('tr.replace')),
        h('button', { class: 'btn btn-mini', testid: `upload-keepboth-${t.id}`, onClick: () => actions.resolveConflict(t.id, 'keepboth') }, tr('tr.keepBoth')),
        h('button', { class: 'btn btn-mini', testid: `upload-skip-${t.id}`, onClick: () => actions.resolveConflict(t.id, 'skip') }, tr('tr.skip')),
      );
    } else if (t.status === 'error' || t.status === 'cancelled') {
      buttons = h(
        'div',
        { class: 'row-mini-actions' },
        t.status === 'error' ? iconBtn(`upload-retry-${t.id}`, 'refresh', tr('tr.retry'), () => actions.retryUpload(t.id)) : null,
        iconBtn(`upload-dismiss-${t.id}`, 'close', tr('tr.dismiss'), () => actions.dismissUpload(t.id)),
      );
    } else if (ACTIVE.includes(t.status)) {
      buttons = iconBtn(`upload-cancel-${t.id}`, 'close', tr('tr.cancel'), () => actions.cancelUpload(t.id));
    }

    return h(
      'div',
      { class: `upload-task ${t.status}`, testid: `upload-task-${t.id}` },
      h(
        'div',
        { class: 'upload-task-top' },
        h('span', { class: 'upload-name', title: t.name }, t.name),
        h('span', { class: `upload-status ${t.status === 'error' ? 'error' : t.status === 'done' ? 'done' : ''}`, testid: `upload-status-${t.id}` }, statusLabel(t.status)),
        buttons || null,
      ),
      sub.length ? h('div', { class: 'transfer-sub', title: sub[0] }, sub[0]) : null,
      h(
        'div',
        { class: `progress ${preparing ? 'progress--indeterminate' : ''}`, testid: `upload-progress-${t.id}`, role: 'progressbar', 'aria-valuenow': String(pct(t)), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('span', { style: preparing ? '' : `width:${pct(t)}%` }),
      ),
    );
  }

  function render() {
    const { uploads } = store.getState();
    if (!uploads.length) {
      dock.hidden = true;
      mount(dock);
      return;
    }
    dock.hidden = false;

    const active = uploads.filter((u) => ACTIVE.includes(u.status));
    const conflicts = uploads.filter((u) => u.status === 'conflict');
    const done = uploads.filter((u) => u.status === 'done').length;
    const failed = uploads.filter((u) => u.status === 'error').length;
    const cancelled = uploads.filter((u) => u.status === 'cancelled').length;

    const sumSent = active.reduce((a, u) => a + (u.sent || 0), 0);
    const sumTotal = active.reduce((a, u) => a + (u.total || 0), 0);
    const sumRate = uploads.filter((u) => u.status === 'uploading').reduce((a, u) => a + (u.rate || 0), 0);
    const aggPct = sumTotal > 0 ? Math.min(100, Math.round((sumSent / sumTotal) * 100)) : 0;
    // Everything still preparing (no server-confirmed bytes yet) -> indeterminate bar.
    const aggPreparing = active.length > 0 && sumSent === 0;
    const eta = sumRate > 0 ? (sumTotal - sumSent) / sumRate : null;

    const title = active.length ? tr('tr.uploadingN', { n: active.length }) : tr('tr.uploads');
    const stats = active.length
      ? `${tr('tr.ofSize', { sent: humanFileSize(sumSent), total: humanFileSize(sumTotal) })}${sumRate ? ` · ${formatRate(sumRate)}` : ''}${eta != null ? ` · ~${formatDuration(eta)}` : ''}`
      : [done && tr('tr.nDone', { n: done }), failed && tr('tr.nFailed', { n: failed }), cancelled && tr('tr.nCancelled', { n: cancelled })].filter(Boolean).join(' · ');

    const head = h(
      'div',
      { class: 'upload-head' },
      h(
        'div',
        { class: 'transfer-head-row' },
        h('span', { testid: 'upload-head-title' }, title),
        h(
          'div',
          { style: 'display:flex; gap:2px; margin-left:auto' },
          active.length ? iconBtn('upload-cancel-all', 'stop', tr('tr.cancelAll'), () => actions.cancelAllUploads()) : null,
          failed ? iconBtn('upload-retry-all', 'refresh', tr('tr.retryAll'), () => actions.retryAllFailed()) : null,
          failed || cancelled ? iconBtn('upload-dismiss-failed', 'trash', tr('tr.dismissFailed'), () => actions.dismissFailedUploads()) : null,
          iconBtn('upload-clear-btn', 'check', tr('tr.clearCompleted'), () => actions.clearFinishedUploads()),
        ),
      ),
      active.length
        ? h(
            'div',
            { class: `progress transfer-aggregate ${aggPreparing ? 'progress--indeterminate' : ''}`, testid: 'upload-aggregate', role: 'progressbar', 'aria-valuenow': String(aggPct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
            h('span', { style: aggPreparing ? '' : `width:${aggPct}%` }),
          )
        : null,
      h('div', { class: 'transfer-stats', testid: 'upload-stats' }, stats),
    );

    const conflictBar = conflicts.length
      ? h(
          'div',
          { class: 'transfer-conflict-bar', testid: 'upload-conflict-bar' },
          h('span', {}, tr('tr.conflictN', { n: conflicts.length })),
          h('div', { style: 'display:flex; gap:4px; margin-left:auto' },
            h('button', { class: 'btn btn-mini', testid: 'upload-replace-all', onClick: () => actions.applyConflictAll('replace') }, tr('tr.replaceAll')),
            h('button', { class: 'btn btn-mini', testid: 'upload-keepboth-all', onClick: () => actions.applyConflictAll('keepboth') }, tr('tr.keepBothAll')),
            h('button', { class: 'btn btn-mini', testid: 'upload-skip-all', onClick: () => actions.applyConflictAll('skip') }, tr('tr.skipAll'))),
        )
      : null;

    // Cap rendered rows so a GB / thousands-of-files batch stays responsive.
    // Small batches keep insertion order; large ones surface active + failed
    // first (counts/aggregate/retry-all above still cover everything).
    const MAX_ROWS = 80;
    let shown = uploads;
    let moreNote = null;
    if (uploads.length > MAX_ROWS) {
      const pri = { uploading: 0, checking: 1, retrying: 2, conflict: 3, queued: 4, error: 5, cancelled: 6, done: 7 };
      shown = [...uploads].sort((a, b) => (pri[a.status] ?? 9) - (pri[b.status] ?? 9)).slice(0, MAX_ROWS);
      moreNote = h('div', { class: 'transfer-sub', style: 'padding:8px 12px', testid: 'upload-more-note' }, tr('tr.moreItems', { n: uploads.length - MAX_ROWS }));
    }
    mount(dock, head, conflictBar, h('div', { class: 'upload-list' }, ...shown.map(renderRow), moreNote));
  }

  store.subscribe(render);
  render();
  initDragAndDrop();
}

// ---- Drag and drop ----
function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

function readEntry(entry, path, out, handle) {
  return new Promise((resolve) => {
    if (entry.isFile) {
      entry.file(
        (file) => {
          out.push({ file, relPath: path, handle: handle || null });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const all = [];
      const readBatch = () =>
        reader.readEntries(
          async (entries) => {
            if (!entries.length) {
              for (const child of all) await readEntry(child, `${path}${entry.name}/`, out);
              resolve();
            } else {
              all.push(...entries);
              readBatch();
            }
          },
          () => resolve(),
        );
      readBatch();
    } else {
      resolve();
    }
  });
}

async function gatherFromDataTransfer(dt) {
  const items = dt.items;
  if (items && items.length && typeof items[0].webkitGetAsEntry === 'function') {
    // Capture BOTH the entry and the FSA handle promise SYNCHRONOUSLY for every item:
    // DataTransferItems are neutered after the first await, so grab them all up front
    // (mirroring the entries-first pattern), THEN await the handle promises.
    const captured = [];
    for (const it of items) {
      const entry = it.webkitGetAsEntry();
      const handleP = typeof it.getAsFileSystemHandle === 'function' ? it.getAsFileSystemHandle() : null;
      if (entry) captured.push({ entry, handleP });
    }
    const handles = await Promise.all(captured.map((c) => (c.handleP ? c.handleP.catch(() => null) : Promise.resolve(null))));
    const out = [];
    for (let i = 0; i < captured.length; i += 1) {
      const { entry } = captured[i];
      const hnd = handles[i];
      // Only a top-level dropped FILE gets a handle; a dropped folder yields a directory
      // handle (skip — per-file handles inside it aren't captured), so it keeps the
      // re-pick fallback on resume.
      const fileHandle = entry.isFile && hnd && hnd.kind === 'file' ? hnd : null;
      // eslint-disable-next-line no-await-in-loop
      await readEntry(entry, '', out, fileHandle);
    }
    if (out.length) return out;
  }
  return Array.from(dt.files || []);
}

function initDragAndDrop() {
  const overlay = qs('dropzone-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    if (store.getState().location.bucket) overlay.hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (!store.getState().location.bucket) {
      toast({ kind: 'error', message: tr('tr.openBucketUpload') });
      return;
    }
    const gathered = await gatherFromDataTransfer(e.dataTransfer);
    if (gathered.length) actions.enqueueUploads(gathered);
  });
}
