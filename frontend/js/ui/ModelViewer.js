// In-app 3D model preview. Loads three.js + the right loader on demand (only
// when a model is actually previewed), streams the model bytes from the inline
// /view endpoint, frames it, and renders with orbit controls + auto-rotate.
// Returns a disposer that fully tears down the WebGL context (no leaks).
//
// FBX/OBJ/glTF reference their textures as separate files; when previewing from a
// bucket those live as sibling objects. We give the loader a LoadingManager whose
// urlModifier rewrites each requested filename to that sibling's /view URL, so the
// textures stream from S3 instead of 404ing against the page origin.
import { store } from '../store.js';
import { api } from '../api.js';
import { buildResourceMap, matchResourceKey } from '../textureResolver.js';
import { fixMaterials } from '../materialFix.js';

// Scan the model's immediate folder for sibling resource files (textures, .bin).
// Fast path: reuse the already-loaded folder listing (zero network). Fallback: a
// bounded, delimiter-scoped listObjects paging loop (never a subtree walk). Any
// failure degrades to an empty map -> the model renders grey, never crashes.
async function scanSiblings(bucket, key) {
  const slash = key.lastIndexOf('/');
  const prefix = slash === -1 ? '' : key.slice(0, slash + 1);
  const st = store.getState();
  if (st.location.bucket === bucket && st.listing.prefix === prefix && st.listing.status === 'loaded' && !st.listing.isTruncated) {
    return buildResourceMap(st.listing.files);
  }
  const files = [];
  let token;
  let pages = 0;
  try {
    do {
      // eslint-disable-next-line no-await-in-loop
      const res = await api.listObjects(bucket, prefix, token);
      if (res && res.files) files.push(...res.files);
      token = res && res.nextContinuationToken;
      pages += 1;
    } while (token && pages < 5 && files.length < 2000);
  } catch {
    return new Map();
  }
  return buildResourceMap(files);
}

async function loadGeometryOrObject(THREE, ext, buf, manager) {
  if (ext === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    const geo = new STLLoader().parse(buf);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa7b4, metalness: 0.1, roughness: 0.75 }));
  }
  if (ext === 'ply') {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
    const geo = new PLYLoader().parse(buf);
    geo.computeVertexNormals();
    const hasColor = !!geo.getAttribute('color');
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: hasColor ? 0xffffff : 0x9aa7b4, vertexColors: hasColor, metalness: 0.1, roughness: 0.75 }));
  }
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    return new OBJLoader(manager || undefined).parse(new TextDecoder().decode(buf));
  }
  if (ext === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    // parse(buf, '') leaves the texture path empty so the urlModifier receives the
    // bare filename; external textures resolve via the manager, embedded ones (blob:)
    // are passed through untouched.
    return new FBXLoader(manager || undefined).parse(buf, '');
  }
  // glb (binary, self-contained) or gltf. glb gets the DEFAULT manager (no modifier)
  // so the self-contained path is provably untouched; gltf gets the resolver.
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader(ext === 'gltf' ? manager || undefined : undefined);
  const data = ext === 'gltf' ? new TextDecoder().decode(buf) : buf;
  const gltf = await new Promise((resolve, reject) => loader.parse(data, '', resolve, reject));
  return gltf.scene;
}

// Renders a model from an already-fetched ArrayBuffer (the caller handles
// download progress + caching). opts: { bucket, key } enable external-texture
// resolution from sibling bucket objects. Returns a disposer.
export async function mountModel(container, buf, ext, opts = {}) {
  const { bucket = null, key = '' } = opts;
  const THREE = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');

  // Build the external-resource resolver for formats that reference sibling files.
  // (glb/stl/ply are self-contained, so they never get a custom manager.) We
  // attach a LoadingManager for fbx/obj/gltf EVEN WHEN the folder has no sibling
  // textures, so the post-load dead-map sweep below still runs — a model whose
  // textures are missing then falls back to grey instead of sampling a
  // never-loaded (solid black) map.
  let manager = null;
  if (bucket && key && (ext === 'fbx' || ext === 'obj' || ext === 'gltf')) {
    const resourceMap = await scanSiblings(bucket, key);
    manager = new THREE.LoadingManager();
    if (resourceMap.size) {
      manager.setURLModifier((url) => {
        const matched = matchResourceKey(url, resourceMap);
        return matched ? api.viewUrl(bucket, matched) : url;
      });
    }
  }

  // Attach onLoad BEFORE parsing so we never miss the completion event: texture
  // 404s still count as "done", so onLoad fires even when every map fails to load.
  let object = null;
  let texturesSettled = false;
  if (manager) {
    manager.onLoad = () => {
      texturesSettled = true;
      if (object) fixMaterials(THREE, object, true);
    };
  }

  object = await loadGeometryOrObject(THREE, ext, buf, manager);

  const width = container.clientWidth || 800;
  const height = container.clientHeight || 500;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Image-based lighting so PBR/metallic materials aren't rendered black — this
  // is the main reason models otherwise look like dark silhouettes.
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xffffff, 0x666b73, 1.1));
  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
  keyLight.position.set(1, 1.3, 1.2);
  scene.add(keyLight);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-1, -0.3, -1);
  scene.add(fill);

  // Immediate pass: double-side every face + grey any mesh that has NO texture at
  // all (color-only models). Do NOT drop maps here — external textures are still
  // loading asynchronously and their .image isn't populated yet.
  fixMaterials(THREE, object, false);
  // Drop any map that never got a usable image (404 / unsupported format) so those
  // meshes go grey, not black. If the manager already finished during parse (all
  // textures — or all 404s — settled), run the sweep now; otherwise onLoad will.
  if (texturesSettled) fixMaterials(THREE, object, true);

  // Center + frame the model.
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const center = box.getCenter(new THREE.Vector3());
  object.position.sub(center);
  scene.add(object);

  const camera = new THREE.PerspectiveCamera(50, width / height, size / 1000, size * 100);
  camera.position.set(size * 0.6, size * 0.45, size * 1.1);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.4;
  controls.target.set(0, 0, 0);
  controls.update();

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  };
  animate();

  const onResize = () => {
    const w = container.clientWidth || width;
    const h = container.clientHeight || height;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  const ro = new ResizeObserver(onResize);
  ro.observe(container);

  return function dispose() {
    cancelAnimationFrame(raf);
    ro.disconnect();
    controls.dispose();
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (!o.material) return;
      [].concat(o.material).forEach((m) => {
        if (!m) return;
        // Release any loaded textures' GPU memory (forceContextLoss also frees the
        // context, but disposing maps is correct hygiene and helps if it's absent).
        for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
          if (m[slot] && m[slot].dispose) m[slot].dispose();
        }
        if (m.dispose) m.dispose();
      });
    });
    if (envTexture) envTexture.dispose();
    if (scene.environment) scene.environment = null;
    renderer.dispose();
    if (renderer.forceContextLoss) renderer.forceContextLoss();
    if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.remove();
  };
}
