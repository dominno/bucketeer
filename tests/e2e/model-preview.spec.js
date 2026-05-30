// 3D model preview: an uploaded STL renders inline as a WebGL canvas (no
// download), streamed via /view like an image.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addProfileViaPaste, openBucket, createFolder } from './util.js';

const ASCII_STL = `solid tri
facet normal 0 0 1
 outer loop
  vertex 0 0 0
  vertex 10 0 0
  vertex 0 10 0
 endloop
endfacet
endsolid tri
`;

test('preview a 3D model (STL) inline as a WebGL canvas', async ({ page }) => {
  const folder = `qa-ui-model-${Date.now()}`;
  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();

  const file = path.join(os.tmpdir(), `${Date.now()}-cube.stl`);
  fs.writeFileSync(file, ASCII_STL);
  await page.getByTestId('file-input').setInputFiles(file);
  const key = `${folder}/${path.basename(file)}`;
  await expect(page.getByTestId(`row-file-${key}`)).toBeVisible();

  // Clicking the name opens the preview with the 3D stage.
  await page.getByTestId(`row-name-${key}`).click();
  await expect(page.getByTestId('preview-modal')).toBeVisible();
  await expect(page.getByTestId('preview-3d')).toBeVisible();
  // three.js renders into a <canvas> once the model loads.
  await expect(page.locator('[data-testid="preview-3d"] canvas')).toBeVisible({ timeout: 20000 });
  // The loading spinner is removed after the model mounts.
  await expect(page.getByTestId('preview-3d-loading')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('preview-modal')).toHaveCount(0);

  fs.unlinkSync(file);
});

// External-texture resolution: a model that references a texture by bare filename
// (FBX/OBJ/glTF) must fetch that texture from the SIBLING bucket object via /view.
// We use a minimal glTF (same manager.urlModifier wiring as FBX) so we can author a
// valid asset by hand, and assert the texture request was rewritten to /view + 200.
test('a model resolves an external texture from a sibling bucket object (the FBX grey-texture fix)', async ({ page }) => {
  const folder = `qa-ui-tex-${Date.now()}`;
  const ts = Date.now();
  const texName = `coconut_diffuse_${ts}.png`;

  // Embedded geometry buffer (one textured triangle): 3x VEC3 position + 3x VEC2 uv.
  const geo = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1]).buffer);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{}],
    images: [{ uri: texName }], // <- external, by bare filename (the case that 404s today)
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2', min: [0, 0], max: [1, 1] },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 24 },
    ],
    buffers: [{ byteLength: 60, uri: `data:application/octet-stream;base64,${geo.toString('base64')}` }],
  };
  // 1x1 PNG (valid, decodable by <img> → texture.image.width > 0).
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

  const dir = os.tmpdir();
  const gltfPath = path.join(dir, `model_${ts}.gltf`);
  const texPath = path.join(dir, texName);
  fs.writeFileSync(gltfPath, JSON.stringify(gltf));
  fs.writeFileSync(texPath, png);

  await page.goto('/');
  await addProfileViaPaste(page);
  await openBucket(page);
  await createFolder(page, folder);
  await page.getByTestId(`row-name-${folder}/`).click();
  await page.getByTestId('file-input').setInputFiles([gltfPath, texPath]);
  const gltfKey = `${folder}/model_${ts}.gltf`;
  await expect(page.getByTestId(`row-file-${gltfKey}`)).toBeVisible();
  await expect(page.getByTestId(`row-file-${folder}/${texName}`)).toBeVisible();

  // Record any /view request for the TEXTURE object + its response status.
  const texHits = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/transfer/view') && u.includes(encodeURIComponent(`${folder}/${texName}`))) {
      texHits.push(res.status());
    }
  });

  await page.getByTestId(`row-name-${gltfKey}`).click();
  await expect(page.getByTestId('preview-3d')).toBeVisible();
  await expect(page.locator('[data-testid="preview-3d"] canvas')).toBeVisible({ timeout: 20000 });

  // The urlModifier rewrote the bare "coconut_diffuse_*.png" to our /view endpoint
  // for the sibling object, and it streamed back 200 — i.e. the texture resolved.
  await expect.poll(() => texHits.length, { timeout: 10000 }).toBeGreaterThan(0);
  expect(texHits).toContain(200);

  await page.keyboard.press('Escape');
  fs.unlinkSync(gltfPath);
  fs.unlinkSync(texPath);
});

test('all vendored 3D loaders (incl. FBX + deps) resolve via the import map', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__app);
  const r = await page.evaluate(async () => {
    const loaders = [
      ['STL', '/vendor/three/addons/loaders/STLLoader.js'],
      ['GLTF', '/vendor/three/addons/loaders/GLTFLoader.js'],
      ['OBJ', '/vendor/three/addons/loaders/OBJLoader.js'],
      ['PLY', '/vendor/three/addons/loaders/PLYLoader.js'],
      ['FBX', '/vendor/three/addons/loaders/FBXLoader.js'],
    ];
    const out = {};
    for (const [k, p] of loaders) {
      try {
        const m = await import(p);
        out[k] = typeof m[`${k}Loader`] === 'function';
      } catch (e) {
        out[k] = `ERR:${e.message}`;
      }
    }
    return out;
  });
  expect(r).toEqual({ STL: true, GLTF: true, OBJ: true, PLY: true, FBX: true });
});
