# Bucketeer

🪣 **Bucketeer** is the S3 browser that feels like a file explorer — **preview your media in‑app,
move files in bulk, and keep your keys on your own machine.** A polished, **localhost‑only** desktop
app for **any S3‑compatible storage** (iDrive E2, MinIO, Backblaze B2, Cloudflare R2, Wasabi, AWS S3, …),
across **multiple accounts and buckets**.

Most S3 tools are glorified file lists: to look at a photo, a video, or a 3D asset you have to download
it first. Bucketeer **previews it in place** — images, video, audio, PDFs, code, **Office documents
(Word · Excel · PowerPoint)**, and **3D models with their textures** — and when you *do* transfer, it
does it like a grown‑up download manager: in parallel, with retries, conflict prompts, and live
per‑file detail.

### Why you'll want it

- 👁️ **See before you download.** Inline preview for **images, video (mp4/mov/webm…), audio, PDFs,
  text/code, Office documents** (**.docx** rendered to formatted text, **.xlsx** as browsable
  per‑sheet tables, **.pptx** as slide‑by‑slide text), and **3D models** (STL · PLY · OBJ · FBX · GLB
  · glTF) — those models render *with the texture files from your bucket*, not as grey blobs.
  Everything renders **client‑side** — nothing touches your disk and no bytes leave your machine until
  you ask.
- 🚀 **A real transfer manager.** Uploads and downloads run as managed queues with **parallel transfers,
  live speed/ETA, auto‑retry with backoff, cancel, and "retry all failed"** — plus a full‑window view with
  one overall progress bar. Built to survive a **multi‑GB, 100k‑file** job.
- 📁 **Whole folders, both ways.** Drag a folder in and the **structure is recreated** in the bucket; pull
  a folder out and it **writes the real files straight into a folder you pick** (6 in parallel, structure
  preserved, with **overwrite / keep‑both / skip** detection) — not a giant zip. Each download is expandable
  to show **source → destination**, what's transferring now, and what just saved.
- 🔎 **Find anything.** Recursive **search across every subfolder** with `*`/`?` glob matching and
  **"load more" pagination** through huge buckets.
- 🔑 **Your keys never leave your machine.** Credentials live in the local backend (**encrypted at rest** —
  OS keychain in the desktop app), every S3 call is proxied server‑side, secrets are **never sent to the
  browser**, and you **never configure bucket CORS**. A local **activity log** records every change/download/
  share for your own audit. No cloud middleman, no account, no telemetry.
- 🖥️ **Double‑click to run, Windows & Mac.** Ships as a desktop app — **no terminal, no Node install.**
  Manage **many profiles and buckets**, in **English or Polish**.

### How it's different from S3 Browser, Cyberduck, or the AWS console

| | **Bucketeer** | Typical S3 browsers / web consoles |
|---|---|---|
| Preview media in‑app | ✅ images, **video**, audio, PDF, **Office (docx/xlsx/pptx)**, **3D models w/ textures** | ❌ download first (often list‑only) |
| Platforms | ✅ **Windows + Mac** (one app) | ⚠️ often Windows‑only, or browser‑only |
| Provider lock‑in | ✅ **any** S3 endpoint | ⚠️ frequently AWS‑centric |
| Folder download to disk | ✅ real files + structure + conflict prompts, **parallel** | ⚠️ one‑by‑one or a single zip |
| Where credentials live | ✅ **local only**, never in the browser, no CORS setup | ⚠️ pasted into a web page / third‑party service |
| Cost / signup | ✅ free, local, no account | ⚠️ paid tiers / sign‑up |

> **Provider‑agnostic by design:** it speaks the plain S3 API, so it works with any compatible endpoint.
> Developed and tested against **iDrive E2**, but nothing is iDrive‑specific.

Under the hood, the backend (Node + Express) holds your credentials and proxies every S3 call via the AWS
SDK v3, so transfers stream **through** the app — no bucket CORS configuration is ever needed and your
secrets never reach the browser. The frontend is dependency‑free vanilla JavaScript (no build step).

```
┌────────────┐   fetch /api/*   ┌───────────────────┐   AWS SDK v3 (SigV4)   ┌──────────────┐
│  Browser   │ ───────────────► │  Express backend  │ ─────────────────────► │  S3 storage  │
│ (vanilla)  │ ◄─────────────── │ (127.0.0.1 only)  │ ◄───────────────────── │ (any S3 API) │
└────────────┘   JSON / stream  └───────────────────┘   path-style endpoint   └──────────────┘
                                  credentials live here (config/profiles.json, 0600)
```

## Desktop app (Windows & Mac) — recommended for most users

You can run this as a normal double-click desktop app — **no terminal, no Node install**.
It's the same app wrapped in [Electron](https://www.electronjs.org/): launching it starts the
local server on a private `127.0.0.1` port and opens it in its own window.

### Installing (non-technical users)

**Mac** — open `Bucketeer-<version>-universal.dmg` (one file works on Intel **and** Apple
Silicon), drag the app to **Applications**, eject the disk image. The **first** launch only:
right-click (Control-click) the app → **Open** → **Open** again. (On macOS 15 Sequoia, if it still
refuses: **System Settings → Privacy & Security → Open Anyway**.) After that, open it like any app.

**Windows** — run `Bucketeer Setup <version>.exe`. If SmartScreen shows "Windows protected
your PC", click **More info → Run anyway**. It installs for your user (no admin prompt), adds Desktop
and Start-menu shortcuts, and opens automatically.

> The one-time warning appears only because the app isn't code-signed yet (a planned follow-up:
> Apple Developer ID + notarization, and a Windows Authenticode cert). It is expected and safe here.

On launch you'll see a brief "Starting…" splash, then the browser. Paste your Access-Keys text to add
a connection (Ctrl/Cmd-V works), and downloads pop a normal **Save As** dialog. Your saved connections
live privately in your user account folder (`userData/profiles.json`) and survive app updates.

### Building the installers (developers)

```bash
npm run app:build       # build the installer for THIS machine's OS + print how to get the other
npm run app:dir         # fast unpacked build into dist/ (for local testing)
npm run app:mac         # → dist/Bucketeer-<ver>-universal.dmg   (run on macOS)
npm run app:win         # → dist/Bucketeer Setup <ver>.exe        (run on Windows)
```

**Building both at once:** a single machine can't reliably build the *other* OS's installer (a
Windows `.exe` can't be built on macOS), so the "both" path is **CI** — push a `v*` tag or run the
**Build desktop installers** GitHub Action (`.github/workflows/build-installers.yml`). It builds the
`.dmg` on a macOS runner and the `.exe` on a Windows runner and uploads both as artifacts.

Installers go to `dist/` (git-ignored). The build **excludes credentials and tests** from the package
(verified: secrets never ship).

## Requirements

- Node.js ≥ 18 (tested on v20) — to run from source or build the desktop app. (End users of the
  packaged desktop app need **nothing** installed.)
- An **S3-compatible account** with an access key — endpoint host, region, access key ID, secret.
  Works with iDrive E2, MinIO, Cloudflare R2, Backblaze B2, AWS S3, and similar.

## Install & run

```bash
npm install
npm start            # serves http://127.0.0.1:5173  (set PORT to change)
```

Open <http://127.0.0.1:5173> in your browser.

## Adding a credential profile

1. Click the ⚙ **gear** in the sidebar (or **Add a profile**).
2. Paste the contents of your iDrive E2 `…Access-Keys (N).txt` file into the text box and
   click **Parse** — the form autofills. (For any other provider, just fill the fields manually:
   endpoint host, region, access key ID, secret.)
3. Click **Add profile**. The profile is selected and its buckets load in the sidebar.

From the same gear dialog you can **edit** a profile (e.g. rotate its secret — leave the secret blank
to keep the current one) or **remove** it. Removing a profile only deletes the stored credentials; the
bucket's objects are untouched.

**Endpoint host** is the storage endpoint, e.g. `m2o3.fra.idrivee2-58.com` (iDrive E2),
`s3.eu-central-1.amazonaws.com` (AWS S3 — region-specific), `<account>.r2.cloudflarestorage.com`
(Cloudflare R2). For **AWS** the host must match your region; if you enter the generic
`s3.amazonaws.com`, the app automatically rewrites it to the region-specific endpoint so signing
doesn't fail with *"the region … is wrong"*.

A credentials file looks like:

```
Endpoint: m2o3.fra.idrivee2-58.com
Region Code: eu-central-2
Access key ID: ABCD...
Secret Access Key: wxyz...
```

You can add **as many profiles as you like** (different accounts / regions / keys) and switch
between them with the dropdown. Each profile exposes its own set of buckets.

## Using the browser

| Action            | How                                                              |
| ----------------- | ---------------------------------------------------------------- |
| Open a bucket     | Click it in the sidebar                                          |
| Switch profile    | The dropdown in the sidebar                                       |
| Settings          | The ⚙ gear opens **Settings**: add/edit/remove connections, and view/**Clear** the in-memory preview cache (with its current size) |
| Navigate folders  | **Click anywhere on a folder row** to open it (select folders with the checkbox); breadcrumbs go back up |
| Sort              | Click the **Name / Size / Modified** column headers (click again to reverse; folders stay on top) |
| Search / filter   | The header search box, or `/` — filters the current folder by name (supports `*` / `?` wildcards, e.g. `*.fbx`) |
| Search subfolders | When the folder filter has no match (or any time you search), **Search all subfolders** runs a recursive scan of the whole tree and lists matches with their paths (each result can be previewed, downloaded, or "open containing folder"); a **"Load more results"** button pages through huge buckets instead of stopping at a cap |
| Refresh           | The ↻ toolbar button re-lists the current folder                  |
| Large folders     | Listings load **200 at a time** — a **Load more** button fetches the next page (search can prompt you to load more to find matches) |
| Preview           | Click a file — **images, video & audio, PDFs, text/code, Office documents, and 3D models** open in an inline viewer (no download). **Office** rendering is fully client-side: **.docx** → formatted text/tables/inline images (mammoth.js), **.xlsx** → browsable per-sheet tables (SheetJS), **.pptx** → slide-by-slide text (JSZip). **3D models** (glb/gltf/stl/obj/ply/**fbx**, orbit + auto-rotate) render with their bucket textures. Large files show an animated **spinner + download progress**; viewed files are **cached** (re-open is instant). Video/audio stream with seeking (HTTP Range); `←`/`→` page between files |
| Upload files      | **Upload** button, or **drag & drop** files onto the page         |
| Upload a folder   | **Upload folder** button, or **drag & drop a folder** — the whole nested structure (subfolders + files) is recreated under the current folder |
| Download a file   | The ⬇ row action, or the download button inside the preview      |
| Download a folder | The ⬇ action on a folder row — writes the **actual files straight into a folder you pick** (subfolder structure recreated), detecting any that already exist and prompting to **Overwrite / Keep both / Skip** (with *apply to all*). In browsers without the directory picker it falls back to a structure-preserving `.zip` |
| Download many     | Multi-select, then the ⬇ toolbar action — same folder-to-disk save (with conflict detection) for the whole selection, or one bundled `.zip` as the fallback |
| Create folder     | **New folder** button                                            |
| Rename / Move     | Row actions (✎ rename, ⬆ move); `F2` renames the selected item; both refuse to silently overwrite an existing target (prompt to **Replace**) |
| Delete            | Row action (🗑), or select rows and use the bulk-delete button. Folders delete **recursively**; always confirmed |
| Multi-select      | Checkboxes, **shift-click** for ranges, the header checkbox or `Ctrl/Cmd+A` to select all |
| Share a link      | 🔗 row action — opens a dialog to pick an **expiry (1 hour / 1 day / 7 days)** and copy a **presigned URL** (no sign-in needed for the recipient) |
| Info / properties | ℹ row action — a file shows its full HEAD metadata (size, type, modified, ETag, storage class, custom `x-amz-meta-*`); a folder shows a **total-size + object-count rollup** |
| Language          | **English / Polski** switcher in the sidebar footer (auto-detected from the browser, remembered) |

### Transfer manager

Uploads and downloads appear in two stacked docks (bottom-right) with a live header pill. A
**Transfers** overview on top shows one **overall progress bar across uploads + downloads** with
combined speed and **time left**, a **Cancel-all** (stop) button, and an **expand** button (or click
the header pill) that maximizes everything into a **full-window panel** (Esc / backdrop-click to close).
Each item also has its own **×** cancel.

- **Uploads** — a queue (3 at a time) with an aggregate progress bar + combined speed/ETA, per-file
  speed/ETA, **cancel**, **retry** (failed transfers auto-retry transient errors with backoff, or retry
  manually), and **overwrite/conflict detection**: re-uploading an existing name prompts **Replace /
  Keep both / Skip** (per file or all at once) instead of silently clobbering. "Clear completed" keeps
  failures visible until you dismiss them. Scales to **thousands of files** (a GB folder): the row list
  is capped (active + failed surface first) while the counts, aggregate progress and "Retry all failed"
  cover the whole batch — so you can confirm everything uploaded and re-run just the failures.
  Large files (>16 MiB) upload as **resumable multipart**: the browser slices the file into parts and
  persists the upload id + completed-part checksums, so a failed/retried upload **continues from the
  last completed part instead of restarting from 0** — a dropped connection at 92% of a multi-GB upload
  no longer means starting over. Cancelling aborts the multipart upload so no orphaned parts are billed.
  Such an upload even **survives an app close / reload**: the in-progress upload lives in the bucket, so it
  reappears as **Interrupted** — click **Resume**, re-select the same file (verified by size + modified
  date), and it continues from the last completed part (the file's bytes can't be re-read after a reload,
  so a re-pick is required; the already-uploaded parts are not re-sent).
- **Downloads** — a real download manager (most apps only have fire-and-forget). In a normal browser
  and in the desktop app a single file streams straight to a file you pick; a folder or multi-selection
  **writes the real files into a folder you pick**, recreating the structure. After you pick the
  destination it first **indexes the selection** — the server *streams* the listing (NDJSON) so a live
  *"Scanning… N files found"* count climbs even inside one huge folder and you can **cancel mid-scan** (no
  frozen wait) — then tracks
  **files-done / total + live byte progress, speed/ETA, and cancel** — and where a file already exists
  on disk it prompts **Overwrite / Keep both / Skip** (per file or *apply to all*). Folder downloads run
  **6 files in parallel** (folders of many small files are latency-bound, so concurrency is the big win —
  a 100k-file folder goes from hours to minutes); a single failed file is retried and counted, never
  aborting the whole job. Each folder download is **expandable** to show its **source → destination**
  (bucket/prefix → the local folder you picked), the files **downloading right now**, and the **most
  recently saved** files (each tagged saved / skipped / failed). A single large download **resumes** after
  a dropped connection: it commits the bytes already on disk and continues from that offset with an HTTP
  Range request, guarded by the object's **ETag** (`If-Match`) so a file that changed mid-download restarts
  cleanly instead of splicing onto a stale prefix. A download also **survives an app close / reload**: the
  destination handle is kept in IndexedDB, so it reappears as **Paused** with a **Resume** button — one
  click re-grants write permission and continues (a single file from the last committed byte; a folder by
  re-scanning and skipping the files already fully on disk).
  Where the File System Access API isn't available it falls back to the browser's own download / a single
  tracked `.zip`.

### Keyboard shortcuts

| Key | Action |
| --- | ------ |
| `/` or `Ctrl/Cmd + K` | Focus the search box |
| `Ctrl/Cmd + A` | Select everything in the folder |
| `Delete` / `Backspace` | Delete the selected items |
| `F2` | Rename the selected item |
| `Esc` | Clear selection · close a dialog · collapse the transfer panel |
| `←` / `→` | Previous / next file in the preview |

## Testing

```bash
npm run test:integration   # backend integration tests against the REAL bucket
npm run test:e2e           # Playwright UI tests (boots the app, drives a browser)
npm test                   # both
```

The tests run against the live `browser-app-test` bucket. They scope every object to a unique
`qa/<uuid>/` (integration) or `qa-ui-*` (e2e) prefix and **clean up after themselves**, so they
can be run repeatedly and never touch your other data. They cover: credential errors, folder
markers, the Content-Type fix, byte-exact upload/download, presigned URLs, rename, recursive
delete, **multipart (>8 MiB)** uploads, special-character filenames, concurrent uploads, and the
full UI flow.

Credentials for tests are read from the `e2-*Access-Keys*.txt` file in the project root (override
with `E2_CREDS_FILE`).

## Security notes

- The server binds **127.0.0.1 only** and enforces a **Host-header allowlist** (defeats
  DNS-rebinding), because it holds live cloud credentials.
- Secret access keys are **encrypted at rest**: in the desktop app via the OS keychain (macOS
  Keychain / Windows DPAPI / Linux secret service, through Electron `safeStorage`), and in dev/browser
  mode via a local AES-256-GCM key file. The on-disk `profiles.json` (mode `0600`, git-ignored) holds
  only ciphertext; an existing plaintext store is migrated transparently on first run. Secrets are
  **never** returned to the browser or written to logs — the API returns a redacted `secretPreview` only.
- An append-only **activity log** (kept locally, exportable from Settings) records mutating and egress
  actions — deletes, moves/renames, uploads, downloads, folder/zip downloads, presigned shares, and
  profile changes — and **never** records secrets or the signed share URL.
- Object keys, prefixes and bucket names are validated server-side to block path-traversal and
  injection before any S3 call.

This is a single-user local tool. Do not expose it to a network or the public internet.

## S3 / iDrive E2 specifics handled

- **Path-style** addressing with an explicit `https://<host>` endpoint (`forcePathStyle: true`).
- Some providers (e.g. iDrive E2) return `binary/octet-stream` for objects uploaded without a type, so the app **forces
  the Content-Type from the file extension** on every upload (verified in tests).
- Non-ASCII upload filenames are decoded as UTF-8 (`busboy defParamCharset`), matching browsers.
- Listing a non-existent bucket returns `403 AccessDenied` (not `404`); the UI surfaces this
  without masking genuine credential failures (`401`).
- **HTTP Range** is forwarded to S3 (`206 Partial Content`) so video/audio seeking and partial
  media fetches work.

## Accessibility & theming

- **Theme: Light / Dark / System** — a selector in the sidebar footer, persisted across launches.
  *System* follows your OS (`prefers-color-scheme`); Light/Dark override it.
- Honours **reduced-motion** (disables spinners/shimmer/animations).
- Keyboard-navigable with focus-visible outlines, focus-trapped modals, and ARIA roles/labels —
  progress bars, dialogs, sortable headers (`aria-sort`), and `aria-live` regions for status.

## Project layout

```
backend/
  server.js          Express app: 127.0.0.1 bind, host allowlist, static, routes, error handler
  routes/            profiles.js · s3.js · transfer.js (upload · download · view · download-folder · zip-selection · presign)
  operations.js      all S3 logic (list/head/upload/download+Range/copy/delete/zip/presign)
  profiles.js        credential store (CRUD, redaction, iDrive .txt parser)
  s3clients.js · validate.js · errors.js · middleware.js · asyncHandler.js · config.js
frontend/
  index.html · css/app.css
  js/                store · router · api · actions · i18n (en/pl) · format · mime · dom
  js/ui/             Sidebar · Toolbar · FileTable · Breadcrumbs · Selection · Shortcuts ·
                     PreviewModal · ModelViewer (3D) · OfficeViewer (docx/xlsx/pptx) ·
                     UploadManager · DownloadManager ·
                     TransferOverview · Profile/Confirm/Prompt modals · Toasts
  vendor/three/      vendored three.js + loaders (STL/OBJ/PLY/GLTF/FBX) for offline 3D preview
  vendor/office/     vendored mammoth.js (docx) · SheetJS (xlsx) · JSZip (pptx) for offline Office preview
electron/            main.js (boots the server in a window) · loading.html · preload (n/a)
build/icon.png       app icon (electron-builder generates .icns/.ico)
scripts/build-desktop.sh        one-command host-OS installer build
.github/workflows/build-installers.yml   CI: builds the .dmg + .exe on native runners
tests/               integration.test.js · e2e/*.spec.js · helpers/ · global-teardown.js
config/profiles.json (web mode) / userData (desktop)   your credentials — git-ignored, mode 0600
```

## Architecture & engineering

Bucketeer is organized along **ports-and-adapters (hexagonal)** lines: the UI and HTTP routes are *driving* adapters, `operations.js` / `actions.js` are the *application core*, and the AWS SDK, File System Access (FSA) API, IndexedDB, and the OS keychain are *driven* adapters reached through thin seams (`s3clients.js`, `api.js`, `transferStore.js`, `secretBox.js`). The dependency arrows point inward — `routes → operations → SDK` — with `middleware.resolveProfile()` injecting `req.s3 = getClient(profile)` so handlers never construct a client.

- **Driving adapters (backend):** `routes/{s3,transfer,profiles,security}.js` are thin Express handlers — validate (`assertBucket`/`assertKey`/`assertPrefix`), call one `operations.js` function, emit JSON/stream, record audit. `server.js` `createApp()` is the composition root; `middleware.js` · `asyncHandler.js` · `errors.js` carry HTTP cross-cutting concerns (`mapS3Error()` translates SDK errors at the edge).
- **Application core (backend):** `operations.js` — every export takes an injected `client` plus plain args and returns plain data (or streams to a passed `res`); no Express knowledge.
- **Driving adapters (frontend):** `ui/*` + `dom.js` subscribe to the store and call actions with no business logic (e.g. `Toolbar.js → actions.pickFilesAndUpload`); `router.js` is the URL adapter.
- **Application core (frontend):** `actions.js` orchestrates the leaf modules over `store.js` — a tiny observable with an in-flight "settle" counter.
- **Ports:** `api.js` is the single backend fetch seam (injects `X-Profile-Id`, normalizes failures to `e.code`); `s3clients.js` is the S3-client port behind which the SDK lives.
- **Driven adapters:** `s3clients.js` (AWS SDK factory + keep-alive pool), `secretBox.js` (`safeStorage` keychain vs local AES-256-GCM behind `seal`/`open`), `profiles.js` (atomic filesystem store), `audit.js` (append-only NDJSON sink), `transferStore.js` (IndexedDB persistence of `FileSystemFileHandle`s), and the raw FSA API.

We treat these as working principles, not dogma:

- **SOLID** — single-responsibility seams are real: `operations.js` holds S3 use-cases with zero Express knowledge, `s3clients.js` owns only client construction/pooling, and `secretBox.js` hides two crypto providers behind one `seal`/`open` interface (open for a new provider, closed for change). Dependency direction is enforced by `resolveProfile()` injecting the client.
- **DRY** — one `dom.js` `h()`/`mount`, one `openModal` (`modalbase.js`), one `asyncHandler`, one error envelope (`mapS3Error`), one `api.js` fetch seam, and one `{ promise, abort }` contract shared by `api.uploadFile` and `multipartUpload`; a unit test enforces en/pl i18n key parity.
- **KISS** — no frontend framework and **zero runtime dependencies** in the browser (three.js is vendored under `frontend/vendor/three`); `store.js` is a tiny `createStore`; `mime`, `format`, and `textureResolver` are pure functions.

**Trade-offs we accept (and the comments say so):** `operations.js` (~630 lines) and `actions.js` (~1,700 lines) are cohesive but large; the core→storage seam is concrete (`operations.js` builds `@aws-sdk/client-s3` commands directly rather than through an inverted interface); a few stream functions write to `res`, leaking transport into the core; and module-level caches expose `_resetCache()` for tests. These are deliberate simplicity-over-ceremony choices for a single-binary local tool.

### Development workflow

- **Multi-agent build process.** Every non-trivial problem — features, bug hunts, audits, refactors — is tackled with a **dynamic, multi-agent workflow**: the work is decomposed across parallel specialized agents for analysis/mapping, implementation, and **adversarial verification**, which must agree before a change is accepted.
- **Grounded in the real code.** Agent conclusions cite actual files and functions (not assumptions) and are reconciled against contradicting evidence before they're treated as true.
- **Validated before "done".** Changes run against the three-tier suite — `node --test` unit tests (including the en/pl i18n parity invariant), HTTP integration tests against the **real** iDrive E2 bucket (uuid-scoped, self-cleaning), and serial **Playwright** e2e (`qa-ui-*`, swept in teardown) — before work is considered complete.

## License

Released under the **MIT License** — free to use, copy, modify, and distribute, including commercially, provided the copyright notice and this permission notice are kept.

**Use at your own risk.** This software is provided **"AS IS", without warranty of any kind**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement. The authors and copyright holders are **not liable** for any claim, damages, or other liability — including any data loss, corruption, or accidental deletion in your S3/iDrive E2 buckets — arising from the use of this software. You are responsible for your own credentials, backups, and verifying behavior before running it against important data.
