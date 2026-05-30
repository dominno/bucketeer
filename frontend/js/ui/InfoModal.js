// Read-only "Info / Properties" panel. For a FILE it shows the object's HEAD
// metadata (type, exact size, modified, ETag, storage class, custom metadata).
// For a FOLDER it rolls up total size + object count via the recursive listing.
import { h } from '../dom.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { t } from '../i18n.js';
import { humanFileSize, formatDate } from '../format.js';
import { openModal } from './modalbase.js';

function row(label, value, testid) {
  if (value == null || value === '') return null;
  return h(
    'div',
    { class: 'info-row' },
    h('span', { class: 'info-label' }, label),
    h('span', { class: 'info-value', testid, title: String(value) }, String(value)),
  );
}

// item: { bucket, key, name, isFolder }
export function openInfo(item) {
  const bucket = item.bucket || store.getState().location.bucket;
  const body = h('div', { class: 'modal-body info-body', testid: 'info-body' });
  const loading = h('div', { class: 'info-row', testid: 'info-loading' }, h('span', { class: 'spinner spinner--sm' }), h('span', {}, t('info.loading')));
  body.appendChild(loading);

  openModal({
    testid: 'info-modal',
    render: (close) => [
      h('div', { class: 'modal-head' }, h('h2', { class: 'info-title', title: item.name }, item.name)),
      body,
      h('div', { class: 'modal-foot' }, h('button', { class: 'btn btn-primary', testid: 'info-close', onClick: close }, t('info.close'))),
    ],
  });

  const fill = (...rows) => {
    loading.remove();
    for (const r of rows) if (r) body.appendChild(r);
  };

  (async () => {
    try {
      if (item.isFolder) {
        const { entries, truncated } = await api.listTree(bucket, item.key);
        const total = entries.reduce((a, e) => a + (e.size || 0), 0);
        const count = entries.length;
        fill(
          row(t('info.location'), `${bucket}/${item.key}`),
          row(t('info.type'), t('info.folder')),
          row(t('info.objects'), truncated ? `${count.toLocaleString()}+` : count.toLocaleString(), 'info-objects'),
          row(t('info.totalSize'), truncated ? `${humanFileSize(total)}+` : humanFileSize(total), 'info-total-size'),
          truncated ? h('p', { class: 'field-hint', testid: 'info-truncated' }, t('info.truncated')) : null,
        );
      } else {
        const m = await api.headObject(bucket, item.key);
        fill(
          row(t('info.location'), `${bucket}/${item.key}`),
          row(t('info.size'), `${humanFileSize(m.size)} (${(m.size || 0).toLocaleString()} ${t('info.bytes')})`, 'info-size'),
          row(t('info.type'), m.contentType || '—', 'info-content-type'),
          row(t('info.modified'), m.lastModified ? formatDate(m.lastModified).title || new Date(m.lastModified).toLocaleString() : '—'),
          row(t('info.etag'), m.etag, 'info-etag'),
          row(t('info.storageClass'), m.storageClass),
          ...Object.entries(m.metadata || {}).map(([k, v]) => row(`x-amz-meta-${k}`, v)),
        );
      }
    } catch (e) {
      fill(h('p', { class: 'preview-error', testid: 'info-error' }, e.message));
    }
  })();
}
