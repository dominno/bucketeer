// Electron main process. Wraps the EXISTING Express app unchanged: it relocates
// the credential store into the per-user userData dir, boots the server on a
// random loopback port, and shows it in a window. No backend/frontend changes.
//
// Critical ordering (see plan): backend/config.js reads process.env.PROFILES_PATH
// at module-evaluation time, so we MUST set it (and create the dir) BEFORE the
// dynamic import of backend/server.js — never a static top-level import.
import { app, BrowserWindow, dialog, shell, session, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMOKE = process.env.E2_SMOKE === '1'; // headless self-check (no window)

let mainWindow = null;
let httpServer = null;

// Single-instance: a second double-click just focuses the existing window
// (and avoids a second server/process clobbering the same profiles.json).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(boot);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', () => {
    try {
      if (httpServer) httpServer.close();
    } catch {
      /* ignore */
    }
    // Fallback so a lingering socket/stream can't keep the process alive.
    setTimeout(() => app.exit(0), 1500).unref();
  });
}

async function startBackend() {
  // 1) Point the credential store at a writable, persistent, per-user location
  //    BEFORE the server module is evaluated.
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  process.env.PROFILES_PATH = path.join(userData, 'profiles.json');

  // 2) Import the unchanged Express server and boot it on an OS-assigned port.
  const serverUrl = pathToFileURL(path.join(__dirname, '..', 'backend', 'server.js')).href;
  const { startServer } = await import(serverUrl);
  httpServer = await startServer(0);
  const { port } = httpServer.address();
  return `http://127.0.0.1:${port}`;
}

async function boot() {
  // Native Save dialog for every real download (single file, folder .zip, and
  // each staggered bulk download). Inline previews use /view and never trigger this.
  session.defaultSession.on('will-download', (_e, item) => {
    const target = dialog.showSaveDialogSync(mainWindow || undefined, { defaultPath: item.getFilename() });
    if (target) item.setSavePath(target);
    else item.cancel();
  });

  let appUrl;
  try {
    appUrl = await startBackend();
  } catch (err) {
    if (SMOKE) {
      console.error(`E2_SMOKE_FAIL ${err?.message || err}`);
      app.exit(1);
      return;
    }
    dialog.showErrorBox('Could not start Bucketeer', String(err?.message || err));
    app.quit();
    return;
  }

  // Headless self-check: verify the server answers, then quit. No window.
  if (SMOKE) {
    http
      .get(`${appUrl}/api/health`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          console.log(`E2_SMOKE_OK url=${appUrl} status=${res.statusCode} body=${body}`);
          app.exit(res.statusCode === 200 ? 0 : 1);
        });
      })
      .on('error', (e) => {
        console.error(`E2_SMOKE_FAIL ${e.message}`);
        app.exit(1);
      });
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Bucketeer',
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1216',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  // Splash first (server is already up by now, but loadFile is instant and
  // avoids any white flash); then swap to the live app.
  await mainWindow.loadFile(path.join(__dirname, 'loading.html'));
  await mainWindow.loadURL(appUrl);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.show();

  // Keep navigation pinned to the loopback origin; open anything else externally.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appUrl)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
}

// A minimal menu. The Edit roles are load-bearing: the onboarding flow is
// pasting the iDrive Access-Keys text, so Cmd/Ctrl+V must work in inputs.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
buildMenu();
