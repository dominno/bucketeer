// Asks what to do when a file already exists in the chosen download folder.
// Resolves { action: 'overwrite' | 'keepboth' | 'skip', all: boolean }, or
// rejects with an AbortError when `signal` aborts (so a cancelled bulk download
// tears the modal down instead of leaving a phantom that hijacks Escape/Tab).
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openModal } from './modalbase.js';

export function openConflict({ name, signal }) {
  return new Promise((resolve, reject) => {
    let answered = false;
    const applyAll = h('input', { type: 'checkbox', testid: 'conflict-apply-all' });
    const pick = (action, close) => {
      answered = true;
      close();
      resolve({ action, all: applyAll.checked });
    };
    const { close: closeModal } = openModal({
      testid: 'conflict-modal',
      onClose: () => {
        if (!answered) resolve({ action: 'skip', all: false });
      },
      render: (close) => [
        h('div', { class: 'modal-head' }, h('h2', {}, t('conflict.title'))),
        h(
          'div',
          { class: 'modal-body' },
          h('p', { testid: 'conflict-message' }, t('conflict.exists', { name })),
          h('label', { class: 'field-hint', style: 'display:flex; gap:8px; align-items:center; cursor:pointer' }, applyAll, t('conflict.applyAll')),
        ),
        h(
          'div',
          { class: 'modal-foot' },
          h('button', { class: 'btn', testid: 'conflict-skip', onClick: () => pick('skip', close) }, t('conflict.skip')),
          h('button', { class: 'btn', testid: 'conflict-keepboth', onClick: () => pick('keepboth', close) }, t('conflict.keepBoth')),
          h('button', { class: 'btn btn-danger', testid: 'conflict-overwrite', onClick: () => pick('overwrite', close) }, t('conflict.overwrite')),
        ),
      ],
    });
    if (signal) {
      if (signal.aborted) {
        answered = true;
        closeModal();
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      signal.addEventListener(
        'abort',
        () => {
          if (answered) return;
          answered = true;
          closeModal(); // removes the overlay AND pops the focus-trap stack
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true },
      );
    }
  });
}
