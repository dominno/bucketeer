// The main file/folder listing: sortable, searchable, selectable, with per-row
// and bulk actions. Folders sort above files. Explicit loading/empty/error states.
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { humanFileSize, formatDate, typeLabel, previewKind, matchesQuery } from '../format.js';
import { t } from '../i18n.js';
import { isSelected, toggle, selectRange, toggleAll, selectOnly } from './Selection.js';
import { openPreview } from './PreviewModal.js';

export function initFileTable() {
  const root = qs('file-table');

  function rowsModel(st) {
    const match = (name) => matchesQuery(name, st.search);
    const folders = st.listing.folders
      .filter((f) => match(f.name))
      .map((f) => ({ key: f.prefix, name: f.name, size: null, lastModified: null, isFolder: true }));
    const files = st.listing.files
      .filter((f) => match(f.name))
      .map((f) => ({ key: f.key, name: f.name, size: f.size, lastModified: f.lastModified, isFolder: false }));

    const { col, dir } = st.sort;
    const mul = dir === 'desc' ? -1 : 1;
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    folders.sort((a, b) => (col === 'name' ? mul : 1) * byName(a, b));
    files.sort((a, b) => {
      if (col === 'size') return mul * ((a.size || 0) - (b.size || 0));
      if (col === 'modified') return mul * (new Date(a.lastModified || 0) - new Date(b.lastModified || 0));
      return mul * byName(a, b);
    });
    return [...folders, ...files];
  }

  function sortHeader(label, col, st, extraClass = '') {
    const active = st.sort.col === col;
    const arrow = active ? (st.sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
    const toggle = () => {
      const cur = store.getState().sort;
      store.setState({ sort: { col, dir: cur.col === col && cur.dir === 'asc' ? 'desc' : 'asc' } });
    };
    return h(
      'th',
      {
        class: `sortable ${extraClass}`,
        testid: `sort-${col}`,
        tabindex: '0',
        role: 'button',
        'aria-sort': active ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
        onClick: toggle,
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        },
      },
      `${label}${arrow}`,
    );
  }

  // Open the preview lightbox, passing the previewable files in current display
  // order so the user can page through them with the arrows.
  function openPreviewFor(row) {
    const previewable = rowsModel(store.getState()).filter((r) => !r.isFolder && previewKind(r.name));
    openPreview(row, previewKind(row.name) ? previewable : [row]);
  }

  function actionBtn(testid, name, title, onClick) {
    return h(
      'button',
      {
        class: 'btn btn-ghost btn-icon',
        testid,
        title,
        'aria-label': title,
        onClick: (e) => {
          e.stopPropagation();
          onClick();
        },
      },
      icon(name, { size: 15 }),
    );
  }

  function renderRow(row, orderedKeys) {
    const selected = isSelected(row.key);
    const checkbox = h('input', {
      type: 'checkbox',
      testid: `row-checkbox-${row.key}`,
      'aria-label': t('table.selectRow', { name: row.name }),
      checked: selected,
      onClick: (e) => {
        e.stopPropagation();
        if (e.shiftKey) selectRange(orderedKeys, row.key);
        else toggle(row.key);
      },
    });

    const nameBtn = h(
      'button',
      {
        class: 'name-btn',
        testid: `row-name-${row.key}`,
        title: row.name,
        onClick: () => (row.isFolder ? actions.openPrefix(row.key) : openPreviewFor(row)),
      },
      row.name,
    );

    const rowActions = h(
      'div',
      { class: 'row-actions' },
      ...(row.isFolder
        ? [actionBtn(`download-${row.key}`, 'download', t(actions.canPickDirectory() ? 'tr.downloadToFolder' : 'action.downloadZip'), () => actions.downloadFolder(row.key))]
        : [
            ...(previewKind(row.name) ? [actionBtn(`preview-${row.key}`, 'eye', t('action.preview'), () => openPreviewFor(row))] : []),
            actionBtn(`download-${row.key}`, 'download', t('action.download'), () => actions.downloadKey(row.key)),
            actionBtn(`share-${row.key}`, 'link', t('action.shareLink'), () => actions.shareLink(row.key)),
          ]),
      actionBtn(`info-${row.key}`, 'info', t('action.info'), () => actions.showInfo({ key: row.key, name: row.name, isFolder: row.isFolder })),
      actionBtn(`rename-${row.key}`, 'rename', t('action.rename'), () => actions.renameFlow(row)),
      actionBtn(`move-${row.key}`, 'upload', t('action.move'), () => actions.moveFlow(row)),
      actionBtn(`delete-${row.key}`, 'trash', t('action.delete'), () => actions.deleteFlow([row.key])),
    );

    const mod = row.isFolder ? { text: '—', title: '' } : formatDate(row.lastModified);
    return h(
      'tr',
      {
        class: selected ? 'selected' : '',
        testid: row.isFolder ? `row-folder-${row.key}` : `row-file-${row.key}`,
        // Click a folder anywhere -> open it; click a file row -> select it
        // (the checkbox handles selection for both; row actions stopPropagation).
        onClick: () => (row.isFolder ? actions.openPrefix(row.key) : selectOnly(row.key)),
      },
      h('td', { class: 'col-check', onClick: (e) => e.stopPropagation() }, checkbox),
      h(
        'td',
        {},
        h('div', { class: 'name-cell' }, icon(row.isFolder ? 'folder' : 'file', { size: 17, cls: row.isFolder ? 'folder-icon' : '' }), nameBtn),
      ),
      h('td', { class: 'col-size' }, row.isFolder ? '—' : humanFileSize(row.size)),
      h('td', { class: 'col-modified', title: mod.title }, mod.text),
      h('td', { class: 'col-type' }, row.isFolder ? t('table.typeFolder') : typeLabel(row.name)),
      h('td', { class: 'col-actions' }, rowActions),
    );
  }

  function stateBlock(kind, testid, iconName, title, msg, action) {
    return h(
      'div',
      { class: `state ${kind}`, testid },
      icon(iconName, { size: 40 }),
      h('h3', {}, title),
      msg ? h('p', {}, msg) : null,
      action || null,
    );
  }

  // A bar shown while filtering a folder, offering to widen to a recursive search.
  function searchAllBar(visibleCount) {
    return h(
      'div',
      { class: 'recursive-bar', testid: 'search-scope-bar' },
      icon('search', { size: 15 }),
      h('span', { class: 'transfer-sub', style: 'display:inline' }, t('search.scopeBar', { n: visibleCount })),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn btn-mini', testid: 'search-all-btn', onClick: () => actions.runRecursiveSearch() }, t('search.all')),
    );
  }

  // One recursive-search result row (flat; shows the file's folder path).
  function recursiveResultRow(r, previewable) {
    const dir = r.key.slice(0, r.key.lastIndexOf('/') + 1);
    const kind = previewKind(r.name);
    const open = () => {
      const item = { key: r.key, name: r.name, isFolder: false };
      if (kind) openPreview(item, previewable);
      else actions.downloadKey(r.key);
    };
    const mod = formatDate(r.lastModified);
    return h(
      'tr',
      { testid: `result-${r.key}` },
      h(
        'td',
        {},
        h(
          'div',
          { class: 'name-cell' },
          icon('file', { size: 17 }),
          h(
            'div',
            { style: 'min-width:0' },
            h('button', { class: 'name-btn', testid: `result-name-${r.key}`, title: r.key, onClick: open }, r.name),
            h('div', { class: 'transfer-sub', title: dir || '/' }, dir || '/'),
          ),
        ),
      ),
      h('td', { class: 'col-size' }, humanFileSize(r.size)),
      h('td', { class: 'col-modified', title: mod.title }, mod.text),
      h('td', { class: 'col-type' }, typeLabel(r.name)),
      h(
        'td',
        { class: 'col-actions' },
        h(
          'div',
          { class: 'row-actions' },
          kind ? actionBtn(`result-preview-${r.key}`, 'eye', t('action.preview'), open) : null,
          actionBtn(`result-download-${r.key}`, 'download', t('action.download'), () => actions.downloadKey(r.key)),
          actionBtn(`result-reveal-${r.key}`, 'folder', t('action.reveal'), () => actions.openPrefix(dir)),
          actionBtn(`result-share-${r.key}`, 'link', t('action.shareLink'), () => actions.shareLink(r.key)),
        ),
      ),
    );
  }

  function renderRecursive(st) {
    const rec = st.recursive;
    const banner = h(
      'div',
      { class: 'recursive-bar', testid: 'recursive-bar' },
      icon('search', { size: 15 }),
      h('span', {}, h('b', {}, t('search.resultsTitle', { q: rec.query })), ' ', h('span', { class: 'transfer-sub', style: 'display:inline' }, t('search.scopeNote'))),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn btn-mini', testid: 'recursive-clear', onClick: () => actions.clearRecursiveSearch() }, t('search.back')),
    );
    if (rec.status === 'loading') {
      mount(root, banner, h('div', { class: 'state', testid: 'recursive-loading' }, h('div', { class: 'spinner' }), h('p', {}, t('search.searching'))));
      return;
    }
    if (rec.status === 'error') {
      mount(root, banner, stateBlock('error', 'recursive-error', 'close', t('table.loadError'), rec.error || '', h('button', { class: 'btn', onClick: () => actions.runRecursiveSearch() }, t('table.retry'))));
      return;
    }
    if (!rec.results.length) {
      mount(root, banner, stateBlock('', 'recursive-none', 'search', t('table.noMatchesTitle'), t('search.none', { q: rec.query })));
      return;
    }
    const previewable = rec.results.filter((r) => previewKind(r.name)).map((r) => ({ key: r.key, name: r.name, isFolder: false }));
    const table = h(
      'table',
      { class: 'files' },
      h('thead', {}, h('tr', {}, h('th', {}, t('search.count', { n: rec.results.length })), h('th', { class: 'col-size' }, t('table.colSize')), h('th', { class: 'col-modified' }, t('table.colModified')), h('th', { class: 'col-type' }, t('table.colType')), h('th', { class: 'col-actions' }, ''))),
      h('tbody', { testid: 'result-rows' }, ...rec.results.map((r) => recursiveResultRow(r, previewable))),
    );
    const children = [banner, table];
    // Paginate: when the server stopped at a scan boundary it returns a token to
    // resume from — offer "load more" instead of telling the user to narrow it.
    if (rec.nextToken) {
      children.push(
        h(
          'div',
          { class: 'recursive-more', style: 'padding:12px; text-align:center', testid: 'recursive-more' },
          h(
            'button',
            { class: 'btn', testid: 'recursive-load-more', disabled: !!rec.loadingMore, onClick: () => actions.loadMoreRecursive() },
            rec.loadingMore ? t('search.searchingMore') : t('search.loadMore', { n: rec.results.length }),
          ),
        ),
      );
    }
    mount(root, ...children);
  }

  function render() {
    const st = store.getState();

    // Preserve keyboard focus across the full re-render (e.g. toggling a row
    // checkbox re-renders the whole table and would otherwise drop focus).
    const activeEl = document.activeElement;
    const focusedTestid = activeEl && root.contains(activeEl) ? activeEl.dataset.testid : null;
    const restoreFocus = () => {
      if (!focusedTestid) return;
      const el = [...root.querySelectorAll('[data-testid]')].find((n) => n.dataset.testid === focusedTestid);
      if (el) el.focus();
    };

    if (!st.activeProfileId) {
      mount(root, stateBlock('', 'table-no-profile', 'gear', t('table.noProfileTitle'), t('table.noProfileMsg')));
      return;
    }
    if (!st.location.bucket) {
      mount(root, stateBlock('', 'table-select-bucket', 'database', t('table.selectBucketTitle'), t('table.selectBucketMsg')));
      return;
    }
    if (st.recursive) {
      renderRecursive(st);
      restoreFocus();
      return;
    }
    if (st.listing.status === 'loading' && st.listing.folders.length === 0 && st.listing.files.length === 0) {
      const skeleton = h('div', { testid: 'table-loading' });
      for (let i = 0; i < 7; i += 1) {
        skeleton.appendChild(
          h('div', { class: 'skeleton-row' }, h('div', { class: 'skeleton-bar', style: 'width:18px' }), h('div', { class: 'skeleton-bar', style: `width:${30 + ((i * 13) % 45)}%` })),
        );
      }
      mount(root, skeleton);
      return;
    }
    if (st.listing.status === 'error') {
      const e = st.listing.error || {};
      const is403 = e.code === 'AccessDenied';
      mount(
        root,
        stateBlock(
          'error',
          'table-error',
          'close',
          is403 ? t('table.accessDenied') : t('table.loadError'),
          e.message || t('table.errorGeneric'),
          h('button', { class: 'btn', testid: 'retry-btn', onClick: () => actions.refresh() }, t('table.retry')),
        ),
      );
      return;
    }

    const rows = rowsModel(st);
    const orderedKeys = rows.map((r) => r.key);
    const totalItems = st.listing.folders.length + st.listing.files.length;

    if (totalItems === 0) {
      mount(root, stateBlock('', 'table-empty', 'folder', t('table.emptyTitle'), t('table.emptyMsg')));
      return;
    }
    if (rows.length === 0) {
      const children = [
        stateBlock(
          '',
          'table-no-matches',
          'search',
          t('table.noMatchesTitle'),
          t('table.noMatchesMsg', { q: st.search }),
          h('button', { class: 'btn btn-primary', testid: 'search-all-btn', onClick: () => actions.runRecursiveSearch() }, t('search.all')),
        ),
      ];
      // A later (unfetched) page might contain a match — let the user load more.
      if (st.listing.nextContinuationToken) {
        children.push(
          h(
            'div',
            { class: 'load-more' },
            h('button', { class: 'btn', testid: 'load-more-btn', disabled: st.listing.status === 'loading', onClick: () => actions.loadMore() }, st.listing.status === 'loading' ? t('table.loading') : t('table.loadMoreSearch')),
          ),
        );
      }
      mount(root, ...children);
      return;
    }

    const allSelected = orderedKeys.length > 0 && orderedKeys.every((k) => st.selection.has(k));
    // Reflect the true selection (including rows hidden by the search filter).
    const someSelected = st.selection.size > 0;
    const headCheckbox = h('input', {
      type: 'checkbox',
      testid: 'select-all',
      'aria-label': t('table.selectAll'),
      checked: allSelected,
      onClick: () => toggleAll(orderedKeys),
    });
    headCheckbox.indeterminate = someSelected && !allSelected;

    const table = h(
      'table',
      { class: 'files' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { class: 'col-check' }, headCheckbox),
          sortHeader(t('table.colName'), 'name', st),
          sortHeader(t('table.colSize'), 'size', st, 'col-size'),
          sortHeader(t('table.colModified'), 'modified', st, 'col-modified'),
          h('th', { class: 'col-type' }, t('table.colType')),
          h('th', { class: 'col-actions' }, ''),
        ),
      ),
      h('tbody', { testid: 'file-rows' }, ...rows.map((r) => renderRow(r, orderedKeys))),
    );

    const children = st.search.trim() ? [searchAllBar(rows.length), table] : [table];
    if (st.listing.nextContinuationToken) {
      children.push(
        h(
          'div',
          { class: 'load-more' },
          h('button', { class: 'btn', testid: 'load-more-btn', disabled: st.listing.status === 'loading', onClick: () => actions.loadMore() }, st.listing.status === 'loading' ? t('table.loading') : t('table.loadMore')),
        ),
      );
    }
    mount(root, ...children);
    restoreFocus();
  }

  store.subscribe(render);
  render();
}
