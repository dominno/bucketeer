// Ephemeral notifications. Self-contained: appends to the aria-live region and
// auto-dismisses. Returns a handle so long-running ops can update/dismiss.
import { h, qs, icon } from '../dom.js';

let region = null;
export function initToasts() {
  region = qs('toast-region');
}

const ICON_FOR = { success: 'check', error: 'close', info: 'database', progress: 'refresh' };

export function toast({ kind = 'info', message, timeout = 4000 }) {
  if (!region) region = qs('toast-region');
  const msgEl = h('span', { class: 'toast-msg' }, message);
  const node = h(
    'div',
    { class: `toast toast-${kind}`, testid: `toast-${kind}`, 'data-kind': kind, role: 'status' },
    icon(ICON_FOR[kind] || 'database', { size: 16 }),
    msgEl,
  );
  region.appendChild(node);
  let timer = null;
  const dismiss = () => {
    if (timer) clearTimeout(timer);
    node.classList.add('toast-leave');
    setTimeout(() => node.remove(), 180);
  };
  if (timeout > 0) timer = setTimeout(dismiss, timeout);
  return {
    dismiss,
    update(newMessage, newKind) {
      msgEl.textContent = newMessage;
      if (newKind) {
        node.className = `toast toast-${newKind}`;
        node.dataset.kind = newKind;
      }
    },
  };
}
