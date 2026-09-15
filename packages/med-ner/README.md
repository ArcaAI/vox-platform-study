# @arcaai/med-ner — deprecated browser medical NER

`packages/med-ner`, npm package `@arcaai/med-ner` (version 3.5.0). **DEPRECATED**
(`package.json`'s `deprecated` field, TASK-865) — removed in R4. In-browser medical NER is
retired; entity extraction runs in `apps/nlp` through the realtime lane. The browser captures
audio and renders results; it never runs a model. This package keeps building and stays
importable until R4 so existing hosts can migrate — do not add new consumers. Register row:
`docs/operations/deprecation-register.md` SDK section.

Medical Named Entity Recognition in the browser via Transformers.js. Extracts diseases,
medications, procedures, anatomy, lab values, symptoms, dosage/frequency/duration, genes, and
chemicals from text. Inference runs either on the main thread or — recommended — in a dedicated
Web Worker so the model stack never blocks the UI. This is a text processor, not an audio
processor: `MedNERProcessor` is a standalone class you `init()` and call `extract(text)` on.
`@arcaai/room` is a type-only peer dependency (`TrackProcessor`, `ProcessorOptions`); `react` is
an optional peer dependency (only needed for `useMedNER`). Consumed as an optional peer of
`@arcaai/vox`, re-exported at the deprecated `@arcaai/vox/plugins/med-ner` entry.

## Layout

| Path | What it holds |
|---|---|
| `src/processors/` | `MedNERProcessor` (+ `createMedNER` factory) |
| `src/workers/` | `medner.worker.ts` (worker host) + `MedNERWorkerClient` (RPC wrapper) |
| `src/hooks/` | `useMedNER` (React) |
| `src/types/` | `MedicalEntityType`, `EntitySpan`, `MedNEROptions`, `MODEL_MAP` (pinned model ids) |
| `src/utils/` | Entity merge/filter/highlight utils, token-aware chunking, `escapeHtml`, browser/WebGPU support detection |
| `e2e/` | Playwright browser tests (`serve.mjs` + fixtures) |

Subpath export: `@arcaai/med-ner/worker` -> the built worker file.

## Commands

Run from this directory, or `pnpm --filter @arcaai/med-ner <script>` from the repo root.

| Command | Effect |
|---|---|
| `pnpm build` | tsup build (main + worker + e2e bundles) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests (runs `pnpm build` first); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm e2e:serve` | Serve e2e fixtures standalone |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm nuke` | Remove build output (`nuke` also removes `node_modules`) |

## How it works

### Processor

```typescript
import { createMedNER } from '@arcaai/med-ner';

const ner = createMedNER({
  model: 'biomedical',
  threshold: 0.6,
  // Recommended: off-main-thread inference
  workerFactory: () =>
    new Worker(new URL('@arcaai/med-ner/dist/workers/medner.worker.js', import.meta.url), {
      type: 'module',
    }),
});

await ner.init(); // downloads + caches the model on first use

const result = await ner.extract('Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg twice daily.');
// result.entities: [{ text, type, score, start, end, rawLabel }, ...]

await ner.destroy();
```

When `workerFactory` is provided, all inference runs in the worker and the main thread never
imports `@huggingface/transformers`. When omitted, the processor falls back to main-thread
inference — appropriate for SSR, jsdom tests, or environments without `Worker`.

### Options (`MedNEROptions`)

| Option | Default | Description |
|---|---|---|
| `model` | `'default'` | `'default' \| 'biomedical' \| 'clinical'` or any HF model ID with ONNX weights |
| `threshold` | `0.5` | Minimum confidence; lower-scoring entities are dropped |
| `entityTypes` | all | Restrict output to specific `MedicalEntityType` values |
| `mergeAdjacent` / `mergeOverlapping` | `true` / `true` | B-I-O merge and overlap resolution |
| `maxTokens` / `stride` | `384` / `64` | Token-aware chunking for long texts |
| `maxLength` / `chunkOverlap` | `512` / `50` | Deprecated character-based limits; prefer `maxTokens`/`stride` |
| `dtype` | `'q8'` browser, `'fp32'` Node | Quantization: `'fp32' \| 'fp16' \| 'q8' \| 'q4'` |
| `workerFactory` | - | Factory returning a `Worker` hosting `medner.worker.js` |
| `onProgress` | - | Model download/load progress callback |

`MedNERProcessor` methods: `init()`, `extract(text)`, `destroy()`, `isSupported()`,
`isInitialized()`, `getModelId()`, `updateOptions()`, `getStats()`, `on()`/`off()`.

### Models (pinned revisions)

`MODEL_MAP` (`src/types/`) pins each preset to a validated Hugging Face commit SHA (`revision`,
forwarded to `pipeline({ revision })`), so an upstream re-train or push cannot silently change
inference results underneath production users:

| Preset | Hugging Face model |
|---|---|
| `default` | `Xenova/bert-base-NER` (general NER) |
| `biomedical` | `Kushtrim/bert-base-cased-biomedical-ner` |
| `clinical` | `samrawal/bert-base-uncased_clinical-ner` |

Compute device is resolved automatically per environment (`getRecommendedDevice()` ->
`'webgpu'` when usable, else `'wasm'`).

### Utilities

Entity helpers: `filterEntitiesByThreshold`, `filterEntitiesByType`, `mergeAdjacentEntities`,
`mergeOverlappingEntities`, `sortEntitiesByScore`/`ByPosition`, `getTopEntities`,
`groupEntitiesByType`, `deduplicateEntities`, `highlightEntities` (HTML output, XSS-safe via
`escapeHtml`), `entitiesToJSON`. Chunking: `chunkByTokens`, `segmentSentences`,
`mergeChunkEntities`. Support probing: `isMedNERSupported()`, `getMedNERBrowserSupport()`,
`isWebGPUSupported()`, `getRecommendedDtype()`.

### Runtime requirements

- Requires WebAssembly, `fetch`, and IndexedDB (model caching). WebGPU is used opportunistically.
- Models download from the Hugging Face Hub on first `init()` and are cached in the browser by
  Transformers.js; nothing ships in the package.
- The worker bundle is self-contained (Transformers.js bundled in). Bundlers that support
  `new URL(..., import.meta.url)` resolve the worker path automatically.
- iOS Safari works but is memory-constrained; prefer `dtype: 'q8'` or `'q4'`.
- Browser-only main entry (`"use client"`); ships a `react-server` exports-condition stub.

## Related

- [`@arcaai/vox`](../agentic-sdk-v2/README.md) — optional consumer via the deprecated
  `/plugins/med-ner` entry.
- [`@arcaai/room`](../room/README.md) — type-only peer.
- `.claude/rules/08-vox-sdk.md` — the owner directive that the browser never runs a model.
