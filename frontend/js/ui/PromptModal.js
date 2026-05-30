// Promise-based text prompt (used for new-folder / rename). Resolves the string
// on OK, or null on cancel. `validate(value)` may return an error string.
import { h } from '../dom.js';
import { t } from '../i18n.js';
import { openModal } from './modalbase.js';

export function prompt({ title, label = '', value = '', okText, validate }) {
  title = title || t('prompt.title');
  okText = okText || t('prompt.ok');
  return new Promise((resolve) => {
    let answered = false;
    const errEl = h('p', { class: 'field-error', testid: 'prompt-error' });
    const input = h('input', {
      class: 'input',
      testid: 'prompt-input',
      type: 'text',
      value,
      autocomplete: 'off',
      spellcheck: 'false',
    });

    const submit = (close) => {
      const v = input.value.trim();
      const err = validate ? validate(v) : v ? null : t('prompt.required');
      if (err) {
        errEl.textContent = err;
        input.focus();
        input.select();
        return;
      }
      answered = true;
      close();
      resolve(v);
    };

    openModal({
      testid: 'prompt-modal',
      initialFocus: '[data-testid="prompt-input"]',
      onClose: () => {
        if (!answered) resolve(null);
      },
      render: (close) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit(close);
          }
        });
        return [
          h('div', { class: 'modal-head' }, h('h2', {}, title)),
          h(
            'div',
            { class: 'modal-body' },
            label ? h('label', { class: 'field-label', for: 'prompt-input' }, label) : null,
            input,
            errEl,
          ),
          h(
            'div',
            { class: 'modal-foot' },
            h('button', { class: 'btn', testid: 'prompt-cancel', onClick: close }, t('confirm.cancel')),
            h('button', { class: 'btn btn-primary', testid: 'prompt-ok', onClick: () => submit(close) }, okText),
          ),
        ];
      },
    });
    // Place cursor for rename convenience.
    setTimeout(() => input.select(), 0);
  });
}
