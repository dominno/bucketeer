// Combined overview that sits atop the transfer docks: one overall progress bar
// across BOTH uploads and downloads, combined speed + time-left, cancel-all, and
// an expand/collapse toggle that maximizes the docks into a full-window panel.
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { humanFileSize, formatRate, formatDuration } from '../format.js';
import { t as tr } from '../i18n.js';

const UP_ACTIVE = ['checking', 'queued', 'uploading', 'retrying'];

export function initTransferOverview() {
  const el = qs('transfer-overview');
  const container = qs('transfer-docks');

  function render() {
    const st = store.getState();
    const ups = st.uploads;
    const dls = st.downloads;
    const total = ups.length + dls.length;

    // Nothing to show -> hide overview and force-collapse.
    if (total === 0) {
      el.hidden = true;
      container.classList.remove('expanded');
      mount(el);
      return;
    }
    el.hidden = false;
    container.classList.toggle('expanded', !!st.transferExpanded);

    const upActive = ups.filter((u) => UP_ACTIVE.includes(u.status));
    const dlActive = dls.filter((d) => d.status === 'queued' || d.status === 'downloading');
    const activeCount = upActive.length + dlActive.length;

    let done = 0;
    let totalBytes = 0;
    let rate = 0;
    let indeterminate = false;
    for (const u of upActive) {
      done += u.sent || 0;
      totalBytes += u.total || 0;
      if (u.status === 'uploading') rate += u.rate || 0;
    }
    for (const d of dlActive) {
      done += d.received || 0;
      if (d.total) totalBytes += d.total;
      else indeterminate = true; // zip stream: unknown length
      if (d.status === 'downloading') rate += d.rate || 0;
    }
    // Active transfers but nothing server-confirmed yet (uploads preparing / awaiting
    // the first bytes) -> animate rather than sit at a flat 0%.
    if (activeCount > 0 && done === 0) indeterminate = true;
    const pct = totalBytes > 0 ? Math.min(100, Math.round((done / totalBytes) * 100)) : 0;
    const eta = !indeterminate && rate > 0 && totalBytes > done ? (totalBytes - done) / rate : null;
    const expanded = !!st.transferExpanded;

    const stat = activeCount
      ? `${humanFileSize(done)}${totalBytes ? ` / ${humanFileSize(totalBytes)}` : ''}${indeterminate ? '' : ` · ${pct}%`}` +
        `${rate ? ` · ${formatRate(rate)}` : ''}${eta != null ? ` · ${tr('tr.timeLeft')} ~${formatDuration(eta)}` : ''}`
      : tr('tr.nothing');

    mount(
      el,
      h(
        'div',
        { class: 'transfer-ov-row' },
        h('span', { class: 'transfer-ov-title' }, tr('tr.transfers'), activeCount ? h('span', { class: 'transfer-ov-count', testid: 'transfer-overview-count' }, ` · ${activeCount}`) : ''),
        h(
          'div',
          { style: 'margin-left:auto; display:flex; gap:2px' },
          activeCount
            ? h('button', { class: 'btn btn-ghost btn-icon', testid: 'transfer-cancel-all', title: tr('tr.cancelAll'), 'aria-label': tr('tr.cancelAll'), onClick: () => { actions.cancelAllUploads(); actions.cancelAllDownloads(); } }, icon('stop', { size: 15 }))
            : null,
          h(
            'button',
            { class: 'btn btn-ghost btn-icon', testid: 'transfer-expand-toggle', title: expanded ? tr('tr.collapse') : tr('tr.expand'), 'aria-label': expanded ? tr('tr.collapse') : tr('tr.expand'), onClick: () => store.setState({ transferExpanded: !expanded }) },
            icon(expanded ? 'minimize' : 'maximize', { size: 15 }),
          ),
        ),
      ),
      activeCount
        ? h(
            'div',
            { class: `progress transfer-aggregate ${indeterminate ? 'progress--indeterminate' : ''}`, testid: 'transfer-overall', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' },
            h('span', { style: indeterminate ? '' : `width:${pct}%` }),
          )
        : null,
      h('div', { class: 'transfer-stats', testid: 'transfer-overall-stats' }, stat),
    );
  }

  // Click the dim backdrop (not the cards) or press Escape to collapse.
  container.addEventListener('click', (e) => {
    if (store.getState().transferExpanded && e.target === container) store.setState({ transferExpanded: false });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && store.getState().transferExpanded) {
      e.preventDefault();
      store.setState({ transferExpanded: false });
    }
  });

  store.subscribe(render);
  render();
}
