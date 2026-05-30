// Shared modal scaffolding: overlay + dialog, Escape to close, click-outside to
// close, a Tab focus trap, and focus restoration. A modal stack ensures only the
// topmost dialog responds to Escape/Tab so nested modals behave correctly.
import { h, qs } from '../dom.js';

const stack = [];
let globalBound = false;
let modalSeq = 0;

function onGlobalKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    top.close();
  } else if (e.key === 'Tab') {
    top.trap(e);
  }
}

function bindGlobal() {
  if (globalBound) return;
  document.addEventListener('keydown', onGlobalKey, true);
  globalBound = true;
}

export function openModal({ testid, render, onClose, initialFocus }) {
  const root = qs('modal-root');
  const prevFocus = document.activeElement;
  let closed = false;

  const dialog = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  const overlay = h(
    'div',
    {
      class: 'modal-overlay',
      testid,
      onMousedown: (e) => {
        if (e.target === overlay) close();
      },
    },
    dialog,
  );

  const focusables = () =>
    [
      ...overlay.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => el.offsetParent !== null);

  function trap(e) {
    const f = focusables();
    if (f.length === 0) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(inst);
    if (i >= 0) stack.splice(i, 1);
    overlay.remove();
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try {
        prevFocus.focus();
      } catch {
        /* gone */
      }
    }
    if (onClose) onClose();
  }

  const inst = { close, trap };

  const content = render(close);
  if (Array.isArray(content)) dialog.append(...content);
  else dialog.appendChild(content);

  // Give the dialog an accessible name from its heading (role=dialog needs one).
  const heading = dialog.querySelector('h2');
  if (heading) {
    modalSeq += 1;
    heading.id = `modal-title-${modalSeq}`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }

  root.appendChild(overlay);
  stack.push(inst);
  bindGlobal();

  const target = initialFocus ? dialog.querySelector(initialFocus) : focusables()[0];
  if (target) target.focus();

  return { overlay, dialog, close };
}
