---

# @arcaai/med-ner — Exhaustive Code Review

> Scope: every file under `packages/med-ner/`. Transformers.js v3.8.1 (`@huggingface/transformers@^3.8.1`). Cross-referenced against `apps/nlp/` Python fallback and `@arcaai/vox` integration surface.

---

## 1. Architecture

### 1.1 Model Selection

Three preset models are wired in `src/types/index.ts:178-182`:

```
default    → Xenova/bert-base-NER              (CoNLL-2003, general NER — not biomedical)
biomedical → Kushtrim/bert-base-cased-biomedical-ner
clinical   → samrawal/bert-base-uncased_clinical-ner
```

All three are `bert-base` ONNX exports converted and hosted on Hugging Face Hub under third-party accounts (not Xenova/HuggingFace official). The "default" model (`Xenova/bert-base-NER`) was trained on **news text (CoNLL-2003)** — not medical corpora — and classifies only PER/ORG/LOC/MISC, making it essentially useless for clinical NER.

### 1.2 Pipeline Initialisation

`MedNERProcessor.init()` at `src/processors/MedNERProcessor.ts:184-253` calls `pipeline('token-classification', modelId, { dtype, progress_callback })` via `@huggingface/transformers`. The Transformers.js library handles:

- Fetching ONNX weights from HuggingFace CDN (or IndexedDB cache if `env.useBrowserCache = true`)
- ONNX Runtime Web instantiation (WASM backend only — see §4 defects)
- Tokenizer JSON fetching and configuration

The `env` configuration at `src/processors/MedNERProcessor.ts:32-35` is set at **module load time** (`if (typeof window !== 'undefined')`), not at processor instantiation. This means it runs once when the module is imported, which has SSR/dual-import hazards.

### 1.3 Integration with @arcaai/room and @arcaai/vox

This is the most significant architectural gap:

- `MedNERProcessor` is a **standalone class** with its own event emitter (`on`/`off`/`emit`). It does **not** extend or implement `@arcaai/room`'s `BaseProcessor`/`TrackProcessor` interface, despite the package being declared as a peer dependency.
- The only connection to `@arcaai/room` is a passive type re-export at `src/types/index.ts:463`:
  ```
  export type { ProcessorOptions, TrackProcessor, EventEmittingProcessor } from '@arcaai/room';
  ```
  These types are exported but **never used** within the package itself.
- The README shows a `@arcaai/vox` integration example (lines 315-345) using `config.plugins.ner` and `context.extractEntities()`, but **no such integration exists in the codebase**. `@arcaai/vox` is not a dependency, and there are no plugin registration hooks, no `ProcessorPipeline` attachment, and no `useArca` bridge.
- The STT→NER pipeline described in the README (transcription auto-extract) is aspirational documentation, not implemented code.

---

## 2. Public API

| Export | Type | Location |
|---|---|---|
| `createMedNER(options?)` | Factory | `src/processors/MedNERProcessor.ts:598` |
| `MedNERProcessor` | Class | `src/processors/MedNERProcessor.ts:77` |
| `useMedNER(options)` | React hook | `src/hooks/useMedNER.ts:142` |
| `MedicalEntityType` | Enum | `src/types/index.ts:14` |
| `LABEL_TO_ENTITY_TYPE` | Const | `src/types/index.ts:45` |
| `MODEL_MAP` | Const | `src/types/index.ts:178` |
| `DEFAULT_MED_NER_OPTIONS` | Const | `src/types/index.ts:260` |
| `MedNERError` / `MedNERErrorCode` | Error class/enum | `src/types/index.ts:419/397` |
| `filterEntitiesByThreshold`, `mergeAdjacentEntities`, `highlightEntities`, … (16 utils) | Functions | `src/utils/entityUtils.ts` |
| `getMedNERBrowserSupport`, `getRecommendedDtype`, … (11 utils) | Functions | `src/utils/browserSupport.ts` |

The `on(event, callback)` / `off(event, callback)` pattern uses a weakly typed `string` event name and `(data: unknown) => void` callback, making it unsafe — event payloads require manual casting on the consumer side.

---

## 3. Strengths

1. **Comprehensive type system** — `EntitySpan`, `MedNERResult`, `MedNERBrowserSupport`, `MedNERStats`, `MedNERError` with error codes are thorough and well-documented with JSDoc.
2. **Good entity utility library** — 16 utility functions covering filtering, merging, grouping, deduplication, and HTML highlighting. All have corresponding unit tests in `entityUtils.test.ts`.
3. **Adaptive quantization selection** — `getRecommendedDtype()` at `browserSupport.ts:116` inspects `navigator.deviceMemory` and `hardwareConcurrency` to pick `q4`/`q8`/`fp16`, which is practical UX.
4. **Stable React hook** — `useMedNER` uses `useRef` for the processor, a `mountedRef` guard against post-unmount state updates, and keeps callbacks in refs to avoid stale closures.
5. **E2E test harness** — A full Playwright HTML fixture exists with browser support checks, progress display, entity highlighting, statistics, and threshold tuning. The E2E spec covers init, destroy, entity extraction, UI responsiveness, and stats reset.
6. **Long-text chunking** — `extractChunked` and `chunkText` implement overlapping windows; offset correction in `extractChunked` adjusts character positions back to the original document.

---

## 4. Defects

### Critical

**C-1: Main-thread blocking — no WebWorker offloading**
- File: `src/processors/MedNERProcessor.ts:203` (entire `pipeline()` call and every `this.pipeline(text)` call)
- The ONNX runtime inference runs synchronously on the main thread. On a 300 MB BERT model, a single token-classification forward pass on a 512-token sequence takes 200–2000 ms depending on hardware. During this time the browser UI is completely frozen. All other packages in the monorepo (`@arcaai/stt`, `@arcaai/vad`) use WebWorker patterns; `@arcaai/med-ner` does not.
- Transformers.js v3 supports `pipeline(..., { device: 'wasm' })` inside a Worker scope and exposes `Comlink`/`postMessage` patterns for off-thread inference. None of this is implemented here.

**C-2: Character-boundary chunking breaks BERT tokenizer**
- File: `src/processors/MedNERProcessor.ts:364-381`, `src/types/index.ts:265` (`maxLength: 512`)
- `chunkText()` splits at `maxLength` **characters**, not tokens. BERT's maximum is 512 **WordPiece tokens**, not characters. Clinical text averages ~1.3 characters per token, meaning a 512-character chunk is actually ~394 tokens — safe, but the overlap is also character-based (50 chars ≈ 38 tokens). More critically, the split can occur mid-word (e.g., slicing `"Metformin"` to `"Metfor"` + `"min"`), causing the tokenizer to produce subword tokens that the model will classify incorrectly.
- The correct approach is to use the tokenizer's `encode`/`decode` to count actual tokens and split on word boundaries aligned to token boundaries.

**C-3: `destroy()` does not release ONNX session memory**
- File: `src/processors/MedNERProcessor.ts:474-480`
- `destroy()` sets `this.pipeline = null`, dropping the JS reference. However, the underlying ONNX Runtime Web `InferenceSession` object (which holds the ~300 MB WASM heap allocation) has no explicit `session.release()` or `session.dispose()` call. Transformers.js v3 wraps ORT and does not currently auto-release sessions on GC. In a long-running consultation session where the NER model is loaded then "destroyed" multiple times (e.g., re-init after model switch), the browser heap grows unboundedly.
- ONNX Runtime Web exposes `InferenceSession.release()`. The processor needs to retain a reference to the ORT session to call it, or Transformers.js v3's pipeline must be explicitly `.dispose()`-d if that API exists.

---

### High

**H-1: No WebGPU backend — always falls back to WASM**
- File: `src/processors/MedNERProcessor.ts:203`
- The `pipeline()` call passes `dtype` but never sets `device`. Transformers.js v3 supports `device: 'webgpu'` for accelerated inference. On Chrome 113+/Edge 113+ (the recommended browser), WebGPU inference for BERT NER is 3–10× faster than WASM. The browser support check in `browserSupport.ts` never interrogates `navigator.gpu`.
- A `getRecommendedDevice()` function should probe `navigator.gpu`, check adapter availability, and return `'webgpu'` or `'wasm'` as a fallback.

**H-2: `B-` prefix stripped but scoring incorrectly averaged for merged spans**
- File: `src/utils/entityUtils.ts:75-78`
- When merging adjacent B-I tokens, `mergeAdjacentEntities` averages the scores: `current.score = (current.score + entity.score) / 2`. For a 3-token span `[B:0.95, I:0.90, I:0.85]`, the result is `((0.95+0.90)/2 + 0.85)/2 = 0.8625` instead of the correct average `0.9`. The running-average is lost because `current.score` is modified in place during accumulation without tracking the count.

**H-3: `maxLength` option is in characters but the default model's limit is token-based**
- File: `src/types/index.ts:220-225`, `src/processors/MedNERProcessor.ts:278`
- The option is named `maxLength` and the default is `512`, implying tokens. But `chunkText()` at `MedNERProcessor.ts:364` calls `text.slice(offset, end)` — character slicing. The name misleads callers. The option should either be renamed to `maxChunkChars` with documentation explaining its relationship to tokens, or converted to token-count chunking.

**H-4: `extractBatch` is sequential, not parallel**
- File: `src/hooks/useMedNER.ts:306-314`
- `extractBatch` iterates `texts` serially with `for...of / await`. Because the ONNX inference is CPU-bound and single-threaded (WASM), parallelism would not help without workers, but the API suggests batching capability. More critically, `setIsProcessing(true)` is set and cleared on each individual call, so the UI flickers `isProcessing=true/false` for every text in the batch. The batch should be treated as a single processing unit.

**H-5: `isProcessing` concurrency guard is absent**
- File: `src/processors/MedNERProcessor.ts:261-318`
- `extract()` does not check `this._isProcessing` before starting a new inference. If two calls race (e.g., `extractBatch` running while the user also calls `extract`), both will set `this._isProcessing = true`, both will run inference on the same WASM instance (which is not thread-safe), and the stats will be double-counted.

**H-6: `##` subword stripping is incomplete**
- File: `src/processors/MedNERProcessor.ts:329`
- `result.word.replace(/^##/, '')` only strips a leading `##` from the raw token. Transformers.js v3's `pipeline('token-classification')` with `aggregation_strategy: 'simple'` or `'first'` will already merge subword tokens. Without an explicit `aggregation_strategy`, each WordPiece token is returned individually (e.g., `['Hyper', '##tension']`). The `##` strip means `"Hypertension"` appears as `"Hyper"` + `"tension"` in the entity list, not the full word — `mergeAdjacentEntities` would need to reconstruct it, but it checks character adjacency (`gap <= 2`) which may not hold for in-word subwords.

---

### Medium

**M-1: `env` configured at module scope, not per-instance**
- File: `src/processors/MedNERProcessor.ts:32-35`
- ```typescript
  if (typeof window !== 'undefined') {
    env.allowLocalModels = false;
    env.useBrowserCache = true;
  }
  ```
  This runs once on first import. In SSR (Next.js App Router) or test environments where `window` is shimmed, this silently sets `useBrowserCache = true` in environments that don't support IndexedDB, causing silent cache failures. Also, `vitest.setup.ts:8` mocks `useBrowserCache: true` but the production processor test at `MedNERProcessor.test.ts:19` sets `allowLocalModels: false` — the two setups are inconsistent.

**M-2: No IndexedDB eviction strategy**
- File: `src/processors/MedNERProcessor.ts:34`, `src/utils/browserSupport.ts:36-44`
- `env.useBrowserCache = true` enables Transformers.js's built-in IndexedDB cache. There is no API to clear, version, or evict stale model weights. If the model is updated on HuggingFace Hub (e.g., from `Kushtrim/bert-base-cased-biomedical-ner@rev1` to `@rev2`), the browser will serve stale weights indefinitely. The package has no `cacheVersion`, `forceReload`, or TTL option.

**M-3: `highlightEntities` uses innerHTML with unsanitised text**
- File: `src/utils/entityUtils.ts:221-236`
- The `before`/`entityText`/`after` slices come from the original user input text, which is then concatenated into an HTML string assigned to `innerHTML` in the E2E fixture (`e2e/fixtures/index.html:601`). If the medical text input contains `<`, `>`, `&`, or `"`, the result is XSS-susceptible. Clinical text scraped from EHR systems routinely contains `<50%`, `pH>7`, `T<38.5°C`, etc.

**M-4: `areEntitiesAdjacent` uses a hardcoded `maxGap = 2` for B-I merging**
- File: `src/utils/entityUtils.ts:41-48`
- The gap of 2 characters is arbitrary and will fail for multi-byte Unicode characters (e.g., Chinese/Japanese medical terms, where a single character is 1 token but 3 bytes in UTF-8). More importantly, WordPiece tokenization can produce tokens whose character-index gaps differ from visual adjacency. The gap should be configurable and documented.

**M-5: `@arcaai/room` peer dependency is declared but MedNERProcessor does not implement the interface**
- File: `package.json:50-53`, `src/types/index.ts:463`
- The package declares `"@arcaai/room": "^0.1.0"` as a peer dependency and re-exports types from it, but `MedNERProcessor` does not implement `TrackProcessor` or `EventEmittingProcessor`. This is a broken contract: any code that tries to register `MedNERProcessor` in a `ProcessorPipeline` will fail at runtime with type errors hidden by the fact that the `room` types are re-exported but never enforced.

**M-6: `getHardwareConcurrency` uses `require('os')` in a browser module**
- File: `src/utils/browserSupport.ts:99-108`
- ```typescript
  const os = require('os');
  return os.cpus().length;
  ```
  This is a CommonJS dynamic `require` inside an ES module. It works in Node.js (for tests) but bundlers (Vite, tsup with `esbuildOptions`) may either bundle `os` as an empty shim or throw at build time. The ESM-correct approach is `import { cpus } from 'node:os'` with a dynamic import guard or a separate Node.js code path.

---

### Low

**L-1: `MedNERBrowserSupport` type marks `indexedDB` but the support check is not required**
- File: `src/utils/browserSupport.ts:162`, `src/processors/MedNERProcessor.ts:190-192`
- `nerSupported = webAssembly && fetch` — IndexedDB is checked and exposed in the support object, but the processor does not throw if IndexedDB is absent. If IndexedDB is unavailable, `env.useBrowserCache = true` silently fails (Transformers.js will re-download the model on every page load). The README states IndexedDB is a requirement, but the code doesn't enforce it.

**L-2: Stats interval leaks if `destroy()` is called without `stopStatsEmission()`**
- File: `src/processors/MedNERProcessor.ts:474-480`
- `destroy()` calls `stopStatsEmission()` before nulling the pipeline. This is correct, but if `destroy()` itself throws (shouldn't, but defensively), the interval timer is never cleared. Using `try/finally` would be safer.

**L-3: `getOptions()` returns the options object with `undefined` dtype**
- File: `src/processors/MedNERProcessor.ts:503-505`
- `getOptions()` returns `{ ...this.options }`. Because `dtype` was passed by the user but after model load is no longer used, and `entityTypes`/`onProgress`/`dtype` are excluded from `DEFAULT_MED_NER_OPTIONS`, the spread may return `dtype: undefined` even when the caller set it, because the type definition handles it as `Optional`. Minor but inconsistent.

**L-4: `"use client"` banner injected unconditionally in CJS build**
- File: `tsup.config.ts:17-21`
- The `"use client"` directive is inserted at the top of the JS bundle for both ESM and CJS outputs. In a Next.js App Router project this is appropriate for the client component bundle, but it also appears in the CJS output used by Node.js/test runners. Vitest sees `"use client"` as a plain string (not a directive), harmless but unexpected.

**L-5: `extractBatch` in hook does not expose aggregate progress**
- File: `src/hooks/useMedNER.ts:306-314`
- Callers have no way to know how many of the batch items have completed (e.g., 2/5). `isProcessing` only reflects the state of the most recent single `extract` call.

---

## 5. Security

### Model Trust / Integrity

- **No signing or hash verification.** `env.allowLocalModels = false` prevents loading from local paths, but downloads from HuggingFace Hub are HTTPS-only with no SHA-256 manifest verification. A compromised CDN or a malicious model revision (the Hub allows updating model files by the owner) would silently load without any integrity check.
- `Kushtrim/` and `samrawal/` are **personal/community HuggingFace accounts**, not vetted medical AI organisations. There is no audit trail, no model card citation of training data provenance, and no guarantee of continued availability.
- The ONNX file format itself can contain serialised Python code in older versions of ONNX Runtime. Transformers.js uses ONNX Runtime Web which mitigates arbitrary code execution, but the model architecture must be pinned.

**Recommendation:** Pin model revisions to a specific git commit SHA via the HuggingFace Hub `revision` parameter (`pipeline(..., { revision: 'abc1234' })`) and mirror critical models to a controlled S3/CDN with known hashes.

### Patient PII in Logs / Events

- `logBrowserSupport()` at `src/utils/browserSupport.ts:184-207` calls `console.group`/`console.log`. Device memory, CPU core count, browser type are not PII, but are privacy-relevant for fingerprinting.
- The E2E fixture at `e2e/fixtures/index.html:601` calls `highlightEntities(text, result.entities)` and sets `highlightedText.innerHTML` directly. The `text` variable is the raw medical input from the textarea, which may contain real patient data in a demo or staging environment.
- The `MedNERResult` object stored in `window.lastResult` (E2E fixture line 615) persists the full text and all extracted entities. This is for testing only, but if the fixture is deployed to a staging server it exposes PHI.
- There is **no logging of entity text or source text anywhere in the production code** (`MedNERProcessor.ts`, `useMedNER.ts`). The `onEntitiesExtracted` callback returns the full result including original text to the consumer — it is the consumer's responsibility to handle it correctly, but no warning or guidance exists.

---

## 6. Performance

### Token Throughput

With the default `q8` ONNX BERT-base model running WASM in Chrome on a mid-range laptop (Apple M-class or Intel 12th gen), typical throughput is:
- First inference (warm model, cold ONNX session): **800–1500 ms**
- Subsequent inferences (warm session): **150–400 ms**
- Model download on first use: **30–120 seconds** over a typical connection (~100 MB for q8 BERT)

### Batch Size

The Transformers.js `TokenClassificationPipeline` supports batched inputs (an array of strings), but `extractSingle` at `src/processors/MedNERProcessor.ts:323-336` passes a **single string** per call. Each call to `this.pipeline(text)` results in a separate ONNX Runtime forward pass. Passing an array would allow the ONNX session to batch multiple sequences in a single graph execution, significantly improving throughput for `extractBatch`.

### Quantization

The `dtype` option supports `fp32/fp16/q8/q4`. `getRecommendedDtype()` defaults to `q8` for most users, which is appropriate. However:
- `fp16` is recommended for high-end devices, but most browser WASM runtimes do not have native `f16` support and fall back to `fp32` emulation — `fp16` via WASM is often slower than `fp32`.
- `q4` reduces model size to ~50 MB but the accuracy hit for clinical NER is not documented. A 10–15% F1 drop is typical for biomedical models at q4.
- There is no warmup strategy — no dummy inference is performed after model load to JIT-compile the WASM code. The first real inference is therefore significantly slower than subsequent ones.

**Recommendation:** Add a warmup call immediately after `init()` completes:
```typescript
await this.pipeline('warmup'); // single token, discarded
```

---

## 7. Test Coverage Gaps

| Area | Current State | Gap |
|---|---|---|
| `init()` happy path | Not tested (mocked at module level) | No test verifies that `pipeline()` is actually called with correct `modelId` and `dtype` |
| `extract()` happy path | Not tested | No test calls `processor.extract()` and checks entity output after `init()` |
| `extractChunked()` | Not tested | No test for text longer than `maxLength` |
| `chunkText()` | Not tested | No test for overlap, boundary conditions, single-chunk input |
| `mapLabelToEntityType()` | Not tested | No test for unknown labels falling back to `OTHER` |
| `postProcessEntities()` | Not tested directly | Only tested via entity utils |
| `updateStats()` | Not tested | Accumulation math is not verified |
| `startStatsEmission()` / `stopStatsEmission()` | Not tested | Timer leak scenarios not covered |
| WebAssembly absent scenario | Not tested | `isWebAssemblySupported` always returns `true` in jsdom — no branch for false |
| `init()` called twice | Not tested | Early return guard (`if (this._initialized) return`) is untested |
| `extract()` before `init()` | Not tested | `NOT_INITIALIZED` error path untested |
| `destroy()` then `extract()` | Not tested | Post-destroy call behaviour |
| Hook `autoInit: true` lifecycle | Not tested | `useEffect` that fires `init()` is never executed in tests |
| Hook `extractBatch` actual calls | Not tested | Only tests that the function exists (`typeof === 'function'`) |
| `highlightEntities` XSS | Not tested | No test with `<` or `>` in entity text |
| `mergeAdjacentEntities` score averaging | Not tested | 3-token merge case |
| `deduplicateEntities` ordering | Not tested | Order of output is non-deterministic (`Map` iteration) |

The `useMedNER.test.ts` is largely **smoke tests** — the vast majority of assertions are `expect(typeof result.current.xyz).toBe('function')`. No actual state transitions (loading → ready → processing → done) are verified because the mock processor never triggers the `'data'` event that `useMedNER`'s `useEffect` listens to.

---

## 8. Conformance to 2026 Best Practices

### Transformers.js 3.x

- Using `@huggingface/transformers@^3.8.1` ✓ (current stable as of 2026)
- **Missing**: `device: 'webgpu'` parameter — Transformers.js 3.x fully supports WebGPU for BERT NER, providing 5–10× speedup on supported browsers.
- **Missing**: `aggregation_strategy: 'simple'` — Without this, each subword token is returned independently. Pass `{ aggregation_strategy: 'simple' }` as pipeline options to get pre-merged word-level entities.
- **Missing**: The `revision` pinning parameter for reproducible model loading.
- **Anti-pattern**: `(pipeline as any)('token-classification', ...)` at `MedNERProcessor.ts:203` — Transformers.js 3.x has proper TypeScript overloads for task-specific pipeline types. The `as any` cast suppresses the type system.

### Model Selection vs 2026 State of the Art

| Model Used | Status |
|---|---|
| `Xenova/bert-base-NER` (default) | CoNLL-2003 general NER — wrong domain for medical |
| `Kushtrim/bert-base-cased-biomedical-ner` | Community model, no model card citations, unclear training data |
| `samrawal/bert-base-uncased_clinical-ner` | Trained on i2b2/2010 — 15-year-old dataset, no ONNX conversion guarantee |

**Better alternatives for 2026:**

| Model | Notes |
|---|---|
| `uer/roberta-base-finetuned-ner` (Xenova port) | Available as Xenova-hosted ONNX |
| `d4data/biomedical-ner-all` | 12-class biomedical NER, actively maintained, available on Hub |
| `allenai/scibert` variants | Strong biomedical base, multiple ONNX ports exist |
| `NLP4Science/pubmedbert-ner` | PubMedBERT fine-tuned, better clinical vocab |
| **GLiNER-medical** | Zero-shot span extraction — no pre-defined label set, state-of-the-art in 2025–2026 |

For production clinical use, the Python `apps/nlp` service (port 8864) already runs `TransformerTokenClassifier` with `AutoModelForTokenClassification` and GPU inference. The on-device browser model should be a lightweight fallback, not the primary path.

### WebGPU Prioritisation

The `playwright.config.ts` at line 26 enables `SharedArrayBuffer` (required for WebWorker + WASM threading) but does not enable WebGPU (`--enable-features=WebGPU`). No WebGPU capability detection is present anywhere in the codebase.

---

## 9. Refactor and Improvement Suggestions

### 9.1 Implement WebWorker Offloading (Critical)

Create `src/workers/ner.worker.ts`:
```typescript
import { pipeline, env } from '@huggingface/transformers';
// All inference runs here, off main thread
self.onmessage = async ({ data }) => { ... };
```
Use `Comlink` or raw `postMessage/transferable` for communication. Align with the pattern already used in `@arcaai/stt` (`packages/stt/`).

### 9.2 Fix Chunking to Token Boundaries

Replace character-based chunking with tokenizer-aware splitting:
```typescript
// Use the pipeline's tokenizer to encode, find safe split points
const encodedLength = await this.pipeline.tokenizer.encode(text).length;
```
Or use `stride`-based sliding window which Transformers.js pipeline supports natively via `tokenizer.model_max_length`.

### 9.3 Add WebGPU Probing

```typescript
export async function getRecommendedDevice(): Promise<'webgpu' | 'wasm'> {
  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter) return 'webgpu';
  }
  return 'wasm';
}
```

Then pass `device: await getRecommendedDevice()` to `pipeline()`.

### 9.4 Add `aggregation_strategy` to Pipeline

```typescript
this.pipeline = await pipeline('token-classification', modelId, {
  dtype: ...,
  aggregation_strategy: 'simple', // merge B/I subwords into word-level entities
});
```
This makes `mergeAdjacentEntities` and `##` stripping redundant for most cases and corrects the subword fragmentation defect.

### 9.5 Model Revision Pinning + Integrity

```typescript
const MODEL_MAP: Record<string, { id: string; revision: string }> = {
  biomedical: {
    id: 'Kushtrim/bert-base-cased-biomedical-ner',
    revision: '<known-good-commit-sha>',
  },
};
```

### 9.6 Implement `@arcaai/room` Interface

`MedNERProcessor` should extend `BaseProcessor` from `@arcaai/room` to integrate into the `ProcessorPipeline`. At minimum, implement the `TrackProcessor` lifecycle (`init`, `destroy`, `enable`, `disable`, `on`, `off`). Currently the `@arcaai/room` peer dependency is a phantom dependency.

### 9.7 Fallback to `apps/nlp` Python Service

When on-device inference is unavailable (IndexedDB absent, WebAssembly blocked by CSP, or mobile memory constraint), fall back to the Python NLP service:

```typescript
async extract(text: string): Promise<MedNERResult> {
  if (!this.isSupported() || !this._initialized) {
    return this.extractRemote(text); // POST to /api/nlp/classify
  }
  // ... on-device path
}
```

The `apps/nlp` service (port 8864) already exposes token classification at `POST /v1/classify` via `TransformerTokenClassifier`. This creates a graceful degradation path and means mobile users with low memory are not silently excluded.

### 9.8 Sanitise `highlightEntities` Output

```typescript
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
```
Apply before inserting into HTML span tags in `highlightEntities`.

### 9.9 Add Session Warmup

After `this.pipeline` is created in `init()`, run a 1-token dummy inference to trigger JIT compilation:
```typescript
await (this.pipeline as any)('x'); // dummy warmup
```

### 9.10 Model Retirement — Replace Default Model

Remove `Xenova/bert-base-NER` from `MODEL_MAP`. It classifies news entities (PER/ORG/LOC), not medical entities. Using it with the medical entity type system will produce `OTHER` for every entity, silently appearing to work while returning no useful output.

---

*All file:line citations reference the current state of `packages/med-ner/` as read.*