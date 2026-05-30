// Sidebar: credential profile switcher + bucket list for the active profile.
import { h, qs, mount, icon } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';
import { t, LOCALES, getLocale, setLocale } from '../i18n.js';
import { getTheme, setTheme, THEMES } from '../theme.js';
import { openProfileModal } from './ProfileModal.js';

export function initSidebar() {
  const root = qs('sidebar');

  function renderProfiles(st) {
    const select = h(
      'select',
      {
        class: 'profile-select',
        testid: 'profile-switcher',
        'aria-label': t('sidebar.profile'),
        onChange: (e) => actions.selectProfile(e.target.value),
      },
      ...(st.profiles.length
        ? st.profiles.map((p) => h('option', { value: p.id, selected: p.id === st.activeProfileId }, p.name))
        : [h('option', { value: '' }, t('sidebar.noProfiles'))]),
    );
    return h(
      'div',
      { class: 'sidebar-section' },
      h(
        'p',
        { class: 'sidebar-label' },
        t('sidebar.profile'),
        h('button', { class: 'btn btn-ghost btn-icon', testid: 'manage-profiles-btn', title: t('sidebar.manageProfiles'), 'aria-label': t('sidebar.manageProfiles'), onClick: () => openProfileModal() }, icon('gear', { size: 15 })),
      ),
      st.profiles.length
        ? h('div', { class: 'profile-row' }, select)
        : h('button', { class: 'btn btn-primary', testid: 'add-profile-cta', onClick: () => openProfileModal({ mode: 'add' }) }, icon('plus', { size: 15 }), t('sidebar.addProfile')),
    );
  }

  function renderFooter() {
    const langSelect = h(
      'select',
      { class: 'lang-select', testid: 'language-select', 'aria-label': t('sidebar.language'), onChange: (e) => setLocale(e.target.value) },
      ...Object.entries(LOCALES).map(([code, label]) => h('option', { value: code, selected: code === getLocale() }, label)),
    );
    const themeSelect = h(
      'select',
      { class: 'lang-select', testid: 'theme-select', 'aria-label': t('sidebar.theme'), onChange: (e) => setTheme(e.target.value) },
      ...THEMES.map((th) => h('option', { value: th, selected: th === getTheme() }, t(`theme.${th}`))),
    );
    return h(
      'div',
      { class: 'sidebar-footer' },
      h('div', { class: 'lang-row' }, icon('database', { size: 13, cls: 'lang-globe' }), langSelect),
      h('div', { class: 'lang-row' }, icon('eye', { size: 13, cls: 'lang-globe' }), themeSelect),
      h('div', { class: 'footer-note' }, t('sidebar.footer')),
    );
  }

  function renderBuckets(st) {
    const wrap = h('div', { class: 'bucket-list', testid: 'bucket-list' });
    if (!st.activeProfileId) {
      wrap.appendChild(h('p', { class: 'sidebar-empty' }, t('sidebar.selectProfileHint')));
      return wrap;
    }
    if (st.bucketsStatus === 'loading') {
      wrap.appendChild(h('p', { class: 'sidebar-empty', testid: 'buckets-loading' }, t('sidebar.loadingBuckets')));
      return wrap;
    }
    if (st.bucketsStatus === 'error') {
      wrap.appendChild(h('p', { class: 'sidebar-empty', testid: 'buckets-error' }, st.bucketsError || t('sidebar.bucketsError')));
      return wrap;
    }
    if (!st.buckets.length) {
      wrap.appendChild(h('p', { class: 'sidebar-empty', testid: 'buckets-empty' }, t('sidebar.noBuckets')));
      return wrap;
    }
    for (const b of st.buckets) {
      const active = st.location.bucket === b.name;
      wrap.appendChild(
        h(
          'button',
          { class: 'bucket-item', testid: `bucket-item-${b.name}`, 'aria-current': active ? 'true' : 'false', onClick: () => actions.selectBucket(b.name) },
          icon('database', { size: 16 }),
          h('span', {}, b.name),
        ),
      );
    }
    return wrap;
  }

  function render() {
    const st = store.getState();
    mount(
      root,
      renderProfiles(st),
      h('p', { class: 'sidebar-label', style: 'padding:4px 14px 0' }, t('sidebar.buckets')),
      renderBuckets(st),
      renderFooter(),
    );
  }

  store.subscribe(render);
  render();
}
