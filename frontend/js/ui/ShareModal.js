// Share dialog: mint a presigned GET URL with a CHOSEN expiry (the backend signs
// up to 7 days). Fixes the "link expired before the recipient opened it" problem
// of the old fixed 1-hour share. The URL is generated server-side; the modal shows
// it for copying. (No QR yet — a presigned URL is a secret, so it can't go to an
// external QR service, and a hand-rolled encoder can't be verified here.)
import { h } from '../dom.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { toast } from './Toasts.js';
import { openModal } from './modalbase.js';

const EXPIRIES = [
  { key: 'hour', secs: 3600 },
  { key: 'day', secs: 86400 },
  { key: 'week', secs: 604800 }, // SigV4 hard cap = 7 days
];

export function openShare(item) {
  const bucket = item.bucket || store.getState().location.bucket;
  let expiry = 86400; // default 1 day
  let token = 0; // guards out-of-order generations

  const urlField = h('input', { class: 'input share-url', testid: 'share-url', readonly: 'readonly', value: '' });
  const status = h('div', { class: 'field-hint', testid: 'share-status' }, t('share.generating'));
  const copyBtn = h('button', { class: 'btn btn-primary', testid: 'share-copy', disabled: 'disabled', onClick: doCopy }, t('share.copy'));

  async function generate() {
    const mine = (token += 1);
    urlField.value = '';
    copyBtn.disabled = true;
    status.textContent = t('share.generating');
    try {
      const { url } = await api.presign(bucket, item.key, expiry);
      if (mine !== token) return; // a newer expiry was picked
      urlField.value = url;
      copyBtn.disabled = false;
      status.textContent = t('share.expiresIn', { when: t(`share.exp.${EXPIRIES.find((e) => e.secs === expiry).key}`) });
    } catch (e) {
      if (mine !== token) return;
      status.textContent = t('flow.shareFailed', { msg: e.message });
    }
  }

  async function doCopy() {
    if (!urlField.value) return;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(urlField.value);
      else {
        urlField.select();
        document.execCommand('copy');
      }
      toast({ kind: 'success', message: t('flow.shareCopied') });
    } catch (e) {
      toast({ kind: 'error', message: e.message });
    }
  }

  const expiryButtons = h(
    'div',
    { class: 'share-expiry', testid: 'share-expiry' },
    ...EXPIRIES.map((e) =>
      h(
        'button',
        {
          class: `btn share-exp-btn${e.secs === expiry ? ' active' : ''}`,
          testid: `share-exp-${e.key}`,
          onClick: (ev) => {
            expiry = e.secs;
            for (const b of expiryButtons.querySelectorAll('.share-exp-btn')) b.classList.remove('active');
            ev.currentTarget.classList.add('active');
            generate();
          },
        },
        t(`share.exp.${e.key}`),
      ),
    ),
  );

  openModal({
    testid: 'share-modal',
    initialFocus: '[data-testid="share-copy"]',
    render: (close) => [
      h('div', { class: 'modal-head' }, h('h2', {}, t('share.title'))),
      h(
        'div',
        { class: 'modal-body' },
        h('p', { class: 'share-name', title: item.name }, item.name),
        h('div', { class: 'field-label' }, t('share.expiryLabel')),
        expiryButtons,
        h('div', { class: 'share-url-row' }, urlField, copyBtn),
        status,
        h('p', { class: 'field-hint' }, t('share.note')),
      ),
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn', testid: 'share-close', onClick: close }, t('share.close'))),
    ],
  });

  generate();
}
