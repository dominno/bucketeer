// Hash routing: #/p/<profileId>/b/<bucket>/<seg>/<seg>/...
// Each prefix segment is encodeURIComponent'd so keys with '/', '#', '?', spaces
// or unicode survive a round-trip. Prefix always ends with '/' (or is '').

export function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const tokens = raw.split('/').filter(Boolean).map(decodeURIComponent);
  let profileId = null;
  let bucket = null;
  let prefixSegs = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === 'p' && i + 1 < tokens.length) {
      profileId = tokens[i + 1];
      i += 2;
    } else if (tokens[i] === 'b' && i + 1 < tokens.length) {
      bucket = tokens[i + 1];
      i += 2;
    } else {
      prefixSegs = tokens.slice(i);
      break;
    }
  }
  const prefix = prefixSegs.length ? `${prefixSegs.join('/')}/` : '';
  return { profileId, bucket, prefix };
}

export function serialize({ profileId, bucket, prefix }) {
  const parts = [];
  if (profileId) parts.push('p', encodeURIComponent(profileId));
  if (bucket) parts.push('b', encodeURIComponent(bucket));
  if (prefix) {
    for (const seg of prefix.split('/').filter(Boolean)) parts.push(encodeURIComponent(seg));
  }
  return `#/${parts.join('/')}`;
}

export function navigate(loc) {
  const next = serialize(loc);
  if (window.location.hash === next) {
    // Same hash → no hashchange event; trigger listeners manually.
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = next;
  }
}

export function onRouteChange(handler) {
  window.addEventListener('hashchange', handler);
}
