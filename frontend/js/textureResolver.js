// Pure helpers for resolving a 3D model's EXTERNAL resource references (textures,
// and a glTF's .bin) to sibling objects in the same bucket folder. An FBX/OBJ/glTF
// stores textures by bare filename; three.js would otherwise resolve them against
// the page origin and 404. We build a basename->key map from the model's folder and
// rewrite each requested filename to that object's /view URL (done in ModelViewer).
//
// Kept dependency-free (no store/api/three) so it is unit-testable in node.

// Extensions we treat as model resources. Raster formats (png/jpg/…) decode in an
// <img>; tga needs a registered loader; dds/exr/psd aren't browser-decodable (they
// fall back to grey). `bin` covers a non-embedded glTF's binary buffer.
export const RESOURCE_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg',
  'tga', 'tif', 'tiff', 'dds', 'exr', 'psd', 'ktx2', 'hdr',
  'bin',
]);

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

// basename of a path using BOTH separators (FBX often stores Windows paths).
export function baseName(path) {
  const norm = String(path).replace(/\\/g, '/');
  return norm.slice(norm.lastIndexOf('/') + 1);
}

export function isResourceName(name) {
  return RESOURCE_EXT.has(extOf(String(name)));
}

// files: [{ name?, key }] (name is the folder-relative basename; key is the full
// bucket key). Returns Map<lowercased-basename, bucketKey> of resource files only.
// Same-folder S3 keys are unique, so basenames don't collide within one folder.
export function buildResourceMap(files) {
  const map = new Map();
  for (const f of files || []) {
    if (!f || !f.key) continue;
    const base = baseName(f.name || f.key).toLowerCase();
    if (base && isResourceName(base)) map.set(base, f.key);
  }
  return map;
}

// Given a URL three.js asked a loader to fetch, return the matching bucket key, or
// null to leave it unchanged. Embedded/absolute URLs (blob:/data:/http(s)/protocol-
// relative) are passed through UNTOUCHED — this is what keeps embedded-texture FBX
// and self-contained GLB byte-for-byte identical. Matching is by lowercased basename.
export function matchResourceKey(requested, map) {
  if (!requested || !map || map.size === 0) return null;
  const lc = String(requested).trim().toLowerCase();
  if (
    lc.startsWith('blob:') ||
    lc.startsWith('data:') ||
    lc.startsWith('http:') ||
    lc.startsWith('https:') ||
    lc.startsWith('//')
  ) {
    return null; // already absolute / embedded — never rewrite
  }
  const noQuery = String(requested).split(/[?#]/)[0];
  const base = baseName(noQuery).toLowerCase();
  return map.get(base) || null;
}
