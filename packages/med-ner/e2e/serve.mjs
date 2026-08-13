#!/usr/bin/env node
/**
 * @arcaai/med-ner — Playwright E2E webserver
 *
 * Wraps `http-server`'s programmatic API to inject the COOP/COEP headers
 * required for `SharedArrayBuffer` (the Worker-mode E2E suite). The CLI
 * form of `http-server@14` does not expose a custom-headers flag, so we
 * drive its `createServer({ headers, before })` factory directly.
 *
 * Why serve the package root (not `e2e/fixtures/`)?
 * The fixture loads the built bundles at `dist/index.js` and
 * `dist/workers/medner.worker.js`. `tsup` writes those to
 * `packages/med-ner/dist/`, which lives outside `e2e/fixtures/`.
 * Serving the package root exposes both the fixture and the bundles
 * under a single origin, so the page can reference them with absolute
 * `/e2e/fixtures/...` and `/dist/...` paths.
 *
 * Why the `/` redirect?
 * The Playwright specs call `await page.goto('/')` (with `baseURL` of
 * `http://localhost:8080`). A `before` middleware redirects `/` to
 * `/e2e/fixtures/index.html` so the suite can land on the fixture
 * without spec-side changes.
*/

import httpServer from 'http-server';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..'); // packages/med-ner
const FIXTURE_PATH = '/e2e/fixtures/index.html';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '127.0.0.1';

const server = httpServer.createServer({
  root: PACKAGE_ROOT,
  cache: -1,
  cors: true,
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  },
  before: [
    (req, res) => {
      if (req.url === '/' || req.url === '') {
        res.statusCode = 302;
        res.setHeader('Location', FIXTURE_PATH);
        return res.end();
      }
      res.emit('next');
    },
  ],
});

server.listen(PORT, HOST, () => {
  console.log(
    `[med-ner e2e] serving ${PACKAGE_ROOT} at http://${HOST}:${PORT}/  ` +
      `(COOP=same-origin, COEP=require-corp; / -> ${FIXTURE_PATH})`,
  );
});

const shutdown = () => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
