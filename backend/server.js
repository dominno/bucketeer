// Express app for Bucketeer — the localhost S3-compatible storage browser.
// Binds 127.0.0.1 only
// and enforces a Host-header allowlist, because it holds live cloud credentials.
import express from 'express';
import path from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { FRONTEND_DIR, DEFAULT_PORT, BIND_HOST, ALLOWED_HOSTS } from './config.js';
import { errorMiddleware } from './errors.js';
import { profilesRouter } from './routes/profiles.js';
import { transferRouter } from './routes/transfer.js';
import { s3Router } from './routes/s3.js';
import { securityRouter } from './routes/security.js';

// DNS-rebinding guard: reject requests whose Host header is not a loopback name.
function hostAllowlist(req, res, next) {
  const raw = req.headers.host || '';
  let host = raw;
  if (host.startsWith('[')) {
    host = host.slice(0, host.indexOf(']') + 1); // IPv6 literal, keep brackets
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN_HOST', message: `Host not allowed: ${raw}` } });
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(hostAllowlist);

  // Liveness probe (no profile required) — used by the Playwright webServer.
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // JSON routes get a body parser; the upload route deliberately does NOT.
  app.use('/api/profiles', express.json({ limit: '1mb' }), profilesRouter);
  app.use('/api/security', securityRouter);
  app.use('/api/transfer', transferRouter);
  app.use('/api', express.json({ limit: '20mb' }), s3Router);

  // Unknown API endpoint -> JSON 404 (never fall through to the SPA shell).
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } }));

  // Static frontend + SPA fallback for any non-API GET.
  app.use(express.static(FRONTEND_DIR));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

  app.use(errorMiddleware);
  return app;
}

export function startServer(port = DEFAULT_PORT) {
  const app = createApp();
  return new Promise((resolve) => {
    const server = app.listen(port, BIND_HOST, () => {
      const actual = server.address().port;
      // eslint-disable-next-line no-console
      console.log(`Bucketeer running at http://${BIND_HOST}:${actual}`);
      resolve(server);
    });
  });
}

const thisFile = fileURLToPath(import.meta.url);
if (argv[1] && path.resolve(argv[1]) === thisFile) {
  startServer();
}
