// Path breadcrumbs for the current bucket + prefix. Each crumb navigates to its
// ancestor prefix.
import { h, qs, mount } from '../dom.js';
import { store } from '../store.js';
import { actions } from '../actions.js';

export function initBreadcrumbs() {
  const root = qs('breadcrumbs');
  function render() {
    const { location } = store.getState();
    if (!location.bucket) {
      mount(root);
      return;
    }
    const segs = location.prefix.split('/').filter(Boolean);
    const crumbs = [
      h('button', { class: `crumb ${segs.length === 0 ? 'current' : ''}`, testid: 'crumb-root', onClick: () => actions.openPrefix('') }, location.bucket),
    ];
    let acc = '';
    segs.forEach((seg, i) => {
      acc += `${seg}/`;
      const prefix = acc;
      const isLast = i === segs.length - 1;
      crumbs.push(h('span', { class: 'crumb-sep' }, '/'));
      crumbs.push(
        h(
          'button',
          {
            class: `crumb ${isLast ? 'current' : ''}`,
            testid: `crumb-${i}`,
            onClick: isLast ? undefined : () => actions.openPrefix(prefix),
          },
          seg,
        ),
      );
    });
    mount(root, ...crumbs);
  }
  store.subscribe(render);
  render();
}
