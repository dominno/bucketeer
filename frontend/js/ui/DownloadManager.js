// Download dock: shows managed (streamed-to-disk) downloads with live progress,
// speed/ETA, cancel and retry. Renders into a second dock stacked above the
// upload dock. Fallback <a> downloads are handled by the browser and don't
// appear here.
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { humanFileSize, formatRate, formatDuration } from '../format.js';
import { t as tr } from '../i18n.js';

const ACTIVE = ['queued', 'downloading'];
const STMAP = { queued: 'queued', downloading: 'downloading', done: 'done', error: 'failed', cancelled: 'cancelled' };
const statusLabel = (s) => tr(`st.${STMAP[s] || s}`);
const KIND_ICON = { file: 'file', 'folder-zip': 'folder', 'batch-zip': 'download', tree: 'folder' };

export function initDownloadManager() {
  const dock = qs('download-manager');

  function iconBtn(testid, name, title, onClick) {
    return h('button', { class: 'btn btn-ghost btn-icon', testid, title, 'aria-label': title, onClick }, icon(name, { size: 14 }));
  }

  // Toggle the per-row detail panel (folder-to-disk downloads only). UI-only state,
  // so it flips the store directly — the established pattern for view state here.
  function toggleDetails(id) {
    store.setState((s) => {
      const cur = s.ui.expandedDownloads || [];
      return { ui: { ...s.ui, expandedDownloads: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] } };
    });
  }

  // Split a relative path into a (truncatable) dir prefix and the filename so the
  // name always stays visible while a long dir ellipsizes.
  function pathParts(rel) {
    const i = rel.lastIndexOf('/');
    return i < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, i + 1), name: rel.slice(i + 1) };
  }

  function detailRow(testid, leadIcon, rel, extraClass, size) {
    const { dir, name } = pathParts(rel);
    return h(
      'div',
      { class: `detail-row ${extraClass}`, testid, title: rel },
      leadIcon,
      h('span', { class: 'detail-path' }, dir ? h('span', { class: 'detail-dir' }, dir) : null, h('span', { class: 'detail-name' }, name)),
      size != null ? h('span', { class: 'detail-size' }, humanFileSize(size || 0)) : null,
    );
  }

  function recentBadge(outcome) {
    if (outcome === 'fail') return icon('close', { size: 12 });
    if (outcome === 'skip') return h('span', { class: 'detail-badge-skip' }, tr('tr.skipped'));
    if (outcome === 'present') return h('span', { class: 'detail-badge-skip' }, tr('tr.alreadyOnDisk'));
    return icon('check', { size: 12 }); // done
  }

  function renderRow(t) {
    const isTree = t.kind === 'tree';
    // "scanning" = the folder-to-disk pre-pass that enumerates the selection before
    // any bytes transfer; the count is still growing, so the bar is indeterminate.
    const scanning = isTree && t.scanning && t.status === 'downloading';
    // Tree (folder-to-disk) tasks measure progress by files-done; everything
    // else by bytes-received against a known total.
    const indeterminate = scanning || (t.status === 'downloading' && (isTree ? !t.filesTotal : t.total == null || t.total === 0));
    const pct = t.status === 'done'
      ? 100
      : isTree
        ? t.filesTotal ? Math.min(100, Math.round((t.filesDone / t.filesTotal) * 100)) : 0
        : t.total ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;

    let filesNote = isTree ? tr('tr.filesProgress', { done: t.filesDone || 0, total: t.filesTotal || 0 }) : '';
    if (isTree && t.present) filesNote += ` · ${tr('tr.nAlreadyOnDisk', { n: t.present })}`;
    if (isTree && t.failed) filesNote += ` · ${tr('tr.nFailed', { n: t.failed })}`;

    let sub = '';
    if (scanning) {
      sub = t.foldersTotal > 1
        ? tr('tr.scanningFolders', { n: (t.scanned || 0).toLocaleString(), done: t.foldersScanned || 0, total: t.foldersTotal })
        : tr('tr.scanning', { n: (t.scanned || 0).toLocaleString() });
    } else if (t.status === 'downloading') {
      const got = humanFileSize(t.received);
      const of = t.total ? ` of ${humanFileSize(t.total)}` : '';
      // Clamp the remaining bytes: under per-file retry, received can briefly
      // exceed total, which would otherwise produce a negative ETA.
      const eta = t.total && t.rate > 0 ? Math.max(0, t.total - t.received) / t.rate : null;
      const bytes = `${got}${of}${t.rate ? ` · ${formatRate(t.rate)}` : ''}${eta != null ? ` · ~${formatDuration(eta)}` : ''}`;
      sub = isTree ? `${filesNote} · ${bytes}` : bytes;
    } else if (t.status === 'error') {
      sub = t.error || 'Failed';
    } else if (t.status === 'done') {
      sub = isTree
        ? `${filesNote}${t.present ? ` · ${tr('tr.nAlreadyOnDisk', { n: t.present })}` : ''}${t.skipped ? ` · ${tr('tr.nSkipped', { n: t.skipped })}` : ''} · ${humanFileSize(t.received)}`
        : humanFileSize(t.received);
    } else if (t.status === 'cancelled' && isTree) {
      sub = filesNote;
    } else if (t.status === 'paused') {
      // Restored after a reload: show how far it got and that it can be resumed.
      // Once the object size is known (persisted with the checkpoint) show "X of Y"
      // even at 0 bytes, so the row never looks empty.
      sub = `${tr('st.paused')}${t.total ? ` · ${humanFileSize(t.received || 0)} of ${humanFileSize(t.total)}` : t.received ? ` · ${humanFileSize(t.received)}` : ''}`;
    }

    let buttons;
    if (t.status === 'downloading' || t.status === 'queued') {
      buttons = iconBtn(`download-cancel-${t.id}`, 'close', tr('tr.cancel'), () => actions.cancelDownload(t.id));
    } else if (t.status === 'paused') {
      buttons = h(
        'div',
        { class: 'row-mini-actions' },
        h('button', { class: 'btn btn-mini btn-primary', testid: `download-resume-${t.id}`, onClick: () => actions.resumePersistedDownload(t.id) }, tr('tr.resume')),
        iconBtn(`download-dismiss-${t.id}`, 'close', tr('tr.dismiss'), () => actions.dismissDownload(t.id)),
      );
    } else if (t.status === 'error' || t.status === 'cancelled') {
      buttons = h(
        'div',
        { class: 'row-mini-actions' },
        iconBtn(`download-retry-${t.id}`, 'refresh', tr('tr.retry'), () => actions.retryDownload(t.id)),
        iconBtn(`download-dismiss-${t.id}`, 'close', tr('tr.dismiss'), () => actions.dismissDownload(t.id)),
      );
    } else {
      buttons = iconBtn(`download-dismiss-${t.id}`, 'close', tr('tr.dismiss'), () => actions.dismissDownload(t.id));
    }

    // Folder-to-disk extras: a disclosure toggle, a From->To route line, and (when
    // open) the live "Downloading now" + "Recently saved" lists. Guarded on isTree
    // so zip/file rows (no dest/active/recent) are untouched.
    const expanded = isTree && (store.getState().ui.expandedDownloads || []).includes(t.id);
    const detailToggle = isTree
      ? h(
          'button',
          { class: 'btn btn-ghost btn-icon', testid: `download-detail-toggle-${t.id}`, title: expanded ? tr('tr.hideDetails') : tr('tr.showDetails'), 'aria-label': expanded ? tr('tr.hideDetails') : tr('tr.showDetails'), 'aria-expanded': String(expanded), onClick: () => toggleDetails(t.id) },
          h('span', { class: `detail-toggle ${expanded ? 'open' : ''}`, style: 'display:inline-flex' }, icon('chevron', { size: 14 })),
        )
      : null;

    const route = isTree
      ? h(
          'div',
          { class: 'transfer-route', testid: `download-route-${t.id}` },
          h('span', { class: 'route-seg', title: `${t.bucket}/${t.srcBase || ''}` }, `${tr('tr.from')}: ${t.bucket}/${t.srcBase || tr('tr.rootFolder')}`),
          h('span', { class: 'route-arrow' }, '→'),
          h('span', { class: 'route-seg', title: `${t.dest || ''}/` }, `${tr('tr.to')}: ${t.dest || ''}/`),
        )
      : null;

    let detail = null;
    if (expanded) {
      const act = t.active || [];
      const rec = t.recent || [];
      detail = h(
        'div',
        { class: 'download-detail', testid: `download-detail-${t.id}` },
        act.length ? h('div', { class: 'detail-head' }, tr('tr.downloadingNow')) : null,
        act.length
          ? h('div', { class: 'detail-list' }, ...act.map((rel, i) => detailRow(`download-active-${t.id}-${i}`, icon('download', { size: 12 }), rel, 'active', null)))
          : null,
        rec.length ? h('div', { class: 'detail-head' }, tr('tr.recentlySaved')) : null,
        rec.length
          ? h('div', { class: 'detail-list' }, ...rec.map((r, i) => detailRow(`download-recent-${t.id}-${i}`, recentBadge(r.outcome), r.rel, r.outcome, r.size)))
          : null,
      );
    }

    return h(
      'div',
      { class: `upload-task ${t.status}`, testid: `download-row-${t.id}` },
      h(
        'div',
        { class: 'upload-task-top' },
        detailToggle,
        icon(KIND_ICON[t.kind] || 'download', { size: 15 }),
        h('span', { class: 'upload-name', title: t.name }, t.name),
        h('span', { class: `upload-status ${t.status === 'error' ? 'error' : t.status === 'done' ? 'done' : ''}`, testid: `download-status-${t.id}` }, scanning ? tr('st.scanning') : statusLabel(t.status)),
        buttons || null,
      ),
      sub ? h('div', { class: 'transfer-sub', title: sub }, sub) : null,
      route,
      h(
        'div',
        { class: `progress ${indeterminate ? 'progress--indeterminate' : ''}`, testid: `download-progress-${t.id}`, role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
        h('span', { style: indeterminate ? '' : `width:${pct}%` }),
      ),
      detail,
    );
  }

  function render() {
    const { downloads } = store.getState();
    if (!downloads.length) {
      dock.hidden = true;
      mount(dock);
      return;
    }
    dock.hidden = false;

    const active = downloads.filter((d) => ACTIVE.includes(d.status));
    const done = downloads.filter((d) => d.status === 'done').length;
    const failed = downloads.filter((d) => d.status === 'error').length;
    const sumRate = downloads.filter((d) => d.status === 'downloading').reduce((a, d) => a + (d.rate || 0), 0);
    const sumRecv = active.reduce((a, d) => a + (d.received || 0), 0);

    const title = active.length ? tr('tr.downloadingN', { n: active.length }) : tr('tr.downloads');
    const stats = active.length
      ? `${humanFileSize(sumRecv)}${sumRate ? ` · ${formatRate(sumRate)}` : ''}`
      : [done && tr('tr.nDone', { n: done }), failed && tr('tr.nFailed', { n: failed })].filter(Boolean).join(' · ');

    const head = h(
      'div',
      { class: 'upload-head' },
      h(
        'div',
        { class: 'transfer-head-row' },
        h('span', { testid: 'download-head-title' }, title),
        h(
          'div',
          { style: 'display:flex; gap:2px; margin-left:auto' },
          active.length ? iconBtn('download-cancel-all', 'stop', tr('tr.cancelAll'), () => actions.cancelAllDownloads()) : null,
          iconBtn('download-clear-btn', 'check', tr('tr.clearCompleted'), () => actions.clearFinishedDownloads()),
        ),
      ),
      h('div', { class: 'transfer-stats', testid: 'download-stats' }, stats),
    );

    const MAX_ROWS = 80;
    let shown = downloads;
    let moreNote = null;
    if (downloads.length > MAX_ROWS) {
      const pri = { downloading: 0, queued: 1, error: 2, cancelled: 3, done: 4 };
      shown = [...downloads].sort((a, b) => (pri[a.status] ?? 9) - (pri[b.status] ?? 9)).slice(0, MAX_ROWS);
      moreNote = h('div', { class: 'transfer-sub', style: 'padding:8px 12px', testid: 'download-more-note' }, tr('tr.moreItems', { n: downloads.length - MAX_ROWS }));
    }
    mount(dock, head, h('div', { class: 'upload-list' }, ...shown.map(renderRow), moreNote));
  }

  store.subscribe(render);
  render();
}
