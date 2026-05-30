// Thin REST client. Reads the active profile id from the store and sends it as
// X-Profile-Id. Throws an Error carrying { code, status } from the server's
// error envelope so callers can show clean messages.
import { store } from './store.js';
import { lookup as mimeLookup } from './mime.js';

const activeProfileId = () => store.getState().activeProfileId;

async function request(path, { method = 'GET', body, profileless = false } = {}) {
  store.beginRequest();
  try {
    const headers = {};
    let payload = body;
    if (body != null && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    if (!profileless) {
      const pid = activeProfileId();
      if (pid) headers['X-Profile-Id'] = pid;
    }
    const res = await fetch(path, { method, headers, body: payload });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || res.statusText || 'Request failed');
      err.code = data?.error?.code;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    store.endRequest();
  }
}

const enc = encodeURIComponent;

export const api = {
  // Profiles (no active-profile header needed).
  listProfiles: () => request('/api/profiles', { profileless: true }),
  parseProfile: (text) => request('/api/profiles/parse', { method: 'POST', body: { text }, profileless: true }),
  addProfile: (p) => request('/api/profiles', { method: 'POST', body: p, profileless: true }),
  updateProfile: (id, p) => request(`/api/profiles/${enc(id)}`, { method: 'PUT', body: p, profileless: true }),
  deleteProfile: (id) => request(`/api/profiles/${enc(id)}`, { method: 'DELETE', profileless: true }),
  testProfile: (id) => request(`/api/profiles/${enc(id)}/test`, { method: 'POST', profileless: true }),

  // Security: at-rest encryption status + append-only audit log.
  security: () => request('/api/security', { profileless: true }),
  auditLog: (limit = 500) => request(`/api/security/audit?limit=${limit}`, { profileless: true }),
  clearAudit: () => request('/api/security/audit', { method: 'DELETE', profileless: true }),

  // Buckets / objects (active profile via header).
  listBuckets: () => request('/api/buckets'),
  listObjects: (bucket, prefix = '', token) =>
    request(`/api/objects?bucket=${enc(bucket)}&prefix=${enc(prefix)}${token ? `&continuationToken=${enc(token)}` : ''}`),
  search: (bucket, prefix, q, token) =>
    request(`/api/search?bucket=${enc(bucket)}&prefix=${enc(prefix)}&q=${enc(q)}${token ? `&continuationToken=${enc(token)}` : ''}`),
  listTree: (bucket, prefix) => request(`/api/list-tree?bucket=${enc(bucket)}&prefix=${enc(prefix)}`),

  // Streaming recursive listing (NDJSON). Calls onBatch(entries[]) as objects
  // arrive so the caller can show a live count, aborts mid-stream via `signal`,
  // and resolves { truncated } at the end. Used by the folder-to-disk scan.
  async listTreeStream(bucket, prefix, signal, onBatch) {
    const headers = {};
    const pid = activeProfileId();
    if (pid) headers['X-Profile-Id'] = pid;
    const res = await fetch(`/api/list-tree-stream?bucket=${enc(bucket)}&prefix=${enc(prefix)}`, { headers, signal });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw Object.assign(new Error(data?.error?.message || `Listing failed (${res.status})`), { code: data?.error?.code, status: res.status });
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let truncated = false;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      const batch = [];
      // Parse only whole lines; a partial line stays buffered for the next chunk.
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // ignore a malformed line rather than abort the whole scan
        }
        if (obj.done) truncated = !!obj.truncated;
        else batch.push(obj);
      }
      if (batch.length && onBatch) onBatch(batch);
    }
    return { truncated };
  },
  headObject: (bucket, key) => request(`/api/object/meta?bucket=${enc(bucket)}&key=${enc(key)}`),
  createFolder: (bucket, prefix, name) => request('/api/folder', { method: 'POST', body: { bucket, prefix, name } }),
  rename: (bucket, sourceKey, destKey, overwrite = false) =>
    request('/api/rename', { method: 'POST', body: { bucket, sourceKey, destKey, overwrite } }),
  move: (bucket, sourceKey, destPrefix, overwrite = false) =>
    request('/api/move', { method: 'POST', body: { bucket, sourceKey, destPrefix, overwrite } }),
  deleteKeys: (bucket, keys) => request('/api/delete', { method: 'POST', body: { bucket, keys } }),
  presign: (bucket, key, expires = 600) =>
    request(`/api/transfer/presign?profile=${enc(activeProfileId())}&bucket=${enc(bucket)}&key=${enc(key)}&expires=${expires}`, {
      profileless: true,
    }),

  // Download URL for an <a download> / navigation (cannot set headers).
  downloadUrl: (bucket, key) =>
    `/api/transfer/download?profile=${enc(activeProfileId())}&bucket=${enc(bucket)}&key=${enc(key)}`,

  // Inline URL for previews (<img>/<iframe> src, or fetch().text() for text).
  viewUrl: (bucket, key) =>
    `/api/transfer/view?profile=${enc(activeProfileId())}&bucket=${enc(bucket)}&key=${enc(key)}`,

  // URL that streams a folder (prefix) as a structure-preserving .zip.
  downloadFolderUrl: (bucket, prefix) =>
    `/api/transfer/download-folder?profile=${enc(activeProfileId())}&bucket=${enc(bucket)}&prefix=${enc(prefix)}`,

  // fetch() variants for the managed download manager (so it can read
  // response.body for byte-progress and stream to disk). `signal` enables cancel.
  // opts.rangeStart resumes from a byte offset (-> 206); opts.ifMatch guards that
  // the object hasn't changed since the partial was written (-> 412 if it has).
  fetchDownload: (bucket, key, signal, opts = {}) => {
    const headers = {};
    if (opts.rangeStart != null && opts.rangeStart > 0) headers.Range = `bytes=${opts.rangeStart}-`;
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    return fetch(api.downloadUrl(bucket, key), { signal, headers });
  },
  fetchFolderZip: (bucket, prefix, signal) => fetch(api.downloadFolderUrl(bucket, prefix), { signal }),
  fetchZipSelection: (bucket, keys, signal, archiveName) =>
    fetch('/api/transfer/zip-selection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Profile-Id': activeProfileId() },
      body: JSON.stringify({ bucket, keys, archiveName }),
      signal,
    }),

  // Streaming upload with progress. Returns { promise, abort }.
  uploadFile(bucket, prefix, file, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('bucket', bucket);
      fd.append('prefix', prefix);
      fd.append('file', file, file.name);
      xhr.open('POST', '/api/transfer/upload');
      const pid = activeProfileId();
      if (pid) xhr.setRequestHeader('X-Profile-Id', pid);
      const ct = file.type || mimeLookup(file.name);
      if (ct) xhr.setRequestHeader('X-Content-Type', ct);
      xhr.upload.onprogress = (e) => {
        if (onProgress) onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data);
        } else {
          const err = new Error(data?.error?.message || `Upload failed (${xhr.status})`);
          err.code = data?.error?.code;
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(Object.assign(new Error('Network error during upload'), { code: 'NETWORK' }));
      xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled'), { code: 'ABORTED' }));
      xhr.send(fd);
    });
    return { promise, abort: () => xhr.abort() };
  },

  // ---- Resumable multipart upload (client-orchestrated) --------------------
  mpCreate: (bucket, key, contentType) => request('/api/transfer/multipart/create', { method: 'POST', body: { bucket, key, contentType } }),
  mpComplete: (bucket, key, uploadId, parts) => request('/api/transfer/multipart/complete', { method: 'POST', body: { bucket, key, uploadId, parts } }),
  mpAbort: (bucket, key, uploadId) => request('/api/transfer/multipart/abort', { method: 'POST', body: { bucket, key, uploadId } }),
  mpListParts: (bucket, key, uploadId) => request(`/api/transfer/multipart/parts?bucket=${enc(bucket)}&key=${enc(key)}&uploadId=${enc(uploadId)}`),
  mpListUploads: (bucket, prefix = '') => request(`/api/transfer/multipart/list?bucket=${enc(bucket)}${prefix ? `&prefix=${enc(prefix)}` : ''}`),

  // Upload ONE part (raw blob body) with progress + abort. Returns { promise, abort }.
  uploadPart(bucket, key, uploadId, partNumber, blob, onProgress) {
    const xhr = new XMLHttpRequest();
    const promise = new Promise((resolve, reject) => {
      xhr.open('PUT', `/api/transfer/multipart/part?bucket=${enc(bucket)}&key=${enc(key)}&uploadId=${enc(uploadId)}&partNumber=${partNumber}`);
      const pid = activeProfileId();
      if (pid) xhr.setRequestHeader('X-Profile-Id', pid);
      xhr.upload.onprogress = (e) => { if (onProgress) onProgress(e.loaded); };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* non-JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const err = new Error(data?.error?.message || `Part upload failed (${xhr.status})`);
          err.code = data?.error?.code;
          err.status = xhr.status;
          reject(err);
        }
      };
      xhr.onerror = () => reject(Object.assign(new Error('Network error during part upload'), { code: 'NETWORK' }));
      xhr.onabort = () => reject(Object.assign(new Error('Part cancelled'), { code: 'ABORTED' }));
      xhr.send(blob);
    });
    return { promise, abort: () => xhr.abort() };
  },
};
