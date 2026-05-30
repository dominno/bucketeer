// Material rescue for previewed 3D models. Extracted from ModelViewer so the
// (browser-free) decision logic can be unit-tested without three.js — `THREE` is
// injected, the function never imports it.
//
// DoubleSide + grey rescue for meshes whose material is untextured/near-black.
// `dropDeadMaps` (run AFTER texture loads settle) drops a map that never got a
// usable image (404 / unsupported format) so the mesh falls back to grey instead
// of sampling a blank texture as solid black. It must NOT run synchronously right
// after parse, when valid external textures haven't loaded yet.
export function fixMaterials(THREE, object, dropDeadMaps) {
  object.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) {
      if (!m) continue;
      m.side = THREE.DoubleSide;
      if (dropDeadMaps && m.map) {
        const img = m.map.image;
        const ready = img && (img.width > 0 || img.height > 0 || (img.data && img.data.length));
        if (!ready) {
          if (m.map.dispose) m.map.dispose();
          m.map = null;
        }
      }
      const noTex = !m.map;
      const col = m.color;
      if (noTex && col && col.r + col.g + col.b < 0.12) col.setHex(0x9aa7b4);
      if (m.metalness !== undefined && noTex && m.metalness > 0.9) m.metalness = 0.4; // pure-metal + no env detail looks dead
      m.needsUpdate = true;
    }
  });
}
