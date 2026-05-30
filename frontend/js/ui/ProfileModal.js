// Credential profile manager: list existing profiles (redacted), add a new one
// (with paste-the-.txt autofill), edit, or delete. Secrets are never shown — the
// secret field is blank when editing and left empty means "keep current".
import { h, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { actions } from '../actions.js';
import { t } from '../i18n.js';
import { humanFileSize } from '../format.js';
import { cacheStats, cacheClear } from '../previewCache.js';
import { toast } from './Toasts.js';
import { openModal } from './modalbase.js';

export function openProfileModal() {
  let editingId = null;

  const field = (testid, label, attrs = {}) => {
    const input = h('input', { class: 'input', testid, type: 'text', autocomplete: 'off', spellcheck: 'false', ...attrs });
    return { input, node: h('div', {}, h('label', { class: 'field-label' }, label), input) };
  };

  const nameF = field('profile-form-name', t('profile.displayName'));
  const endpointF = field('profile-form-endpoint', t('profile.endpoint'), { placeholder: 'm2o3.fra.idrivee2-58.com' });
  const regionF = field('profile-form-region', t('profile.region'), { placeholder: 'eu-central-2' });
  const keyF = field('profile-form-accessKeyId', t('profile.accessKeyId'));
  const secretF = field('profile-form-secret', t('profile.secret'), { type: 'password', placeholder: '••••••••' });

  const paste = h('textarea', {
    class: 'input',
    testid: 'profile-paste',
    placeholder: t('profile.pastePlaceholder'),
    rows: '4',
  });
  const errEl = h('p', { class: 'field-error', testid: 'profile-error' });
  const formTitle = h('h3', { testid: 'profile-form-title', style: 'margin:6px 0 2px; font-size:13px' }, t('profile.addHeading'));
  const listWrap = h('div', { class: 'profile-mgr-list', testid: 'profile-mgr-list' });
  const saveBtn = h('button', { class: 'btn btn-primary', testid: 'profile-save-btn' }, t('profile.add'));

  function setForm({ name = '', endpoint = '', region = '', accessKeyId = '', secret = '' } = {}) {
    nameF.input.value = name;
    endpointF.input.value = endpoint;
    regionF.input.value = region;
    keyF.input.value = accessKeyId;
    secretF.input.value = secret;
    errEl.textContent = '';
  }

  function startAdd() {
    editingId = null;
    setForm();
    secretF.input.placeholder = '••••••••';
    formTitle.textContent = t('profile.addHeading');
    saveBtn.textContent = t('profile.add');
  }

  function startEdit(p) {
    editingId = p.id;
    setForm({ name: p.name, endpoint: p.endpoint, region: p.region, accessKeyId: p.accessKeyId });
    secretF.input.placeholder = t('profile.secretKeep');
    formTitle.textContent = t('profile.editHeading', { name: p.name });
    saveBtn.textContent = t('profile.saveChanges');
    nameF.input.focus();
  }

  function rebuildList() {
    const profiles = store.getState().profiles;
    if (!profiles.length) {
      mount(listWrap, h('p', { class: 'field-hint' }, t('profile.none')));
      return;
    }
    mount(
      listWrap,
      ...profiles.map((p) =>
        h(
          'div',
          { class: 'profile-mgr-item', testid: `profile-mgr-item-${p.id}` },
          icon('database', { size: 16 }),
          h(
            'div',
            { style: 'min-width:0' },
            h('div', { class: 'pm-name' }, p.name),
            h('div', { class: 'pm-sub' }, `${p.region} · ${p.accessKeyId}`),
          ),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn btn-ghost btn-icon', testid: `profile-edit-${p.id}`, title: t('action.rename'), 'aria-label': t('profile.edit', { name: p.name }), onClick: () => startEdit(p) }, icon('rename', { size: 15 })),
          h('button', { class: 'btn btn-ghost btn-icon', testid: `profile-delete-${p.id}`, title: t('action.delete'), 'aria-label': t('profile.deleteAria', { name: p.name }), onClick: async () => { const removed = await actions.deleteProfileFlow(p.id); if (removed) { if (editingId === p.id) startAdd(); rebuildList(); paste.focus(); } } }, icon('trash', { size: 15 })),
        ),
      ),
    );
  }

  async function onParse() {
    errEl.textContent = '';
    try {
      const parsed = await api.parseProfile(paste.value);
      setForm({ name: parsed.name, endpoint: parsed.endpoint, region: parsed.region, accessKeyId: parsed.accessKeyId, secret: parsed.secretAccessKey });
      toast({ kind: 'success', message: t('profile.parsed') });
    } catch (e) {
      errEl.textContent = e.message;
    }
  }

  async function onSave(close) {
    errEl.textContent = '';
    const data = {
      name: nameF.input.value.trim(),
      endpoint: endpointF.input.value.trim(),
      region: regionF.input.value.trim(),
      accessKeyId: keyF.input.value.trim(),
      secretAccessKey: secretF.input.value,
    };
    if (!data.endpoint || !data.region || !data.accessKeyId) {
      errEl.textContent = t('profile.reqFields');
      return;
    }
    if (!editingId && !data.secretAccessKey) {
      errEl.textContent = t('profile.reqSecret');
      return;
    }
    saveBtn.disabled = true;
    try {
      await actions.saveProfile({ mode: editingId ? 'edit' : 'add', id: editingId, data });
      if (editingId) {
        startAdd();
        rebuildList();
      } else {
        close();
      }
    } catch (e) {
      errEl.textContent = e.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  openModal({
    testid: 'profile-modal',
    initialFocus: '[data-testid="profile-paste"]',
    render: (close) => {
      saveBtn.addEventListener('click', () => onSave(close));
      rebuildList();
      startAdd();

      // Storage / cache section.
      const cacheSizeEl = h('div', { class: 'pm-sub', testid: 'settings-cache-size' });
      const refreshCacheSize = () => {
        const { bytes, count } = cacheStats();
        cacheSizeEl.textContent = count ? `${humanFileSize(bytes)} · ${count} ${count === 1 ? 'file' : 'files'}` : t('settings.cacheEmpty');
      };
      refreshCacheSize();
      const storage = h(
        'div',
        {},
        h('div', { class: 'divider' }),
        h('h3', { style: 'margin:6px 0 6px; font-size:13px' }, t('settings.storage')),
        h(
          'div',
          { class: 'profile-mgr-item' },
          icon('database', { size: 16 }),
          h('div', { style: 'min-width:0' }, h('div', { class: 'pm-name' }, t('settings.previewCache')), cacheSizeEl),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', testid: 'settings-clear-cache', onClick: () => { cacheClear(); refreshCacheSize(); toast({ kind: 'success', message: t('settings.cacheCleared') }); } }, t('settings.clearCache')),
        ),
        h('p', { class: 'field-hint' }, t('settings.cacheNote')),
      );

      // Security section: at-rest encryption status + the append-only audit log.
      const encEl = h('div', { class: 'pm-sub', testid: 'settings-encryption' }, '…');
      const auditEl = h('div', { class: 'pm-sub', testid: 'settings-audit-stat' }, '…');
      const loadSecurity = async () => {
        try {
          const s = await api.security();
          encEl.textContent = s.encryption === 'keychain' ? t('settings.encKeychain') : t('settings.encLocalKey');
          const n = s.audit ? s.audit.entries : 0;
          auditEl.textContent = n ? t('settings.auditStat', { n, size: humanFileSize(s.audit.bytes) }) : t('settings.auditEmpty');
        } catch {
          encEl.textContent = t('settings.encUnknown');
        }
      };
      loadSecurity();
      const security = h(
        'div',
        {},
        h('div', { class: 'divider' }),
        h('h3', { style: 'margin:6px 0 6px; font-size:13px' }, t('settings.security')),
        h(
          'div',
          { class: 'profile-mgr-item' },
          icon('gear', { size: 16 }),
          h('div', { style: 'min-width:0' }, h('div', { class: 'pm-name' }, t('settings.keyStorage')), encEl),
        ),
        h(
          'div',
          { class: 'profile-mgr-item' },
          icon('file', { size: 16 }),
          h('div', { style: 'min-width:0' }, h('div', { class: 'pm-name' }, t('settings.auditLog')), auditEl),
          h('div', { class: 'spacer' }),
          h('a', { class: 'btn', href: '/api/security/audit/export', download: 'bucketeer-audit.log', testid: 'settings-audit-export' }, t('settings.export')),
          h('button', { class: 'btn', testid: 'settings-audit-clear', onClick: async () => { try { await api.clearAudit(); loadSecurity(); toast({ kind: 'success', message: t('settings.auditCleared') }); } catch (e) { toast({ kind: 'error', message: e.message }); } } }, t('settings.clearLog')),
        ),
        h('p', { class: 'field-hint' }, t('settings.securityNote')),
        h(
          'div',
          { class: 'profile-mgr-item' },
          icon('refresh', { size: 16 }),
          h('div', { style: 'min-width:0' }, h('div', { class: 'pm-name' }, t('settings.incompleteUploads')), h('div', { class: 'pm-sub' }, t('settings.incompleteHint'))),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', testid: 'settings-cleanup-uploads', onClick: cleanupUploads }, t('settings.cleanup')),
        ),
      );

      async function cleanupUploads(ev) {
        const btn = ev.currentTarget;
        if (!store.getState().location.bucket) {
          toast({ kind: 'info', message: t('settings.cleanupNoBucket') });
          return;
        }
        btn.disabled = true;
        try {
          const n = await actions.cleanupIncompleteUploads();
          toast({ kind: 'success', message: t('settings.cleanupDone', { n }) });
        } catch (e) {
          toast({ kind: 'error', message: e.message });
        } finally {
          btn.disabled = false;
        }
      }

      return [
        h('div', { class: 'modal-head' }, h('h2', {}, t('settings.title'))),
        h(
          'div',
          { class: 'modal-body' },
          h('h3', { style: 'margin:0 0 6px; font-size:13px' }, t('settings.connections')),
          listWrap,
          h('div', { class: 'divider' }),
          formTitle,
          h('div', { style: 'display:flex; gap:6px; align-items:flex-start' }, h('div', { style: 'flex:1' }, paste), h('button', { class: 'btn', testid: 'profile-parse-btn', onClick: onParse }, t('profile.parse'))),
          nameF.node,
          endpointF.node,
          h('div', { style: 'display:flex; gap:10px' }, h('div', { style: 'flex:1' }, regionF.node), h('div', { style: 'flex:1' }, keyF.node)),
          secretF.node,
          errEl,
          storage,
          security,
        ),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', testid: 'profile-close-btn', onClick: close }, t('profile.close')), saveBtn),
      ];
    },
  });
}
