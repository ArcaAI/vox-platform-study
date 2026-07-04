# TASK-272 — @arcaai/med-ner Worker Offloading & Correctness

| | |
|---|---|
| **Ticket** | TASK-272 |
| **Parent** | TASK-262 (Vox SDK Deep Assessment) |
| **Source assessment** | `docs/implementation/TASK-262-Vox-SDK-Deep-Assessment/06-med-ner.md` |
| **Created** | 2026-05-23 |
| **Updated** | 2026-05-23 |
| **Status** | Completed |
| **Classification** | bugfix + refactor + security |
| **Scope (write)** | `packages/med-ner/**` only |

---

## 1. Requirement Analysis

### Description

The 06-med-ner assessment under TASK-262 identified six concrete defects in
`@arcaai/med-ner` that block production-readiness. This ticket addresses each
of them with strict TDD inside the package boundary.

### Items

| ID | Title | Severity |
|---|---|---|
| C-1 | Web Worker offloading (off-main-thread inference) | Critical |
| C-2 | Token-aware chunking instead of character windows | Critical |
| H-1 | WebGPU detection + WASM fallback | High |
| H-6 | Pass `aggregation_strategy: 'simple'` to pipeline | High |
| R-12 | Pin HuggingFace model `revision` | Security/Recommendation |
| M-3 | `escapeHtml` for `highlightEntities` (XSS) | Medium |

### Business context

`@arcaai/med-ner` runs a BERT-base token classifier directly in the browser.
Without these fixes, the SDK (a) freezes the UI for hundreds of milliseconds
per inference, (b) silently mis-classifies long inputs (mid-word tokenizer
breaks), (c) cannot benefit from WebGPU on modern Chrome/Edge, (d) returns
BIO subword fragments instead of merged entities, (e) silently follows
moving HF Hub branches, and (f) is XSS-susceptible when rendering entity
highlights for clinical text containing `<`, `>`, `&`, `"`, `'`.

### Acceptance criteria

- Inference for `MedNERProcessor.extract()` is dispatched to a dedicated
  Web Worker; the public Promise-based API is unchanged.
- Long input is chunked on sentence boundaries with a token budget
  (default 384, stride 64). Entities are merged across chunks without
  cutting words.
- The processor probes `navigator.gpu`; if WebGPU is available the
  pipeline is created with `device: 'webgpu'`, otherwise `'wasm'`. The
  chosen device is exposed via `getActiveDevice()` and logged.
- The HF pipeline is invoked with `aggregation_strategy: 'simple'`.
- Each entry in `MODEL_MAP` carries an explicit `revision` SHA that is
  forwarded to `pipeline()`.
- `highlightEntities` HTML-escapes every dynamic substring it emits.
- `pnpm --filter @arcaai/med-ner test` / `build` / `lint` all pass.
- `pnpm --filter @arcaai/vox build` continues to succeed (smoke check).

---

## 2. Current State Evaluation

### File map (before)

```
packages/med-ner/src/
├── index.ts
├── hooks/{useMedNER.ts, index.ts}
├── processors/{MedNERProcessor.ts, index.ts}
├── types/index.ts
├── utils/{browserSupport.ts, entityUtils.ts, index.ts}
└── __tests__/{MedNERProcessor.test.ts, useMedNER.test.ts,
              entityUtils.test.ts, browserSupport.test.ts, types.test.ts}
```

### Baseline gates (captured prior to changes)

- `pnpm --filter @arcaai/med-ner test` → 5 files, **92 tests passing**.
- `pnpm --filter @arcaai/med-ner lint` → clean (max-warnings 0).
- `pnpm --filter @arcaai/med-ner build` → ESM + CJS + d.ts emitted.

### Relevant prior art in the repo

- `packages/stt/src/workers/whisper.worker.ts` &
  `packages/stt/src/engines/WhisperWorkerEngine.ts` — established Worker
  protocol with correlation IDs, WebGPU/WASM detection + fallback, and
  ONNX backend configuration inside the worker. The same shape is used
  here so the SDK has one consistent worker idiom.

### HuggingFace revision SHAs (looked up against HF Hub API)

| Preset | Model id | `revision` SHA | Last modified |
|---|---|---|---|
| `default` | `Xenova/bert-base-NER` | `24c7e5aba9ae350923357a6f0b92571be34037ec` | 2025-07-11 |
| `biomedical` | `Kushtrim/bert-base-cased-biomedical-ner` | `52d842d49d18b95bc7ce6d78e95367ce94004c49` | 2025-04-06 |
| `clinical` | `samrawal/bert-base-uncased_clinical-ner` | `5db48a44e7e04d9b0e95b8209c0e4b0f4c29cc6d` | 2022-11-11 |

How to bump a pinned revision is documented in §6 of this README.

---

## 3. Implementation Plan (TDD)

Order is chosen so each item is a small, independently verifiable change
that does not break the previous one.

### Test list (RED first, per item)

| # | Item | New test(s) |
|---|---|---|
| 1 | H-6 aggregation_strategy | `MedNERProcessor.test.ts` — assert `pipeline` is invoked with `aggregation_strategy: 'simple'`; assert post-processed output for non-BIO tokens (e.g. `{ entity_group: 'Disease' }`) succeeds and does not pass through BIO labels. |
| 2 | R-12 revision pin | `types.test.ts` — assert each `MODEL_MAP` entry exposes the expected `{ id, revision }` shape with the pinned SHA. `MedNERProcessor.test.ts` — assert `pipeline()` receives the `revision` option. |
| 3 | M-3 escapeHtml | New `htmlEscape.test.ts` — `escapeHtml` maps `& < > " '` to entities. Update `entityUtils.test.ts` — `highlightEntities` on input containing `<script>` produces `&lt;script&gt;` and not a raw element. |
| 4 | H-1 WebGPU detection | New `webgpu.test.ts` — `getRecommendedDevice` returns `'webgpu'` when `navigator.gpu.requestAdapter()` resolves to an adapter, `'wasm'` otherwise. `MedNERProcessor.test.ts` — exposes `getActiveDevice()` and surfaces it on init. |
| 5 | C-2 token-aware chunking | New `chunking.test.ts` — `chunkByTokens` splits at sentence boundaries, respects the 384-token cap and the 64-token stride; entities discovered across two chunks have monotonically increasing offsets and the merged span is not cut mid-word. |
| 6 | C-1 worker offloading | New `workerClient.test.ts` — `MedNERWorkerClient` posts `{ type: 'init' \| 'extract' \| 'destroy', id }`, resolves the matching response, and never touches the main-thread `@huggingface/transformers` pipeline (assert via vi.mock). `MedNERProcessor.test.ts` — when a Worker is supplied (or constructible) the processor delegates inference to it; promise API is preserved. |

### File creation/modification order

```
1. src/utils/htmlEscape.ts                          (NEW)
2. src/utils/entityUtils.ts                         (use escapeHtml)
3. src/utils/index.ts                               (export escapeHtml)
4. src/types/index.ts                               (MODEL_MAP shape, revision field, augment MedNERBrowserSupport with device, public Device type)
5. src/utils/browserSupport.ts                      (getRecommendedDevice, hasWebGPUSupport)
6. src/utils/chunking.ts                            (NEW: chunkByTokens, mergeChunkEntities)
7. src/utils/index.ts                               (export new utils)
8. src/workers/medner.worker.ts                     (NEW: worker entry)
9. src/workers/workerClient.ts                      (NEW: MedNERWorkerClient main-thread side)
10. src/workers/index.ts                            (NEW: barrel)
11. src/processors/MedNERProcessor.ts               (integrate worker + new options)
12. src/index.ts                                    (export new public surface)
13. tsup.config.ts                                  (add worker entry bundle)
14. src/__tests__/htmlEscape.test.ts                (NEW)
15. src/__tests__/webgpu.test.ts                    (NEW)
16. src/__tests__/chunking.test.ts                  (NEW)
17. src/__tests__/workerClient.test.ts              (NEW)
18. src/__tests__/MedNERProcessor.test.ts           (extend)
19. src/__tests__/entityUtils.test.ts               (extend)
20. src/__tests__/types.test.ts                     (extend for revision)
21. src/__tests__/browserSupport.test.ts            (extend)
```

### Verification criteria

- All new RED tests fail with a clear mismatch before the implementation
  step.
- `pnpm --filter @arcaai/med-ner test` finishes with **at least 92 + new
  tests passing, no failures**.
- `pnpm --filter @arcaai/med-ner build` produces both the main `dist/index.{js,cjs}` bundle and a worker bundle `dist/workers/medner.worker.js`.
- `pnpm --filter @arcaai/med-ner lint` is clean.
- `pnpm --filter @arcaai/vox build` still succeeds.
- `ReadLints` on every modified/new file returns no diagnostics.

---

## 4. Implementation Summary

All six items landed with strict TDD (RED → GREEN per item). Behaviour
changes are summarised below; see §5 for the file-level inventory.

### H-6 — `aggregation_strategy: 'simple'`

`MedNERProcessor.init()` now always invokes
`pipeline('token-classification', id, { ..., aggregation_strategy: 'simple' })`.
A new `normaliseRawResult` helper in the processor (and a mirror in the
worker) understands both the new aggregated shape
`{ entity_group, word, score, start, end }` and the legacy BIO shape
`{ entity, word, score, index, start, end }`, so the package keeps working
if a future model presets `aggregation_strategy: 'none'`.

### R-12 — Pinned `revision`

`MODEL_MAP` was retyped from `Record<string, string>` to
`Record<string, ModelReference>` where each entry carries the model id
plus a 40-char hex commit SHA fetched from the HF Hub API on 2026-05-23.
The pinned SHA is forwarded to `pipeline(..., { revision })`. Custom HF
ids supplied by users that are NOT preset names get an empty revision
(no pin), as documented on the option.

The procedure to bump a revision is in §6.

### M-3 — `escapeHtml` for `highlightEntities`

Added `escapeHtml(str)` in `src/utils/htmlEscape.ts`, exported from the
package barrel. Rewrote `highlightEntities` to walk entities in source
order and HTML-escape every dynamic substring (literal text, entity
body, class prefix, type, score) before concatenating. The new
implementation also short-circuits on out-of-order overlapping entities
(which `mergeOverlappingEntities` is responsible for collapsing) to
prevent nested/malformed spans.

### H-1 — WebGPU detection + fallback

`isWebGPUSupported()` checks `'gpu' in navigator`.
`getRecommendedDevice()` additionally calls `navigator.gpu.requestAdapter()`
and returns `'webgpu'` only when an adapter resolves; in every other
branch (no `navigator`, no `.gpu`, null adapter, thrown error) it returns
`'wasm'`. `MedNERProcessor.init()` awaits `getRecommendedDevice()`,
forwards the result as `device:` to `pipeline()`, exposes it on a new
`getActiveDevice()` accessor, and logs it via `console.info`. The
`MedNERBrowserSupport` type gains a `webGPU: boolean` flag.

### C-2 — Token-aware chunking

A new pure utility `src/utils/chunking.ts` exports `segmentSentences`,
`chunkByTokens(text, tokenizer, { maxTokens=384, stride=64 })`, and
`mergeChunkEntities`. Chunking is sentence-aware (regex
`/[.!?]+\s+/`) so words are never cut mid-token. The chunker accepts any
tokenizer with the signature `(text) => ArrayLike` — the processor
adapts the model's `pipeline.tokenizer` (`BatchEncoding.input_ids` or
`.data`) into that signature in `buildTokenizer`. The legacy
`maxLength`/`chunkOverlap` options are kept for backward compat but
documented as deprecated in favour of `maxTokens`/`stride`. Long inputs
trigger chunked extraction; per-chunk entity offsets are re-baked into
absolute document offsets before `mergeChunkEntities` deduplicates
detections at chunk boundaries via highest-score wins.

### C-1 — Web Worker offloading

A new `src/workers/medner.worker.ts` runs the entire NER lifecycle
inside a Web Worker — pipeline loading, tokenisation, chunking,
inference, and post-processing. It implements a Promise/correlation-id
protocol with the main-thread counterpart
`src/workers/workerClient.ts` (`MedNERWorkerClient`). Messages:

- `main → worker`: `init`, `extract`, `destroy`
- `worker → main`: `ready`, `progress`, `result`, `error`

`MedNERProcessor` gains an optional `workerFactory: () => Worker`
option. When provided, the processor builds a `MedNERWorkerClient`
during `init()` and routes ALL inference through it. Crucially the
main-thread `MedNERProcessor` module no longer needs to `import { pipeline }`
at runtime in that path — the worker bundle imports it. The new
`MedNERProcessor.worker.test.ts` asserts the main-thread
`@huggingface/transformers` pipeline mock is **never** invoked when a
worker is supplied, evidencing off-main-thread execution.

The worker bundle is emitted as a standalone ESM file at
`dist/workers/medner.worker.js` by a second `tsup` entry and exposed via
the new `./worker` subpath in `package.json`. Recommended consumer
factory:

```ts
createMedNER({
  workerFactory: () => new Worker(
    new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url),
    { type: 'module' },
  ),
});
```

When `workerFactory` is omitted the processor keeps the original main-
thread fallback — appropriate for SSR, jsdom, and environments without
`Worker` support.

### Verification evidence

```text
# Tests
$ pnpm --filter @arcaai/med-ner test
 Test Files  11 passed (11)
      Tests  139 passed (139)

# Lint (max-warnings 0)
$ pnpm --filter @arcaai/med-ner lint
(clean, only the eslintrc deprecation warning from upstream config)

# Build
$ pnpm --filter @arcaai/med-ner build
CJS dist/index.cjs                    47.90 KB
ESM dist/index.js                     46.45 KB
DTS dist/index.d.ts                   34.12 KB
ESM dist/workers/medner.worker.js      2.30 MB

# Vox smoke
$ pnpm --filter @arcaai/vox build
CJS dist/index.js     5.40 MB    ESM dist/index.mjs   5.39 MB
CJS dist/plugins.js   5.08 MB    ESM dist/plugins.mjs 5.08 MB
(all four entries build successfully)

# ReadLints over every modified/new file
No linter errors found.
```

Baseline before this ticket: **92 tests passing**. Net delta: **+47 tests
(139 total)**.

## 5. Files Changed

### Created

| Path | Purpose |
|---|---|
| `packages/med-ner/src/utils/htmlEscape.ts` | `escapeHtml(str)` utility (M-3). |
| `packages/med-ner/src/utils/chunking.ts` | `segmentSentences`, `chunkByTokens`, `mergeChunkEntities` (C-2). |
| `packages/med-ner/src/workers/medner.worker.ts` | Web Worker hosting the NER pipeline (C-1). |
| `packages/med-ner/src/workers/workerClient.ts` | `MedNERWorkerClient` main-thread wrapper (C-1). |
| `packages/med-ner/src/workers/index.ts` | Worker barrel (re-exports the client; not the worker itself). |
| `packages/med-ner/src/__tests__/htmlEscape.test.ts` | Unit tests for `escapeHtml`. |
| `packages/med-ner/src/__tests__/chunking.test.ts` | Unit tests for the chunker + sentence segmenter + chunk-entity merger. |
| `packages/med-ner/src/__tests__/webgpu.test.ts` | Branch tests for `isWebGPUSupported` and `getRecommendedDevice`. |
| `packages/med-ner/src/__tests__/workerClient.test.ts` | Protocol tests for `MedNERWorkerClient`. |
| `packages/med-ner/src/__tests__/MedNERProcessor.init.test.ts` | Integration tests for `init()` pipeline options (H-6, R-12, H-1) and chunked extract (C-2). |
| `packages/med-ner/src/__tests__/MedNERProcessor.worker.test.ts` | Integration tests proving off-main-thread execution (C-1). |
| `docs/implementation/TASK-272-MedNER-Worker/README.md` | This document. |

### Modified

| Path | Change |
|---|---|
| `packages/med-ner/src/types/index.ts` | Added `ModelReference`, `MedNERDevice`; retyped `MODEL_MAP` with pinned revisions; added `maxTokens`/`stride`/`workerFactory` options; added `webGPU` to browser support; extended `DEFAULT_MED_NER_OPTIONS`. |
| `packages/med-ner/src/utils/browserSupport.ts` | Added `isWebGPUSupported()`, `getRecommendedDevice()`; included `webGPU` in `getMedNERBrowserSupport()`. |
| `packages/med-ner/src/utils/entityUtils.ts` | Rewrote `highlightEntities` to escape every dynamic substring via `escapeHtml`. |
| `packages/med-ner/src/utils/index.ts` | Exported new utils (`escapeHtml`, chunking helpers, WebGPU helpers). |
| `packages/med-ner/src/processors/MedNERProcessor.ts` | Resolved tokenizer + device; routed pipeline call through aggregation/revision/device options; integrated `MedNERWorkerClient`; replaced character-window chunking with token-aware chunker; added `getActiveDevice()`. |
| `packages/med-ner/src/index.ts` | Re-exported new types, the worker client, escapeHtml, chunking helpers, and WebGPU helpers. |
| `packages/med-ner/src/__tests__/types.test.ts` | Asserted the new `MODEL_MAP` shape and that every preset is pinned to a 40-char hex SHA. |
| `packages/med-ner/src/__tests__/entityUtils.test.ts` | Added XSS-protection tests for `highlightEntities`. |
| `packages/med-ner/src/__tests__/browserSupport.test.ts` | Asserted `webGPU` is present on the support object. |
| `packages/med-ner/tsup.config.ts` | Added a second entry to emit the worker as a standalone ESM bundle at `dist/workers/medner.worker.js`. |
| `packages/med-ner/package.json` | Added `./worker` subpath export. |

### Untouched (per scope rule)

- `apps/**`, `infrastructure/**`, every other `packages/**` — no modifications.
- `packages/med-ner/e2e/**` — out of scope for this ticket (E2E updates can
  reference the new public API in a follow-up).

## 6. Deviations / Follow-ups

- **No auto-default workerFactory.** Consumers must supply the
  `workerFactory` themselves (see the README snippet above). Auto-
  creating a `new Worker(new URL('./workers/medner.worker.js', import.meta.url))`
  inside the library is brittle across bundlers; explicit opt-in is
  consistent with how `@arcaai/stt` exposes its worker engine.
- **Legacy `maxLength`/`chunkOverlap` retained** for backward compat. They
  are marked `@deprecated` in the type and only used as a safety-net
  trigger when no tokenizer is available. A future ticket can remove
  them once consumers migrate to `maxTokens`/`stride`.
- **E2E fixture not updated.** The XSS fix is verified by unit tests
  against `highlightEntities`. Updating the Playwright fixture at
  `packages/med-ner/e2e/fixtures/index.html` to use the new API was out
  of scope and is recommended as a follow-up.
- **`mergeAdjacentEntities` score-averaging bug (H-2)** is NOT addressed by
  this ticket — it was not in the six-item scope. Recommend a follow-up
  to fix the running-average inside `mergeAdjacentEntities` to use a
  count-aware weighted average.

---

## 7. How to bump a pinned model revision

The package pins every preset model to a specific HF Hub commit SHA so that
upstream owners cannot silently rewrite the model behind production users.

To bump a pinned revision:

1. Decide on the new revision. Either:
   - look at the commit history of the model on
     `https://huggingface.co/<id>/commits/main`, or
   - query `https://huggingface.co/api/models/<id>` and read the `sha`
     field of the latest revision you have validated.
2. Update the matching entry in `packages/med-ner/src/types/index.ts`:
   ```ts
   export const MODEL_MAP = {
     biomedical: {
       id: 'Kushtrim/bert-base-cased-biomedical-ner',
       revision: '<new-sha>',
     },
     // ...
   } as const;
   ```
3. Re-run the package gates:
   ```bash
   pnpm --filter @arcaai/med-ner test
   pnpm --filter @arcaai/med-ner build
   pnpm --filter @arcaai/med-ner lint
   ```
4. Run the e2e fixture against the new revision (browser-side) and verify
   entity extraction is unchanged or improved.
5. Note the bump in this README under "Change History" with the old and
   new SHA and the reason.

> **Never** point `revision` at `'main'` in production — that re-enables
> the silent-update vector this ticket eliminates.

---

## 8. Change History

| Date | Description | Files |
|---|---|---|
| 2026-05-23 | Initial implementation (C-1, C-2, H-1, H-6, R-12, M-3). | see §5 |
