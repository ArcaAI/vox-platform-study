# TASK-281 — `@arcaai/med-ner` Playwright E2E Infrastructure Fix

| Field | Value |
|---|---|
| Ticket | TASK-281 |
| Short name | MedNER-E2E-Infra |
| Created | 2026-05-23 |
| Updated | 2026-05-24 |
| Status | Completed (with newly-discovered follow-ups — see §7) |
| Parent | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Sibling | [TASK-277 — MedNER Correctness Fixes](../TASK-277-MedNER-Correctness/README.md) (discovered this issue while updating the E2E fixture API) |
| Implementer | Wave-2A Agent C1 (fix/2605-review) |

---

## 1. Requirement Analysis

### 1.1 Description

`@arcaai/med-ner` ships a Playwright E2E suite at `packages/med-ner/e2e/`. The fixture HTML, factory wiring, and specs are correct (TASK-272 wrote them; TASK-277 migrated the fixture to the new `createMedNER({ workerFactory })` shape). However the suite **cannot currently execute end-to-end** because of two pre-existing infrastructure bugs in the test webserver layer.

### 1.2 The two infrastructure bugs (in scope for TASK-281)

**B-1 — `http-server` root excludes `dist/`**

`packages/med-ner/e2e/playwright.config.ts:46` launched:

```
npx http-server ./e2e/fixtures -p 8080 -c-1 --cors
```

The serve root was `packages/med-ner/e2e/fixtures/`. The fixture HTML imports `./dist/index.js` and `./dist/workers/medner.worker.js`. `tsup` writes those bundles to `packages/med-ner/dist/`, which is **outside** the serve root. Every fixture import 404'd.

**B-2 — `serve.json` headers silently ignored**

The fixture ships a `serve.json` declaring the COOP/COEP headers required for `SharedArrayBuffer` (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The `http-server` npm package is **not** Vercel's `serve` and does not read `serve.json` — only its own CLI flags. The CLI of `http-server@14.1.1` exposes no custom-header flag (only `--cors`, `-c-1`, etc.). Result: even with B-1 fixed, the Worker-mode E2E would fail because `SharedArrayBuffer` is unavailable without cross-origin isolation.

### 1.3 Acceptance criteria (per Wave-2A briefing)

1. `pnpm --filter @arcaai/med-ner test:e2e` no longer 404s on the bundle imports — the suite actually loads the SDK and exercises at least one spec.
2. The webserver serving the fixture honours COOP/COEP so `SharedArrayBuffer` is available inside the page.
3. No regression to `packages/med-ner/src/**` or any other package's tests / build / lint.

The briefing explicitly carves out further infra blockers found *after* B-1/B-2 are fixed (e.g. missing browsers, locked port, fixture-level bugs) as out-of-scope — they must be documented in §7 and the agent must stop, not widen scope.

---

## 2. Current State Evaluation

| Aspect | State (before TASK-281) |
|---|---|
| Fixture HTML | Correct shape (TASK-277 verified) — calls `createMedNER({ workerFactory })` against the new API |
| Specs | Correct shape (TASK-272 wrote them); use `page.goto('/')` against baseURL `http://localhost:8080` |
| Bundles | `packages/med-ner/dist/index.js` (~47 KB ESM), `packages/med-ner/dist/workers/medner.worker.js` (~2.3 MB ESM) build cleanly via `tsup` |
| Webserver root | `e2e/fixtures/` — wrong (excludes `dist/`) |
| Webserver headers | Default `http-server` headers — no COOP/COEP |
| Suite history | Initial commit only; never run successfully (`git log --oneline -- packages/med-ner/e2e/`) |
| Installed Playwright browsers | chromium-1208 + chromium-1217 only; no firefox, no webkit |

---

## 3. Implementation Plan (Locked — chosen by user as `hybrid_wrapper`)

After review of three options (move root + keep `http-server` CLI; swap to `@vercel/serve`; tiny custom Node webserver), the user locked **`hybrid_wrapper`**: keep `http-server` as the static-file backend, add a tiny ESM wrapper at `e2e/serve.mjs` that drives its programmatic `createServer({ headers })` factory directly. No new dependency.

### 3.1 `http-server@14.1.1` programmatic API (one-line citation)

From `packages/med-ner/node_modules/http-server/lib/http-server.js:21-23`:

```js
exports.createServer = function (options) {
  return new HttpServer(options);
};
```

The `HttpServer` constructor honours `options.root`, `options.headers` (merged into a per-response header set on top of `Accept-Ranges: bytes`), `options.cache` (`-1` ⇒ `no-cache, no-store, must-revalidate`), `options.cors`, and an `options.before` array of `(req, res) => …` middlewares that pass control downstream via `res.emit('next')`. The instance exposes `.listen(port, host, cb)` and `.close()` — exactly what Playwright's `webServer` manager needs.

### 3.2 Server design

1. **Serve root** = package root (`packages/med-ner/`), so both `e2e/fixtures/index.html` and `dist/...` are reachable from a single origin.
2. **Headers** = `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, plus a conservative `Cross-Origin-Resource-Policy: same-origin` (all served same-origin from `127.0.0.1:8080` so CORP `same-origin` is sufficient).
3. **`/` redirect** = a `before` middleware sends `302 → /e2e/fixtures/index.html`. The specs call `page.goto('/')` (baseURL-relative), and a leading-slash path replaces the baseURL's path component — without this redirect Playwright would land on a directory listing or 404.
4. **Caching** = `-1` (no-cache).
5. **Host/port** = `127.0.0.1:8080`, overridable via `HOST` / `PORT` env vars.
6. **Graceful shutdown** = `SIGINT` / `SIGTERM` trigger `server.close()` so Playwright's webServer manager can stop us between test runs.

### 3.3 Playwright config changes

- `webServer.command` → `node e2e/serve.mjs` (no `npx`, no `pnpm exec` — direct `node` per the briefing).
- `webServer.cwd` → `'..'`. Playwright defaults `cwd` to the config-file directory (`e2e/`); we hop up one level so the relative `e2e/serve.mjs` resolves under the package root.
- `webServer.url` → `http://127.0.0.1:8080/e2e/fixtures/index.html` (a route the server actually serves; readiness check exercises both the wrapper and the fixture path).
- `use.baseURL` → `http://127.0.0.1:8080` (was `http://localhost:8080`). Using `127.0.0.1` explicitly avoids DNS-resolution-order surprises (IPv6 `::1` first on some macOS setups) since the server binds to `127.0.0.1`.

### 3.4 Fixture import path changes

The fixture imports moved from relative-to-fixture-dir to absolute-from-server-root:

- `import { … } from './dist/index.js'` → `import { … } from '/dist/index.js'`
- `new Worker(new URL('./dist/workers/medner.worker.js', import.meta.url), …)` → `new Worker(new URL('/dist/workers/medner.worker.js', import.meta.url), …)`

`import.meta.url` resolves to `http://127.0.0.1:8080/e2e/fixtures/index.html`; the leading `/` makes both URLs `http://127.0.0.1:8080/dist/…`.

### 3.5 `package.json` script

Added `"e2e:serve": "node e2e/serve.mjs"` next to the existing `test:e2e*` scripts so the wrapper can be started standalone for manual smoke. **No** dependency / devDependency edits.

---

## 4. Implementation Summary

The `hybrid_wrapper` server is in `packages/med-ner/e2e/serve.mjs` (~60 lines, all comments + 1 `before` middleware + 1 `createServer({ … })` call). Playwright's `webServer` now boots it via `node e2e/serve.mjs` (with `cwd: '..'`). The fixture's two bundle imports were rewritten to absolute (`/dist/...`) paths. Manual `curl -I` confirms COOP/COEP on every response, including the bundle and the worker. `pnpm --filter @arcaai/med-ner test:e2e:chromium` no longer 404s — the page renders, the bundle is fetched with the right headers, and Playwright drives 14 specs.

A separate, newly-discovered fixture/bundle-shape blocker (B-3, bare-specifier ES-module imports in the dist bundle) prevents the SDK's `<script type="module">` from actually evaluating in the browser. That is logged in §7 and explicitly out of scope per the briefing's STOP rule.

---

## 5. Files Changed

| File | Action | Purpose |
|---|---|---|
| `packages/med-ner/e2e/serve.mjs` | **Created** | ESM wrapper around `http-server.createServer({ headers, before })` — injects COOP/COEP, serves package root, redirects `/` → `/e2e/fixtures/index.html`, graceful shutdown |
| `packages/med-ner/e2e/playwright.config.ts` | Modified | `webServer.command` → `node e2e/serve.mjs`; added `cwd: '..'`; `webServer.url` → fixture path; `use.baseURL` → `http://127.0.0.1:8080` |
| `packages/med-ner/e2e/fixtures/index.html` | Modified | Two import paths flipped from relative (`./dist/...`) to absolute (`/dist/...`); two TASK-281 comment blocks documenting the change |
| `packages/med-ner/package.json` | Modified | Added one script entry: `"e2e:serve": "node e2e/serve.mjs"`. **No** dependency edits |
| `packages/med-ner/e2e/fixtures/serve.json` | **Untouched (deprecated)** | Left in place per anti-pattern guidance; `http-server` does not read it. See §7 deprecation note |
| `docs/implementation/TASK-281-MedNER-E2E-Infra/README.md` | Modified | This document — §3–§8 populated, status → Completed |

Files **not** touched (out of scope): `packages/med-ner/src/**`, `packages/med-ner/tsup.config.ts`, `packages/med-ner/e2e/med-ner.e2e.spec.ts`, any other package, any lockfile.

---

## 6. Verification

All commands run from the repo root via `zsh`.

### 6.1 Static syntax check on the new server

```
$ node --check packages/med-ner/e2e/serve.mjs && echo "OK"
OK
```

### 6.2 Manual smoke — COOP/COEP + bundle reachability via `curl -I`

Server started with `(cd packages/med-ner && node e2e/serve.mjs &)`, then:

```
$ curl -sI http://127.0.0.1:8080/e2e/fixtures/index.html | rg -i "(http|cross-origin|content-type)"
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Range
content-type: text/html; charset=UTF-8
```

```
$ curl -sI http://127.0.0.1:8080/dist/index.js | head -8
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Range
cache-control: no-cache, no-store, must-revalidate
```

```
$ curl -sI http://127.0.0.1:8080/dist/workers/medner.worker.js | head -8
HTTP/1.1 200 OK
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Accept-Ranges: bytes
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Origin, X-Requested-With, Content-Type, Accept, Range
cache-control: no-cache, no-store, must-revalidate
```

```
$ curl -sI http://127.0.0.1:8080/ | head -5
HTTP/1.1 302 Found
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
Cross-Origin-Resource-Policy: same-origin
Accept-Ranges: bytes
```

Startup banner:

```
[med-ner e2e] serving /Users/taphuynh/Desktop/igglo/ARCAAI/hope-v2/packages/med-ner at http://127.0.0.1:8080/  (COOP=same-origin, COEP=require-corp; / -> /e2e/fixtures/index.html)
```

✅ B-1 fixed (200 on `/dist/...` and `/dist/workers/...`). ✅ B-2 fixed (COOP/COEP present on every response, including the bundle and the worker). ✅ `/` redirect works for `page.goto('/')`.

### 6.3 Unit tests / lint / build (no regressions)

```
$ pnpm --filter @arcaai/med-ner test
…
 Test Files  11 passed (11)
      Tests  143 passed (143)
   Duration  2.27s
```

```
$ pnpm --filter @arcaai/med-ner lint
> ESLINT_USE_FLAT_CONFIG=false eslint "src/**/*.ts*" --max-warnings 0
(exits 0; only the unrelated ESLintRC deprecation warning is printed)
```

```
$ pnpm --filter @arcaai/med-ner build
…
ESM dist/index.js     46.96 KB
CJS dist/index.cjs     48.41 KB
DTS dist/index.d.ts  34.81 KB
ESM dist/workers/medner.worker.js     2.30 MB
ESM ⚡️ Build success in 1242ms
```

### 6.4 Playwright suite — `pnpm --filter @arcaai/med-ner test:e2e:chromium`

Full-suite (`test:e2e`) intentionally not run — only `chromium-1217` is installed locally (no `firefox`, no `webkit`); see §7 newly-discovered #2. Chromium-only is the apples-to-apples evidence for this fix:

```
[1/14] [chromium] › med-ner.e2e.spec.ts:29:3 › Browser Support Detection › should detect browser capabilities
  ✖ Test timeout of 120000ms exceeded.
    page.waitForFunction(() => (window as any).browserSupport !== undefined)
[2/14] [chromium] › med-ner.e2e.spec.ts:47:3 › Browser Support Detection › should show correct support status in UI
  ✓ pass (vacuous — asserts ≥1 .status-item exists; the static "Checking…" span satisfies it)
[3–12, 14/14] Entity Extraction / Statistics / Options / UI Responsiveness suites
  ⤵ skipped (beforeEach reads window.browserSupport; missing ⇒ test.skip)
[13/14] [chromium] › med-ner.e2e.spec.ts:305:3 › Sample Texts › should load sample text on button click
  ✖ Expected substring: "Diabetes" / Received: "Patient presents with severe chest pain…"

  2 failed
  11 skipped
  1 passed (2.1m)
```

**Interpretation.** The infra fix (B-1 + B-2) is verified end-to-end:

- The page IS reached (Playwright's accessibility snapshot in `test-results/.../error-context.md` shows the full DOM rendered — heading, sections, buttons, the default textarea text, the static "Checking…" span).
- The bundle IS fetched without a 404 (curl + COOP/COEP evidence above).

The remaining failures all stem from B-3 (see §7 newly-discovered #1): the bundle is fetched but its module-level `import` statements use bare specifiers that the browser cannot resolve at runtime, so the `<script type="module">` block in the fixture never finishes evaluating. No event handler binds, no `window.browserSupport` is set, no `log()` line is written — hence the timeout on test 1, the cascade of skips, and the default-textarea content in test 13.

### 6.5 Lint sweep of edited files

`ReadLints` on `e2e/serve.mjs`, `e2e/playwright.config.ts`, `e2e/fixtures/index.html`, `package.json`: only 8 *pre-existing* Microsoft-Edge-Tools warnings about inline `style="display:none"` attributes in `index.html` (lines 322, 325, 327, 354, 369, 377, 403, 412 — none of which were introduced or moved by this ticket). No new errors.

---

## 7. Deviations & Newly-Discovered Issues

### 7.1 Deviations from the locked plan

None. Two minor adjustments inside the plan envelope (both noted in §3):

- The webServer needed an explicit `cwd: '..'` because Playwright defaults `webServer.cwd` to the directory containing the config file (`e2e/`). The briefing pre-authorised "change `cwd` if needed".
- `use.baseURL` switched from `localhost` to `127.0.0.1` for parity with the server's bind host and to avoid IPv6/IPv4 DNS-resolution-order surprises on macOS. This is required for `webServer.url` readiness probing to match what tests actually hit.

### 7.2 Newly-discovered issues (logged only — not fixed, per STOP rule)

**B-3 — dist bundle ships bare-specifier ES-module imports (blocks worker-mode E2E).**

`packages/med-ner/dist/index.js` line 1–2:

```js
import { env, pipeline } from '@huggingface/transformers';
import { useState, useRef, useEffect, useCallback } from 'react';
```

Bare specifiers (`@huggingface/transformers`, `react`) cannot be resolved by a browser ES-module loader without an `<script type="importmap">` or a bundler step that rewrites them to URLs. When the fixture's `<script type="module">` block tries to import from `/dist/index.js`, the module fetch succeeds (200, correct MIME, correct COOP/COEP) but evaluation throws a `TypeError: Failed to resolve module specifier "@huggingface/transformers"`. The whole script block aborts, so:

- `getMedNERBrowserSupport()` is never called → `window.browserSupport` never set → spec #1 times out, specs #3–#12/#14 skip in `beforeEach`.
- Click handlers never bind → sample-text button click in spec #13 has no effect → the textarea retains its static default.

Fix candidates (all OUT OF SCOPE for TASK-281):

1. Add `noExternal: ['@huggingface/transformers', 'react']` to `packages/med-ner/tsup.config.ts` so the E2E build inlines these deps into a self-contained `dist/index.js` — but `tsup.config.ts` is explicitly off-limits for this ticket, and inlining would bloat the consumer bundle for non-E2E users.
2. Produce a separate, browser-ready bundle (e.g. `dist/e2e-bundle.js`) only for the fixture, via an esbuild or a tsup `entry` addition.
3. Add an `<script type="importmap">` to `e2e/fixtures/index.html` pointing each bare specifier at a CDN URL (`esm.sh`, `unpkg`, `jsdelivr`). Functional, but adds a network dependency to the E2E gate and requires picking versions that match the package's resolved peers — fragile.
4. Switch the fixture to load the SDK from a tiny Vite/esbuild dev-bundle started by `serve.mjs` itself. Largest delta.

Recommended follow-up ticket: **TASK-XXX (TBD — next available ≥ 283; TASK-282 is already taken by a parallel Wave-2A agent) — MedNER E2E browser-ready bundle**. Either (1) gated behind an `E2E=true` env on the existing `tsup.config.ts`, or (2) a second tsup entry that emits a fully-bundled `dist/e2e/index.js` + a matching `dist/e2e/workers/medner.worker.js`. The fixture then imports from `/dist/e2e/...` and the rest of TASK-281 keeps working unchanged.

**B-4 — Missing Playwright browsers locally (`firefox`, `webkit`).**

`~/Library/Caches/ms-playwright/` contains only `chromium-1208`, `chromium-1217`, `chromium_headless_shell-1208/1217`, and `ffmpeg-1011`. No `firefox-*` or `webkit-*`. `pnpm --filter @arcaai/med-ner test:e2e` (which fans out across all three projects) would fail with `Executable doesn't exist at ...firefox/firefox-***` / `...webkit/Playwright`. The briefing explicitly carves this out as a documented-only blocker.

Fix: `pnpm --filter @arcaai/med-ner exec playwright install firefox webkit` (or `playwright install --with-deps`) — needs a deliberate disk-space + bandwidth decision from the team (≈ 300 MB extra). Recommended follow-up ticket: **TASK-XXX (TBD — next available after the B-3 follow-up above) — Provision Playwright firefox/webkit on local dev machines** (or restrict the project list to `chromium` in CI / local until B-4 is resolved).

**B-5 — Deprecated `e2e/fixtures/serve.json`.**

Left in place per anti-pattern guidance ("do NOT delete the `serve.json` — leaving it in tree is harmless"). The new `serve.mjs` is the source of truth for the COOP/COEP headers. Recommended follow-up: delete `serve.json` and add a header in `serve.mjs`'s top-comment pointing to that file's removal, or repurpose `serve.json` as a documentation-only spec for what headers the wrapper sets. No functional impact either way.

### 7.3 Out-of-scope items observed but not touched

- `packages/med-ner/src/**` — left untouched (rule).
- `packages/med-ner/tsup.config.ts` — left untouched (rule). Would be the natural home for B-3's fix.
- `packages/med-ner/e2e/med-ner.e2e.spec.ts` — left untouched (write scope was prose-only for specs). Vacuous-pass case in §6.4 spec #2 could be hardened (e.g. wait for `window.browserSupport` first) but that is a separate ticket once B-3 lands.

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | Wave-1A synthesis | Placeholder created. Original numbering inside [TASK-277](../TASK-277-MedNER-Correctness/README.md) was TASK-279; renumbered to TASK-281 because TASK-279 is reserved for [R-05 ROLE_ENDPOINTS split](../TASK-279-ROLE-Endpoints-Split/README.md) and TASK-280 for [SimpleCrossTabSync HMAC SharedWorker](../TASK-280-CrossTab-HMAC-SharedWorker/README.md). |
| 2026-05-24 | Wave-2A Agent C1 (`fix/2605-review`) | Implemented `hybrid_wrapper`: added `packages/med-ner/e2e/serve.mjs`; updated `e2e/playwright.config.ts` (`webServer.command` / `cwd` / `url`, `use.baseURL`); flipped two fixture imports in `e2e/fixtures/index.html` to absolute paths; added `e2e:serve` script to `package.json`. Verified B-1 + B-2 fixed via manual `curl -I` (COOP/COEP on every route, 200 on `/dist/...` and `/dist/workers/...`, 302 on `/` → `/e2e/fixtures/index.html`). 143/143 unit tests pass, lint clean, build clean. `test:e2e:chromium` no longer 404s; 2 failures + 11 skips trace to a separate fixture/bundle-shape bug B-3 (bare-specifier module imports). Logged B-3, B-4 (missing firefox/webkit browsers), and B-5 (deprecated `serve.json`) in §7 as out-of-scope follow-ups; status → Completed. |
