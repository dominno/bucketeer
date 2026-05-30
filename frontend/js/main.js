// Entry point: build the header search + profile pill, mount every component,
// wire hash routing, and load the initial profile/listing. Exposes window.__app
// on localhost so end-to-end tests can read state and await settle().
import { h, qs, mount, icon } from './dom.js';
import { store } from './store.js';
import { actions } from './actions.js';
import { parseHash, navigate, onRouteChange } from './router.js';
import { initLocale, t } from './i18n.js';
import { initTheme } from './theme.js';
import { pruneMultipartState } from './multipartUpload.js';
import { initToasts } from './ui/Toasts.js';
import { initSidebar } from './ui/Sidebar.js';
import { initBreadcrumbs } from './ui/Breadcrumbs.js';
import { initToolbar } from './ui/Toolbar.js';
import { initFileTable } from './ui/FileTable.js';
import { initUploadManager } from './ui/UploadManager.js';
import { initDownloadManager } from './ui/DownloadManager.js';
import { initTransferOverview } from './ui/TransferOverview.js';
import { initShortcuts } from './ui/Shortcuts.js';

function initSearch() {
  const wrap = qs('header-search');
  const input = h('input', {
    class: 'input',
    testid: 'search-input',
    type: 'search',
    placeholder: t('app.searchPlaceholder'),
    'aria-label': t('app.searchLabel'),
    onInput: (e) => store.setState({ search: e.target.value, recursive: null }),
  });
  mount(wrap, h('div', { class: 'search-box' }, icon('search', { size: 15 }), input));
  store.subscribe((st) => {
    if (document.activeElement !== input && input.value !== st.search) input.value = st.search;
    input.disabled = !st.location.bucket;
    input.placeholder = t('app.searchPlaceholder');
    input.setAttribute('aria-label', t('app.searchLabel'));
  });
  return input;
}

const UP_ACTIVE = ['checking', 'queued', 'uploading', 'retrying'];
function initTransferPill() {
  const el = qs('transfer-pill');
  store.subscribe(() => {
    const st = store.getState();
    const ups = st.uploads.filter((u) => UP_ACTIVE.includes(u.status)).length;
    const dls = st.downloads.filter((d) => d.status === 'queued' || d.status === 'downloading').length;
    const n = ups + dls;
    if (n === 0) {
      el.hidden = true;
      mount(el);
      return;
    }
    el.hidden = false;
    const label = `${n} active transfer${n > 1 ? 's' : ''}${ups ? ` · ${ups}↑` : ''}${dls ? ` · ${dls}↓` : ''}`;
    mount(
      el,
      h(
        'button',
        { class: 'pill pill-btn', testid: 'transfer-pill-badge', 'aria-live': 'polite', 'aria-label': label, title: label, onClick: () => store.setState({ transferExpanded: !store.getState().transferExpanded }) },
        icon('upload', { size: 13 }),
        `${n}`,
      ),
    );
  });
}

function initProfilePill() {
  const el = qs('active-profile-pill');
  store.subscribe(() => {
    const st = store.getState();
    const p = st.profiles.find((x) => x.id === st.activeProfileId);
    mount(
      el,
      p
        ? h('span', { class: 'pill', testid: 'profile-pill' }, h('span', { class: 'dot' }), p.name)
        : h('span', { class: 'pill none', testid: 'profile-pill' }, h('span', { class: 'dot' }), t('pill.noProfile')),
    );
  });
}

function boot() {
  initTheme(); // apply the saved Light/Dark/System choice before first paint
  pruneMultipartState(); // drop dead resumable-upload state from a prior session
  initLocale();
  initToasts();
  initProfilePill();
  initTransferPill();
  const searchInput = initSearch();
  initSidebar();
  initBreadcrumbs();
  initToolbar();
  initFileTable();
  initUploadManager();
  initDownloadManager();
  initTransferOverview();
  initShortcuts({ focusSearch: () => searchInput.focus() });

  onRouteChange(() => actions.onRoute());

  // Restore interrupted single-file downloads from a prior session as paused,
  // resumable rows (no gesture needed to list them; Resume re-acquires permission).
  actions.hydrateTransfers();

  (async () => {
    const profiles = await actions.loadProfiles();
    const { profileId } = parseHash();
    if (!profileId && profiles.length) navigate({ profileId: profiles[0].id });
    else await actions.onRoute();
    document.body.dataset.ready = 'true';
  })();

  if (['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) {
    window.__app = {
      store,
      actions,
      getState: () => store.getState(),
      async settle() {
        await store.settle();
        while (actions.uploadsPending()) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 40));
        }
        await store.settle();
      },
    };
  }
}

boot();
