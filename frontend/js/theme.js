// Light / Dark / System theme. 'system' follows prefers-color-scheme (no attribute,
// the CSS media query handles it); 'light'/'dark' force it via html[data-theme].
// The choice persists in localStorage so it survives reloads and app restarts.
const KEY = 'bkt-theme';
export const THEMES = ['system', 'light', 'dark'];

export function getTheme() {
  const v = localStorage.getItem(KEY);
  return THEMES.includes(v) ? v : 'system';
}

export function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : getTheme();
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
}

export function setTheme(theme) {
  if (!THEMES.includes(theme)) return;
  localStorage.setItem(KEY, theme);
  applyTheme(theme);
}

export function initTheme() {
  applyTheme(getTheme());
}
