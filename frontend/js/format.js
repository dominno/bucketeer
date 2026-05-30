// Display formatting helpers.

import { t, getLocale } from './i18n.js';

export function humanFileSize(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  const val = i === 0 ? n : n.toFixed(n < 10 ? 1 : 0);
  return `${val} ${units[i]}`;
}

export function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '';
  return `${humanFileSize(bytesPerSec)}/s`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function formatDate(iso) {
  if (!iso) return { text: '', title: '' };
  const d = new Date(iso);
  const loc = getLocale();
  const now = Date.now();
  const diff = (now - d.getTime()) / 1000;
  let text;
  if (diff < 60) text = t('date.justNow');
  else if (diff < 3600) text = t('date.minAgo', { n: Math.floor(diff / 60) });
  else if (diff < 86400) text = t('date.hAgo', { n: Math.floor(diff / 3600) });
  else if (diff < 2592000) text = t('date.dAgo', { n: Math.floor(diff / 86400) });
  else text = d.toLocaleDateString(loc, { year: 'numeric', month: 'short', day: 'numeric' });
  return { text, title: d.toLocaleString(loc) };
}

const EXT_KEY = {
  txt: 'text', md: 'markdown', csv: 'csv', json: 'json', xml: 'xml', html: 'html', htm: 'html', css: 'css',
  js: 'javascript', mjs: 'javascript', ts: 'typescript', pdf: 'pdf', zip: 'archive', gz: 'archive',
  tar: 'archive', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image',
  mp4: 'video', mov: 'video', webm: 'video', mp3: 'audio', wav: 'audio', flac: 'audio',
  doc: 'word', docx: 'word', xls: 'excel', xlsx: 'excel', ppt: 'powerpoint', pptx: 'powerpoint',
};

// Case-insensitive name match. Supports glob wildcards: `*` (any run) and `?`
// (one char). With a wildcard it's anchored (`*.fbx` → ends with .fbx); without,
// it's a substring match (`fbx` → contains fbx).
export function matchesQuery(name, query) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return true;
  const n = (name || '').toLowerCase();
  if (q.includes('*') || q.includes('?')) {
    const re = q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    try {
      return new RegExp(`^${re}$`).test(n);
    } catch {
      return n.includes(q);
    }
  }
  return n.includes(q);
}

export function extname(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function typeLabel(name) {
  const ext = extname(name);
  if (!ext) return t('type.file');
  const key = EXT_KEY[ext];
  return key ? t(`type.${key}`) : ext.toUpperCase();
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'csv', 'tsv', 'log', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sh', 'bash', 'zsh', 'py', 'rb', 'go',
  'rs', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'php', 'sql', 'gitignore', 'dockerfile',
]);

// 3D model formats we can render inline (self-contained ones). glb/embedded-gltf,
// STL, OBJ and PLY cover the common cases; FBX/STEP are intentionally excluded.
const MODEL_EXT = new Set(['glb', 'gltf', 'stl', 'obj', 'ply', 'fbx']);
// Formats browsers can typically play via <video>/<audio> elements.
const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'oga', 'ogg', 'flac', 'aac']);
// OOXML Office formats we can render inline (zip+xml). The legacy binary
// formats (doc/xls/ppt) are NOT supported — only the modern *x variants.
const OFFICE_EXT = new Set(['docx', 'xlsx', 'pptx']);

// Which inline preview to use for a file name, or null if not previewable.
// (svg resolves to image — rendered via <img>.)
export function previewKind(name) {
  const ext = extname(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (MODEL_EXT.has(ext)) return 'model';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (OFFICE_EXT.has(ext)) return 'office';
  if (TEXT_EXT.has(ext)) return 'text';
  return null;
}
