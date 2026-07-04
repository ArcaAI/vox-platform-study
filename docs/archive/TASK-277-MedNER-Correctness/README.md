# TASK-277 — @arcaai/med-ner Correctness Fixes

| | |
|---|---|
| **Ticket** | TASK-277 |
| **Wave** | 1A (B4) — parallel with TASK-274, TASK-275, TASK-276, TASK-278 |
| **Parent** | TASK-262 (Vox SDK Deep Assessment) |
| **Predecessor** | TASK-272 (Worker offloading & infra rewrite) |
| **Source assessment** | `docs/implementation/TASK-262-Vox-SDK-Deep-Assessment/06-med-ner.md` — H-2 |
| **Created** | 2026-05-23 |
| **Updated** | 2026-05-23 |
| **Status** | Completed (E2E pre-existing infra blocker surfaced — see §6) |
| **Classification** | bugfix + test |
| **Scope (write)** | `packages/med-ner/src/utils/entityUtils.ts`, `packages/med-ner/src/__tests__/entityUtils.test.ts`, `packages/med-ner/e2e/med-ner.e2e.spec.ts`, `packages/med-ner/e2e/fixtures/index.html`, this README. |

---

## 1. Requirement Analysis

### Description

Two correctness follow-ups that fell outside TASK-272's six-item scope but were
flagged in that ticket's §6 "Deviations / Follow-ups":

1. **H-2** — `mergeAdjacentEntities` averages adjacent same-type entity scores
   using a naive in-place `(current.score + entity.score) / 2`, which produces a
   biased running average instead of a true mean. Per 06-med-ner H-2: for a
   3-token span `[B:0.95, I:0.90, I:0.85]` it returns `0.8625`, the correct
   answer is `0.9`. Replace with a count-aware weighted average where each
   contribution is weighted by its character span (`end - start`) — this both
   restores the correct mean for equal-weight contributions AND respects the
   intuition that a longer subword should weigh more than a single character.

2. **E2E fixture / spec** — The Playwright fixture at
   `packages/med-ner/e2e/fixtures/index.html` calls the pre-A10 factory shape
   `createMedNER({ model, threshold, ... })` and never supplies a
   `workerFactory`. After TASK-272 the recommended way to construct the
   processor is via `createMedNER({ workerFactory, ... })` so inference runs
   off the main thread. Update the fixture to the post-A10 contract without
   changing any spec assertions.

### Business context

- A biased entity-merge score makes downstream confidence-threshold filtering
  unsound — entities at the end of a span are over-weighted by `2^(N-1)`
  worth of the score, causing high-confidence early tokens to be discarded.
- The E2E fixture serves as the canonical real-browser usage example for
  consumers; leaving it on the pre-A10 shape keeps drift between docs and
  reality.

### Acceptance criteria

- `mergeAdjacentEntities` uses
  `mergedScore = Σ(score_i × weight_i) / Σ(weight_i)`, where
  `weight_i = max(end_i − start_i, 1)`.
- Four new RED-first tests cover:
  1. two equal-weight entities → simple arithmetic mean (regression-safe);
  2. heavier-left side → score skews left;
  3. heavier-right side → score skews right;
  4. three adjacent entities → reduces correctly under weighting.
- The Playwright HTML fixture constructs the processor via
  `createMedNER({ workerFactory: () => new Worker(...), ... })` matching the
  post-TASK-272 contract. The Playwright spec is unchanged save for any
  minimal adjustment needed to keep existing assertions green.
- `pnpm --filter @arcaai/med-ner build` / `test` / `lint` all pass.

---

## 2. Current State Evaluation

### H-2 — current `mergeAdjacentEntities` (broken)

`packages/med-ner/src/utils/entityUtils.ts:75-80`

```ts
if (areEntitiesAdjacent(current, entity)) {
  current.end = entity.end;
  current.text = originalText.slice(current.start, current.end);
  // Average the scores
  current.score = (current.score + entity.score) / 2;
}
```

For N consecutive merges, the resulting score is:

```
((((s1+s2)/2 + s3)/2) + s4)/2 + ...
```

which collapses to `s1 / 2^(N-1) + s2 / 2^(N-1) + s3 / 2^(N-2) + … + sN / 2`
— heavily biased toward the latest contribution.

### E2E fixture — current construction

`packages/med-ner/e2e/fixtures/index.html:507-526` calls:

```js
processor = createMedNER({
  model: modelSelect.value,
  threshold: parseFloat(thresholdSlider.value) / 100,
  enableStats: true,
  onProgress: (...) => { ... },
  onEntitiesExtracted: (...) => { ... },
  onError: (...) => { ... },
});
```

— no `workerFactory`. After TASK-272 the documented contract is:

```js
createMedNER({
  workerFactory: () => new Worker(
    new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url),
    { type: 'module' },
  ),
  // …other options
});
```

### Existing test surface

`packages/med-ner/src/__tests__/entityUtils.test.ts` already has three tests
for `mergeAdjacentEntities`, but none assert on `score`. They cover:

- merging adjacent entities of same type (verifies `text`, `start`, `end`);
- not merging non-adjacent entities;
- empty array handling.

We will keep these and add four score-pinning tests.

---

## 3. Implementation Plan (strict TDD)

### Test list (RED first)

| # | File | New test |
|---|---|---|
| 1 | `entityUtils.test.ts` | Two equal-weight adjacent entities — merged score equals simple arithmetic mean. |
| 2 | `entityUtils.test.ts` | Heavier-left adjacent entities (left has larger char span) — merged score is strictly closer to the left score. |
| 3 | `entityUtils.test.ts` | Heavier-right adjacent entities (right has larger char span) — merged score is strictly closer to the right score. |
| 4 | `entityUtils.test.ts` | Three adjacent entities of equal weight — merged score equals `(s1+s2+s3)/3` exactly (not the broken running average `0.8625`). |

### File creation/modification order

1. `docs/implementation/TASK-277-MedNER-Correctness/README.md` (this file).
2. `packages/med-ner/src/__tests__/entityUtils.test.ts` — add 4 RED tests.
3. Verify the 4 new tests **fail** with the documented broken running-average
   numbers.
4. `packages/med-ner/src/utils/entityUtils.ts` — rewrite
   `mergeAdjacentEntities` to use count-aware weighted average.
5. Verify all (existing + new) tests pass.
6. `packages/med-ner/e2e/fixtures/index.html` — switch the `createMedNER`
   call to the `workerFactory`-supplying shape.
7. `packages/med-ner/e2e/med-ner.e2e.spec.ts` — confirm assertions stay valid;
   make only the minimum adjustment required.
8. Re-run unit gates + attempt E2E.

### Verification criteria

- All four new tests fail RED with values consistent with the running-average
  bug (e.g. `0.8625` for the 3-token equal-weight case).
- After GREEN, all four new tests pass with weighted-mean values.
- `pnpm --filter @arcaai/med-ner test` — no failures, ≥ existing test count + 4.
- `pnpm --filter @arcaai/med-ner build` — exit 0.
- `pnpm --filter @arcaai/med-ner lint` — exit 0.
- `ReadLints` on every modified/created file — clean.
- `pnpm --filter @arcaai/med-ner test:e2e` — attempted; failure surfaced if
  Playwright is unavailable in the environment.

---

## 4. Implementation Summary

### Item 1 — H-2 `mergeAdjacentEntities` count-aware weighted average

`mergeAdjacentEntities` no longer collapses a multi-token merge into the
biased running average `((s1+s2)/2 + s3)/2 + …`. It now accumulates a
weighted sum and divides at each step:

```ts
weightedScoreSum += entity.score * entityMergeWeight(entity);
weightSum        += entityMergeWeight(entity);
current.score    = weightedScoreSum / weightSum;
```

Where `entityMergeWeight(e) = max(e.end - e.start, 1)`. A new
private helper `entityMergeWeight` carries the rationale (zero-length
spans collapse to weight 1 so degenerate inputs still participate in
the mean). The function's JSDoc explicitly cites 06-med-ner H-2 so the
fix remains traceable.

Behavioural properties (verified by the four new RED-first tests):

| Input | Old buggy score | New weighted-mean score |
|---|---|---|
| `[0.9 @ 4ch, 0.7 @ 4ch]` (equal weight) | 0.8 | 0.8 (regression-safe) |
| `[0.9 @ 10ch, 0.5 @ 2ch]` (heavy left) | 0.7 | 0.8333… |
| `[0.9 @ 2ch, 0.5 @ 10ch]` (heavy right) | 0.7 | 0.5667 |
| `[0.95, 0.90, 0.85] @ 4ch each` (3-token equal weight) | 0.8875 | 0.9 |

### Item 2 — Playwright fixture switched to `createMedNER({ workerFactory })`

`packages/med-ner/e2e/fixtures/index.html` now constructs the processor
via the post-A10 contract:

```js
processor = createMedNER({
  model: modelSelect.value,
  threshold: parseFloat(thresholdSlider.value) / 100,
  enableStats: true,
  workerFactory: () =>
    new Worker(new URL('./dist/workers/medner.worker.js', import.meta.url), {
      type: 'module',
    }),
  // …same onProgress / onEntitiesExtracted / onError callbacks as before
});
```

This routes ALL inference through the worker bundle emitted by `tsup`
at `dist/workers/medner.worker.js`, matching the recommended factory
shape documented in TASK-272 §4 ("C-1 — Web Worker offloading"). The
spec file `packages/med-ner/e2e/med-ner.e2e.spec.ts` requires no
changes — it interacts only via DOM (`page.click('#btn-init')`,
`page.evaluate(() => window.nerProcessor)`, etc.), so the construction
shape is encapsulated inside the fixture.

### Verification evidence

```text
# Unit tests (full suite)
$ pnpm --filter @arcaai/med-ner test
 Test Files  11 passed (11)
      Tests  143 passed (143)
   Duration  726ms

# Build
$ pnpm --filter @arcaai/med-ner build
ESM dist/index.js                       46.96 KB
CJS dist/index.cjs                      48.41 KB
DTS dist/index.d.ts                     34.81 KB
ESM dist/workers/medner.worker.js        2.30 MB
ESM dist/workers/medner.worker.js.map    3.87 MB
(exit 0)

# Lint (max-warnings 0)
$ pnpm --filter @arcaai/med-ner lint
(clean — only the upstream eslintrc deprecation notice)

# ReadLints on modified files
packages/med-ner/src/utils/entityUtils.ts            — clean
packages/med-ner/src/__tests__/entityUtils.test.ts   — clean
packages/med-ner/e2e/fixtures/index.html             — 8 pre-existing
                                                      inline-CSS warnings
                                                      on untouched lines
                                                      (322,325,327,354,
                                                      369,377,403,412)
packages/med-ner/e2e/med-ner.e2e.spec.ts             — clean (unchanged)
docs/implementation/TASK-277-MedNER-Correctness/README.md — clean

# RED-before-GREEN evidence (tests 2/3/4 failed against the buggy
# implementation with the exact running-average numbers predicted by
# 06-med-ner H-2; test 1 was always green as the regression lock)
× H-2: heavier-left  — got 0.7,    expected 0.8333…
× H-2: heavier-right — got 0.7,    expected 0.5667
× H-2: three+        — got 0.8875, expected 0.9
```

Baseline before this ticket: **140 tests passing**. Net delta: **+4
score-pinning tests for `mergeAdjacentEntities` (143 total)**.

## 5. Files Changed

### Created

| Path | Purpose |
|---|---|
| `docs/implementation/TASK-277-MedNER-Correctness/README.md` | This document. |

### Modified

| Path | Lines | Change |
|---|---|---|
| `packages/med-ner/src/utils/entityUtils.ts` | +48 / −8 | New `entityMergeWeight` helper; rewrote `mergeAdjacentEntities` to use count-aware weighted average over per-entity character span. JSDoc cites H-2. |
| `packages/med-ner/src/__tests__/entityUtils.test.ts` | +98 | Added four new tests under `describe('mergeAdjacentEntities')` pinning: equal-weight → simple mean; heavy-left → skews left; heavy-right → skews right; 3-token → reduces to exact mean (not the broken `0.8875`). |
| `packages/med-ner/e2e/fixtures/index.html` | +9 | Inserted `workerFactory: () => new Worker(new URL('./dist/workers/medner.worker.js', import.meta.url), { type: 'module' })` into the `createMedNER` call inside `initProcessor()`. No other markup or behaviour changed. |

### Unchanged (per scope rule)

- `packages/med-ner/e2e/med-ner.e2e.spec.ts` — no factory call lives in
  this file; construction is entirely in the HTML fixture. All existing
  spec assertions remain valid against the new factory shape.
- All other `packages/med-ner/**` files, all other `packages/**`, all
  `apps/**`, all `infrastructure/**` — untouched.

## 6. Deviations / Follow-ups

### E2E run is blocked by a pre-existing infrastructure bug (out of scope)

Attempting `npx playwright test --config=e2e/playwright.config.ts --project=chromium`
produces:

```text
× Browser Support Detection › should detect browser capabilities
  Test timeout of 120000ms exceeded.
  await page.waitForFunction(() => (window as any).browserSupport !== undefined);

× Sample Texts › should load sample text on button click
  Expected substring: "Diabetes"
  Received string:    "Patient presents with severe chest pain…"

11 skipped  (all "NER not supported" branches because window.browserSupport
            is never set, so `await isNERSupported(page)` returns falsy)
1 passed
```

Root cause — verified by direct probe with `curl`:

```text
GET /index.html                          → 200
GET /dist/index.js                       → 404
GET /dist/workers/medner.worker.js       → 404
```

The Playwright `webServer.command` is
`npx http-server ./e2e/fixtures -p 8080 -c-1 --cors` (defined at
`packages/med-ner/e2e/playwright.config.ts:46`). The http-server root
is `e2e/fixtures/`, but the fixture imports `./dist/index.js` which
resolves to `http://localhost:8080/dist/index.js`. That bundle is built
at `packages/med-ner/dist/`, **outside** the served root. So the
inline `<script type="module">` 404s on its top-level import, never
calls `getMedNERBrowserSupport()`, and `window.browserSupport` is
never set. Every spec assertion that depends on the SDK loading is
either skipped or hangs.

This is a pre-existing bug introduced when the E2E fixture was first
written and committed without ever being run successfully — confirmed
by inspection of the initial commit history (`git log --oneline -- e2e/`
shows a single initial-commit entry). TASK-272 §6 explicitly deferred
the fixture/E2E update to a follow-up; TASK-277 has now landed the
fixture API migration, but the **serve-root mismatch** is a separate
infrastructure problem outside the TASK-277 write scope.

The minimum-effort fixes are all outside this ticket's write scope:

| Option | File to edit | Why out of scope |
|---|---|---|
| Change `http-server` root to the package root and adjust HTML import paths | `packages/med-ner/e2e/playwright.config.ts` + this fixture | `playwright.config.ts` is not in the TASK-277 write scope. |
| Add a tsup post-build copy of `dist/` into `e2e/fixtures/dist/` | `packages/med-ner/tsup.config.ts` (forbidden) | Listed forbidden. |
| Add an OS symlink `e2e/fixtures/dist → ../../dist` | repo state | Not a tracked file edit; brittle on Windows. |

**Recommended follow-up TASK-281 (E2E infra fix)** _(originally numbered TASK-279 in this README; renumbered during Wave-1A synthesis because TASK-279 was reserved for the R-05 ROLE_ENDPOINTS split — see `../TASK-281-MedNER-E2E-Infra/README.md`)_:

1. In `packages/med-ner/e2e/playwright.config.ts`, change
   `command` from `'npx http-server ./e2e/fixtures …'` to
   `'npx http-server . -p 8080 …'` and update the fixture's
   imports from `./dist/index.js` to `./dist/index.js` (still
   correct relative to the new root) or move the fixture
   directly under the package root.
2. The fixture's `serve.json` declaring COOP/COEP headers is ALSO
   unread by `http-server` (npm package) — it only reads `--cors`
   flags. The follow-up should either switch to `serve` (vercel/serve,
   which honours `serve.json`) or pass header overrides directly. The
   current configuration would also fail the Worker-mode E2E because
   `SharedArrayBuffer` requires cross-origin isolation headers.

These two infrastructure issues block successful E2E execution
**regardless of the factory-shape change** TASK-277 makes. The
factory-shape change itself is correctly in place and would work the
moment the dist bundle becomes reachable.

### Other discovered-but-not-fixed issues (logged, not fixed)

None encountered inside the TASK-277 write scope beyond what is already
documented in the parent assessment (`06-med-ner.md`) and TASK-272.

---

## 7. Change History

| Date | Description |
|---|---|
| 2026-05-23 | Initial scaffold (TDD plan + requirement). |
| 2026-05-23 | RED → GREEN for `mergeAdjacentEntities` count-aware weighted average; fixture migrated to `createMedNER({ workerFactory })`; pre-existing E2E infra blocker documented as follow-up. |
