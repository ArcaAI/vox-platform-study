# @arcaai/med-ner

Medical Named Entity Recognition in the browser via Transformers.js. Extracts diseases, medications, procedures, anatomy, lab values, symptoms, dosage/frequency/duration, genes, and chemicals from text. Inference runs either on the main thread or — recommended — in a dedicated Web Worker so the ~hundreds-of-MB model stack never blocks the UI. Models are pinned to specific Hugging Face revisions for supply-chain safety.

Last updated: 2026-07-04

## Where it fits

| Direction | Package | Relationship |
|---|---|---|
| Depends on | `@huggingface/transformers` | Token-classification pipeline (ONNX) |
| Depends on | `@arcaai/room` (peer, `^0.1.0`) | Type-only import (`TrackProcessor`, `ProcessorOptions`) |
| Consumed by | `@arcaai/vox` (optional peer) | NER stage of `KnowledgePipeline`; hook re-exported at `@arcaai/vox/plugins/med-ner` |

This is a text processor, not an audio processor: `MedNERProcessor` is a standalone class you `init()` and call `extract(text)` on. `react` is an optional peer dependency (only needed for `useMedNER`).

## Directory structure

```
packages/med-ner/
├── src/
│   ├── processors/    # MedNERProcessor (+ createMedNER factory)
│   ├── workers/       # medner.worker.ts (worker host) + MedNERWorkerClient (RPC wrapper)
│   ├── hooks/         # useMedNER (React)
│   ├── types/         # MedicalEntityType, EntitySpan, MedNEROptions, MODEL_MAP (pinned revisions)
│   ├── utils/         # Entity merge/filter/highlight utils, token-aware chunking,
│   │                  # escapeHtml, browser/WebGPU support detection
│   └── index.ts       # Public barrel export
├── e2e/               # Playwright browser tests (serve.mjs + fixtures)
└── tsup.config.ts     # Main bundle + worker bundle (dist/workers/medner.worker.js) + e2e bundle
```

Subpath export: `@arcaai/med-ner/worker` → the built worker file.

## Public API overview

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

const result = await ner.extract(
  'Patient diagnosed with Type 2 Diabetes and prescribed Metformin 500mg twice daily.'
);
// result.entities: [{ text, type, score, start, end, rawLabel }, ...]

await ner.destroy();
```

When `workerFactory` is provided, all inference runs in the worker and the main thread never imports `@huggingface/transformers`. When omitted, the processor falls back to main-thread inference — appropriate for SSR, jsdom tests, or environments without `Worker`.

### React hook

```tsx
import { useMedNER } from '@arcaai/med-ner';

function MedicalTextAnalyzer() {
  const { isReady, isProcessing, entities, extract, error } = useMedNER({
    model: 'biomedical',
    threshold: 0.6,
    autoInit: true,
  });

  return (
    <div>
      <button
        onClick={() => extract('Patient has hypertension and takes Lisinopril.')}
        disabled={!isReady || isProcessing}
      >
        Analyze
      </button>
      {error && <div>{error.message}</div>}
      <ul>
        {entities.map((e, i) => (
          <li key={i}>{e.text} ({e.type}) — {(e.score * 100).toFixed(1)}%</li>
        ))}
      </ul>
    </div>
  );
}
```

The hook additionally exposes `isLoading` / `loadProgress`, `result`, `stats`, `processor`, and methods `init`, `extractBatch(texts)`, `clear`, `resetStats`, `updateOptions`, `destroy`.

### Options (`MedNEROptions`)

| Option | Default | Description |
|---|---|---|
| `model` | `'default'` | `'default' \| 'biomedical' \| 'clinical'` or any HF model ID with ONNX weights |
| `threshold` | `0.5` | Minimum confidence; lower-scoring entities are dropped |
| `entityTypes` | all | Restrict output to specific `MedicalEntityType` values |
| `mergeAdjacent` / `mergeOverlapping` | `true` / `true` | B-I-O merge and overlap resolution |
| `maxTokens` / `stride` | `384` / `64` | Token-aware chunking for long texts (headroom for `[CLS]`/`[SEP]`) |
| `maxLength` / `chunkOverlap` | `512` / `50` | Deprecated character-based limits; prefer `maxTokens` / `stride` |
| `dtype` | `'q8'` browser, `'fp32'` Node | Quantization: `'fp32' \| 'fp16' \| 'q8' \| 'q4'` |
| `workerFactory` | — | Factory returning a `Worker` hosting `medner.worker.js` |
| `onProgress` | — | Model download/load progress callback |
| `enableStats` / `statsInterval` | `false` / `1000` | Emit stats events |

`MedNERProcessor` methods: `init()`, `extract(text)`, `destroy()`, `isSupported()`, `isInitialized()`, `isProcessing()`, `getModelId()`, `getOptions()`, `updateOptions()`, `getStats()`, `resetStats()`, `on()` / `off()`.

### Models (pinned revisions)

`MODEL_MAP` pins each preset to a validated Hugging Face commit SHA, so an upstream re-push cannot silently change inference results:

| Preset | Hugging Face model |
|---|---|
| `default` | `Xenova/bert-base-NER` (general NER) |
| `biomedical` | `Kushtrim/bert-base-cased-biomedical-ner` |
| `clinical` | `samrawal/bert-base-uncased_clinical-ner` |

Compute device is resolved automatically per environment (`getRecommendedDevice()` → `'webgpu'` when usable, else `'wasm'`).

### Utilities

Entity helpers: `filterEntitiesByThreshold`, `filterEntitiesByType`, `mergeAdjacentEntities`, `mergeOverlappingEntities`, `sortEntitiesByScore` / `ByPosition`, `getTopEntities`, `groupEntitiesByType`, `countEntitiesByType`, `deduplicateEntities`, `getAverageConfidence`, `highlightEntities` (HTML output, XSS-safe via `escapeHtml`), `entitiesToJSON`.

Chunking: `chunkByTokens`, `segmentSentences`, `mergeChunkEntities`. Support probing: `isMedNERSupported()`, `getMedNERBrowserSupport()`, `isWebGPUSupported()`, `getRecommendedDtype()`.

## Runtime requirements

- Requires WebAssembly, `fetch`, and IndexedDB (model caching). WebGPU is used opportunistically.
- Models download from the Hugging Face Hub on first `init()` and are cached in the browser by Transformers.js; nothing ships in the package. Budget model-sized downloads (BERT-base ONNX, tens to hundreds of MB depending on `dtype`).
- The worker bundle is self-contained (Transformers.js bundled in). Bundlers that support `new URL(..., import.meta.url)` (Vite, webpack 5) resolve the worker path automatically.
- iOS Safari works but is memory-constrained; prefer `dtype: 'q8'` or `'q4'`.
- Browser-only main entry (`"use client"`); ships a `react-server` exports-condition stub.

## Commands

From this directory:

| Command | Action |
|---|---|
| `pnpm build` | tsup build (main + worker + e2e bundles) |
| `pnpm test` / `pnpm test:watch` / `pnpm test:unit:cov` | Vitest unit tests |
| `pnpm test:e2e` | Playwright browser tests (`pnpm e2e:serve` serves fixtures); `:ui`, `:headed`, `:chromium` variants exist |
| `pnpm lint` | ESLint (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm clean` / `pnpm clean:all` | Remove build output (nuke also removes `node_modules`) |

From the repo root: `pnpm --filter @arcaai/med-ner build` (same pattern for `test`, `lint`, etc.).

## License

MIT
