// Promise-based confirmation dialog. Resolves true on confirm, false otherwise.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openModal } from './modalbase.js';

export function confirm({ title, message, okText, danger = false }) {
  title = title || t('confirm.title');
  okText = okText || t('confirm.ok');
  return new Promise((resolve) => {
    let answered = false;
    const settle = (val, close) => {
      answered = true;
      close();
      resolve(val);
    };
    openModal({
      testid: 'confirm-modal',
      onClose: () => {
        if (!answered) resolve(false);
      },
      render: (close) => [
        h('div', { class: 'modal-head' }, h('h2', {}, title)),
        h('div', { class: 'modal-body' }, h('p', { testid: 'confirm-message' }, message)),
        h(
          'div',
          { class: 'modal-foot' },
          h('button', { class: 'btn', testid: 'confirm-no', onClick: () => settle(false, close) }, t('confirm.cancel')),
          h(
            'button',
            { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, testid: 'confirm-yes', onClick: () => settle(true, close) },
            okText,
          ),
        ),
      ],
    });
  });
}
