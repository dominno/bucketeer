// Inline preview for modern Office (OOXML) files — docx / xlsx / pptx.
// Everything renders client-side from the object's bytes; nothing is written
// to disk and no bytes leave the machine.
//   • docx → mammoth.js converts to semantic HTML (headings, lists, tables,
//     inline images as data URIs). Content-faithful, not a pixel-perfect Word
//     layout.
//   • xlsx → SheetJS renders each worksheet to an HTML table with a tab bar.
//   • pptx → JSZip unzips the deck and we extract per-slide text runs (best
//     effort: text only, not shapes/positioning).
// Each vendored bundle is a classic UMD/standalone script, so we inject it via
// a <script> tag once and read the global it exposes (matching how these
// builds are intended to load — an ESM import() would not expose the global).
import { h, mount, clear } from '../dom.js';
import { t } from '../i18n.js';
import { extname } from '../format.js';

const SCRIPTS = {
  mammoth: { src: '/vendor/office/mammoth.browser.min.js', global: 'mammoth' },
  xlsx: { src: '/vendor/office/xlsx.full.min.js', global: 'XLSX' },
  jszip: { src: '/vendor/office/jszip.min.js', global: 'JSZip' },
};

const loaded = new Map(); // name → Promise<global>

// Inject a classic script once and resolve with the global it defines.
function loadLib(name) {
  if (loaded.has(name)) return loaded.get(name);
  const { src, global } = SCRIPTS[name];
  const p = new Promise((resolve, reject) => {
    if (window[global]) {
      resolve(window[global]);
      return;
    }
    const el = document.createElement('script');
    el.src = src;
    el.async = true;
    el.onload = () => (window[global] ? resolve(window[global]) : reject(new Error(`${global} missing`)));
    el.onerror = () => reject(new Error(`load ${src}`));
    document.head.appendChild(el);
  });
  loaded.set(name, p);
  return p;
}

async function renderDocx(container, buf) {
  const mammoth = await loadLib('mammoth');
  const { value, messages } = await mammoth.convertToHtml({ arrayBuffer: buf });
  const page = h('div', { class: 'office-doc office-docx', testid: 'office-docx' });
  page.innerHTML = value || `<p class="office-empty">${t('preview.empty')}</p>`;
  // Neutralize anything unexpected: mammoth emits no scripts, but be defensive.
  page.querySelectorAll('script').forEach((s) => s.remove());
  if (messages && messages.some((m) => m.type === 'error')) {
    // Surface conversion warnings quietly without blocking the render.
    // eslint-disable-next-line no-console
    console.warn('docx preview warnings', messages);
  }
  mount(container, page);
}

async function renderXlsx(container, buf) {
  const XLSX = await loadLib('xlsx');
  const wb = XLSX.read(buf, { type: 'array' });
  const names = wb.SheetNames || [];
  if (!names.length) {
    mount(container, h('div', { class: 'office-empty' }, t('preview.empty')));
    return;
  }
  const tableWrap = h('div', { class: 'office-sheet', testid: 'office-xlsx' });
  const renderSheet = (name) => {
    const ws = wb.Sheets[name];
    const html = XLSX.utils.sheet_to_html(ws, { editable: false });
    const holder = h('div', { class: 'office-sheet-table' });
    holder.innerHTML = html;
    holder.querySelectorAll('script').forEach((s) => s.remove());
    mount(tableWrap, holder);
  };
  let tabs = null;
  if (names.length > 1) {
    const btns = names.map((name, i) =>
      h(
        'button',
        {
          class: `office-tab${i === 0 ? ' is-active' : ''}`,
          testid: `office-tab-${i}`,
          onClick: (e) => {
            tabs.querySelectorAll('.office-tab').forEach((b) => b.classList.remove('is-active'));
            e.currentTarget.classList.add('is-active');
            renderSheet(name);
          },
        },
        name,
      ),
    );
    tabs = h('div', { class: 'office-tabs', testid: 'office-tabs' }, ...btns);
  }
  renderSheet(names[0]);
  mount(container, tabs, tableWrap);
}

// Slide files are ppt/slides/slideN.xml — order numerically, not lexically.
function slideOrder(path) {
  const m = path.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

async function renderPptx(container, buf) {
  const JSZip = await loadLib('jszip');
  const zip = await JSZip.loadAsync(buf);
  const paths = Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => slideOrder(a) - slideOrder(b));
  if (!paths.length) {
    mount(container, h('div', { class: 'office-empty' }, t('preview.empty')));
    return;
  }
  const parser = new DOMParser();
  const deck = h('div', { class: 'office-deck', testid: 'office-pptx' });
  // Sequential is fine: a slide XML is small and decks are rarely huge.
  for (let i = 0; i < paths.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const xml = await zip.files[paths[i]].async('string');
    const doc = parser.parseFromString(xml, 'application/xml');
    // <a:p> = paragraph, <a:t> = text run. Group runs by their paragraph so
    // line breaks survive.
    const paras = Array.from(doc.getElementsByTagName('a:p'));
    const lines = paras
      .map((p) =>
        Array.from(p.getElementsByTagName('a:t'))
          .map((node) => node.textContent || '')
          .join(''),
      )
      .filter((line) => line.trim().length);
    const card = h(
      'div',
      { class: 'office-slide', testid: `office-slide-${i}` },
      h('div', { class: 'office-slide-num' }, t('preview.slide', { n: i + 1 })),
      lines.length
        ? h('div', { class: 'office-slide-body' }, ...lines.map((line) => h('p', {}, line)))
        : h('div', { class: 'office-slide-empty' }, t('preview.slideEmpty')),
    );
    deck.appendChild(card);
  }
  mount(container, deck);
}

// Render an Office file into `container`. Throws on unsupported ext or a
// rendering failure (caller shows the error state). `signal` lets the caller
// bail if the user navigated away mid-parse.
export async function mountOffice(container, buf, name, { signal } = {}) {
  const ext = extname(name);
  clear(container);
  const run = { docx: renderDocx, xlsx: renderXlsx, pptx: renderPptx }[ext];
  if (!run) throw new Error(`unsupported office ext: ${ext}`);
  await run(container, buf);
  if (signal && signal.aborted) clear(container);
}
