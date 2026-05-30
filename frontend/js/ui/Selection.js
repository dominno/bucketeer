// Selection helpers operating on the store's `selection` Set (keyed by object
// key / folder prefix). A module-level anchor supports shift-click ranges.
import { store } from '../store.js';

let anchor = null;

export const isSelected = (key) => store.getState().selection.has(key);

export function toggle(key) {
  const s = new Set(store.getState().selection);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  store.setState({ selection: s });
  anchor = key;
}

export function selectOnly(key) {
  store.setState({ selection: new Set([key]) });
  anchor = key;
}

export function clearSelection() {
  if (store.getState().selection.size) store.setState({ selection: new Set() });
  anchor = null;
}

export function selectRange(orderedKeys, toKey) {
  const from = anchor && orderedKeys.includes(anchor) ? anchor : toKey;
  const a = orderedKeys.indexOf(from);
  const b = orderedKeys.indexOf(toKey);
  if (a < 0 || b < 0) return;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  const s = new Set(store.getState().selection);
  for (let i = lo; i <= hi; i += 1) s.add(orderedKeys[i]);
  store.setState({ selection: s });
}

export function toggleAll(allKeys) {
  const s = store.getState().selection;
  const allSelected = allKeys.length > 0 && allKeys.every((k) => s.has(k));
  store.setState({ selection: allSelected ? new Set() : new Set(allKeys) });
}
