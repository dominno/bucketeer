// Global keyboard shortcuts. Modals manage their own keys (Escape/Tab), so we
// bail out while one is open. Typing in a field suppresses action shortcuts.
import { store } from '../store.js';
import { actions } from '../actions.js';
import { clearSelection } from './Selection.js';

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}
function modalOpen() {
  const r = document.querySelector('[data-testid="modal-root"]');
  return r && r.children.length > 0;
}
function visibleKeys(st) {
  const q = st.search.trim().toLowerCase();
  const match = (n) => !q || n.toLowerCase().includes(q);
  return [
    ...st.listing.folders.filter((f) => match(f.name)).map((f) => f.prefix),
    ...st.listing.files.filter((f) => match(f.name)).map((f) => f.key),
  ];
}

export function initShortcuts({ focusSearch }) {
  document.addEventListener('keydown', (e) => {
    if (modalOpen()) return;
    const mod = e.metaKey || e.ctrlKey;

    if ((e.key === '/' || (mod && (e.key === 'k' || e.key === 'K'))) && !isTyping()) {
      e.preventDefault();
      focusSearch();
      return;
    }
    if (isTyping()) return;

    const st = store.getState();
    if (mod && (e.key === 'a' || e.key === 'A')) {
      if (!st.location.bucket) return;
      e.preventDefault();
      store.setState({ selection: new Set(visibleKeys(st)) });
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && st.selection.size) {
      e.preventDefault();
      actions.deleteFlow([...st.selection]);
      return;
    }
    if (e.key === 'Escape' && st.selection.size) {
      clearSelection();
      return;
    }
    if (e.key === 'F2' && st.selection.size === 1) {
      const key = [...st.selection][0];
      const folder = st.listing.folders.find((f) => f.prefix === key);
      const file = st.listing.files.find((f) => f.key === key);
      const item = folder ? { key, name: folder.name, isFolder: true } : file ? { key, name: file.name, isFolder: false } : null;
      if (item) {
        e.preventDefault();
        actions.renameFlow(item);
      }
    }
  });
}
