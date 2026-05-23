# TASK-281 — `@arcaai/med-ner` Playwright E2E Infrastructure Fix

| Field | Value |
|---|---|
| Ticket | TASK-281 |
| Short name | MedNER-E2E-Infra |
| Created | 2026-05-23 |
| Updated | 2026-05-23 |
| Status | Pending (placeholder — open for implementer) |
| Parent | [TASK-262 — Vox SDK Deep Assessment](../TASK-262-Vox-SDK-Deep-Assessment/README.md) |
| Sibling | [TASK-277 — MedNER Correctness Fixes](../TASK-277-MedNER-Correctness/README.md) (discovered this issue while updating the E2E fixture API) |

---

## 1. Requirement Analysis

### 1.1 Description

`@arcaai/med-ner` ships a Playwright E2E suite at `packages/med-ner/e2e/`. The fixture HTML, factory wiring, and specs are correct (TASK-272 wrote them; TASK-277 migrated the fixture to the new `createMedNER({ workerFactory })` shape). However the suite **cannot currently execute end-to-end** because of two pre-existing infrastructure bugs in the test webserver layer.

### 1.2 The two infrastructure bugs

**B-1 — `http-server` root excludes `dist/`**

`packages/med-ner/e2e/playwright.config.ts:46` (approximate line) launches:

```
npx http-server ./e2e/fixtures -p 8080 -c-1 --cors
```

The serve root is `packages/med-ner/e2e/fixtures/`. The fixture HTML imports `./dist/index.js` and `./dist/workers/medner.worker.js`. `tsup` writes those bundles to `packages/med-ner/dist/`, which is **outside** the serve root. Every fixture import 404s, the SDK is never loaded, and every spec assertion that depends on `window.browserSupport` either hangs or silently passes vacuously.

**B-2 — `serve.json` headers are silently ignored**

The fixture ships a `serve.json` declaring the COOP/COEP headers required for `SharedArrayBuffer` (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`). The `http-server` npm package is **not** Vercel's `serve` and does NOT read `serve.json` — it only honours its own CLI flags (`--cors`, `-c-1`, etc.). The result: even if B-1 were fixed, the Worker-mode E2E would fail because `SharedArrayBuffer` is unavailable without cross-origin isolation.

### 1.3 Acceptance criteria

1. `pnpm --filter @arcaai/med-ner test:e2e` exits 0 with at least one spec actually exercising the bundled SDK + worker (no vacuous passes).
2. The webserver serving the fixture honours COOP/COEP so `SharedArrayBuffer` is available inside the page.
3. No regression to `packages/med-ner/src/**` or any other package's tests/build/lint.

---

## 2. Current State Evaluation

| Aspect | State |
|---|---|
| Fixture HTML | Correct shape (TASK-277 verified) — calls `createMedNER({ workerFactory })` against the new API |
| Specs | Correct shape (TASK-272 wrote them) |
| Bundles | `packages/med-ner/dist/index.js`, `packages/med-ner/dist/workers/medner.worker.js` build cleanly |
| Webserver root | `e2e/fixtures/` — wrong (excludes `dist/`) |
| Webserver headers | Default `http-server` headers — no COOP/COEP |
| Suite history | Initial commit only; never run successfully (`git log --oneline -- packages/med-ner/e2e/`) |

---

## 3. Implementation Plan (Pending)

Two reasonable approaches — author should pick one and document the choice:

### Option A — Move serve root, keep `http-server`

1. Edit `packages/med-ner/e2e/playwright.config.ts`:
   - `command`: change `npx http-server ./e2e/fixtures -p 8080 -c-1 --cors` to `npx http-server . -p 8080 -c-1 --cors -- --header "Cross-Origin-Opener-Policy: same-origin" --header "Cross-Origin-Embedder-Policy: require-corp"` _(verify the actual `http-server` CLI supports inline headers in the installed major; the v14 CLI does not — see Option B)_.
   - `cwd`: ensure it points at the package root, not the fixture dir.
2. Update the fixture's import paths in `e2e/fixtures/index.html` from `./dist/index.js` to `/e2e/fixtures/...` or to the `dist/` path relative to the new root.
3. If the installed `http-server` cannot inject COOP/COEP headers, switch to Option B.

### Option B — Replace `http-server` with `@vercel/serve`

`@vercel/serve` honours `serve.json` natively. Smallest patch:

1. Add `serve` (or `@vercel/serve`) as a `devDependency` of `@arcaai/med-ner` (verify the lockfile policy with the team — package mgmt rules forbid drive-by adds; should be discussed before landing).
2. Update `playwright.config.ts.command` to `npx serve -l 8080 .`.
3. Move or copy `serve.json` so its sibling-of-the-served-root semantics resolve (it must be in the directory `serve` is invoked from).
4. Verify COOP/COEP headers are sent by curling `http://localhost:8080/e2e/fixtures/index.html` in a manual smoke test before running Playwright.

### Option C — Generate a tiny custom Node webserver

A 30-line `e2e/serve.mjs` using `node:http` that serves the package root with the right headers and the right MIME types. No new dependency. Most explicit. Recommended if the team is dependency-averse.

---

## 4. Implementation Summary

_To be filled by the implementer._

---

## 5. Files Changed

_To be filled. Likely candidates:_

| File | Change |
|---|---|
| `packages/med-ner/e2e/playwright.config.ts` | Update `command`, `cwd`, possibly `webServer` block |
| `packages/med-ner/e2e/fixtures/index.html` | Adjust import paths if root changes |
| `packages/med-ner/e2e/serve.json` | Possibly relocate or replace |
| `packages/med-ner/e2e/serve.mjs` (new, Option C) | Custom Node webserver |
| `packages/med-ner/package.json` | (Option B only) — `serve` devDependency, after team approval |

---

## 6. Verification

_To be captured: `pnpm --filter @arcaai/med-ner test:e2e` actual output, plus a manual `curl -I` showing COOP/COEP headers on the fixture URL._

---

## 7. Deviations & Newly-Discovered Issues

_To be filled._

---

## 8. Change History

| Date | Author | Notes |
|---|---|---|
| 2026-05-23 | Wave-1A synthesis | Placeholder created. Original numbering inside [TASK-277](../TASK-277-MedNER-Correctness/README.md) was TASK-279; renumbered to TASK-281 because TASK-279 is reserved for [R-05 ROLE_ENDPOINTS split](../TASK-279-ROLE-Endpoints-Split/README.md) and TASK-280 for [SimpleCrossTabSync HMAC SharedWorker](../TASK-280-CrossTab-HMAC-SharedWorker/README.md). |
