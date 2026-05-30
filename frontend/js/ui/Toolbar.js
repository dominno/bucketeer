// Toolbar: upload / new-folder / refresh, plus a selection action bar.
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { t } from '../i18n.js';
import { clearSelection } from './Selection.js';

export function initToolbar() {
  const root = qs('toolbar');

  // Hidden inputs reused across renders (kept outside the re-rendered tree).
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    testid: 'file-input',
    style: 'display:none',
    onChange: (e) => {
      if (e.target.files && e.target.files.length) actions.enqueueUploads(e.target.files);
      e.target.value = '';
    },
  });
  // webkitdirectory lets the user pick a whole folder; each File carries a
  // webkitRelativePath (e.g. "myfolder/sub/a.txt") which enqueueUploads turns
  // into the destination subpath, preserving the structure.
  const folderInput = h('input', {
    type: 'file',
    multiple: true,
    webkitdirectory: '',
    directory: '',
    testid: 'folder-input',
    style: 'display:none',
    onChange: (e) => {
      if (e.target.files && e.target.files.length) actions.enqueueUploads(e.target.files);
      e.target.value = '';
    },
  });
  document.body.appendChild(fileInput);
  document.body.appendChild(folderInput);

  function render() {
    const st = store.getState();
    const hasBucket = Boolean(st.location.bucket);
    const selCount = st.selection.size;

    const left = h(
      'div',
      { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap' },
      // Decide picker-vs-input SYNCHRONOUSLY so the <input> fallback keeps its user
      // gesture (an input.click() after an await is blocked). Chromium/Electron use the
      // handle-capturing FSA picker; other browsers + webdriver/tests use the <input>.
      h('button', { class: 'btn btn-primary', testid: 'upload-btn', disabled: !hasBucket, onClick: () => { if (window.showOpenFilePicker && !navigator.webdriver) actions.pickFilesAndUpload(); else fileInput.click(); } }, icon('upload', { size: 15 }), t('toolbar.upload')),
      h('button', { class: 'btn', testid: 'upload-folder-btn', disabled: !hasBucket, title: t('toolbar.uploadFolderHint'), onClick: () => folderInput.click() }, icon('folder', { size: 15 }), t('toolbar.uploadFolder')),
      h('button', { class: 'btn', testid: 'new-folder-btn', disabled: !hasBucket, onClick: () => actions.createFolderFlow() }, icon('plus', { size: 15 }), t('toolbar.newFolder')),
      h('button', { class: 'btn btn-ghost btn-icon', testid: 'refresh-btn', disabled: !hasBucket, title: t('toolbar.refresh'), 'aria-label': t('toolbar.refresh'), onClick: () => actions.refresh() }, icon('refresh', { size: 16 })),
    );

    const children = [left, h('div', { class: 'spacer' })];

    if (selCount > 0) {
      children.push(
        h(
          'div',
          { class: 'selection-bar', testid: 'selection-bar' },
          h('span', { testid: 'selection-count' }, t('toolbar.selected', { n: selCount })),
          h('button', { class: 'btn btn-ghost btn-icon', testid: 'bulk-download-btn', title: t('toolbar.downloadSelected'), 'aria-label': t('toolbar.downloadSelected'), onClick: () => actions.bulkDownload() }, icon('download', { size: 16 })),
          h('button', { class: 'btn btn-ghost btn-icon', testid: 'bulk-delete-btn', title: t('toolbar.deleteSelected'), 'aria-label': t('toolbar.deleteSelected'), onClick: () => actions.deleteFlow([...store.getState().selection]) }, icon('trash', { size: 16 })),
          h('button', { class: 'btn btn-ghost btn-icon', testid: 'selection-clear-btn', title: t('toolbar.clearSelection'), 'aria-label': t('toolbar.clearSelection'), onClick: () => clearSelection() }, icon('close', { size: 16 })),
        ),
      );
    }
    mount(root, ...children);
  }

  store.subscribe(render);
  render();
}
