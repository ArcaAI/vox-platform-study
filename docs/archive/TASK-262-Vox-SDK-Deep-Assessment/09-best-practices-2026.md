# 2026 Best Practices & Emerging Technologies for `@arcaai/vox`
### A Medical-Domain Personalized On-Device STT SDK

> **Priority markers**: `[P1]` = adopt immediately, `[P2]` = adopt in next iteration, `[P3]` = monitor/evaluate.

---

## 1. React 19 Patterns for SDK Authoring

### Core API Changes

React 19 (stable) introduces several primitives relevant to SDK consumer ergonomics:

| API | What it does | SDK relevance |
|---|---|---|
| `use(promise\|context)` | Reads async resources in render; suspends if pending. Can be called conditionally. | Expose SDK state as Suspense-compatible |
| `useActionState(fn, init)` | Returns `[state, action, isPending]`; wraps async mutations | Consumer forms that trigger transcription |
| `useOptimistic(value)` | Shows interim state before server confirms | Streaming partial transcripts |
| `ref` as plain prop | No more `forwardRef`; refs are just props in React 19 | Remove all `forwardRef` from `@arcaai/ui` primitives |

**SDK Authoring rules for React 19:**

- **[P1]** Remove all `forwardRef` wrappers — React 19 refs are regular props. Run the official codemod: `npx codemod react/19/replace-reactdom-render`.
- **[P1]** For SDK state that needs to be Suspense-compatible, expose a `createResource()` factory returning a stable Promise that `use()` can consume. This lets consumers wrap SDK init in `<Suspense fallback={<Spinner/>}>`.
- **[P2]** For streaming transcripts, expose an `useOptimistic`-friendly interface: return the final committed segment AND an in-flight partial segment separately so consumers can show optimistic text that auto-reverts on error.
- **[P2]** Use `useActionState` in internal SDK hooks rather than manual `useState + useTransition` pairs. This reduces boilerplate and is the React 19-idiomatic approach.
- **[P1]** **Server Component compatibility**: Export a `react-server` condition entry in your `package.json` exports map. SDK hooks should live in a clearly-marked `"use client"` boundary. Do not import browser globals (`AudioContext`, `navigator`) at module scope — guard them behind lazy initialization so the module tree is importable in server environments.

**Source**: [React v19 Blog](https://react.dev/blog/2024/12/05/react-19), [React 2026 Guide](https://softaims.com/blog/react-19-server-components-actions-guide-2026)

---

## 2. Zustand 5: Store Architecture

### Key v5 Changes

| Feature | Detail |
|---|---|
| Concurrent safety | Uses `useSyncExternalStore` natively — zero tearing in React 18/19 |
| SSR isolation | Per-request `createStore()` + React Context (not singleton `create()`) |
| Smaller bundle | Dropped legacy compat; leaner than v4 |
| TypeScript | Better combined-store type inference |

### Recommended Architecture for `@arcaai/vox`

```typescript
// slices/audioSlice.ts
export const createAudioSlice = (set, get) => ({
  isRecording: false,
  audioLevel: 0,
  startRecording: async () => { ... },
  stopRecording: () => set({ isRecording: false }),
});

// slices/transcriptSlice.ts
export const createTranscriptSlice = (set, get) => ({
  segments: [],
  pendingText: '',
  appendSegment: (seg) => set(s => ({ segments: [...s.segments, seg] })),
});

// store/index.ts — vanilla store for SSR safety
import { createStore } from 'zustand/vanilla';
export const createVoxStore = (initProps) => createStore((set, get) => ({
  ...createAudioSlice(set, get),
  ...createTranscriptSlice(set, get),
  ...createModelSlice(set, get),
}));

// VoxProvider.tsx — inject via Context
const VoxStoreContext = createContext(null);
export const VoxProvider = ({ children, ...props }) => {
  const storeRef = useRef(createVoxStore(props));
  return <VoxStoreContext.Provider value={storeRef.current}>{children}</VoxStoreContext.Provider>;
};
```

- **[P1]** Use vanilla `createStore()` (not `create()`) for the SDK store — mandatory for SSR compatibility and for SDK consumers using frameworks like Next.js App Router or Remix.
- **[P1]** Use atomic selectors: `useVoxStore(s => s.isRecording)` not `useVoxStore()`. This minimizes re-renders for high-frequency state (audio level updates).
- **[P2]** Apply `useShallow` for multi-field selectors: `useVoxStore(useShallow(s => [s.x, s.y]))`.
- **[P1]** One domain per slice. Suggested slices: `audioSlice`, `transcriptSlice`, `modelSlice`, `personalizationSlice`, `sessionSlice`.

**Source**: [Zustand README](https://github.com/pmndrs/zustand), [SSR patterns DeepWiki](https://deepwiki.com/pmndrs/zustand/6.1-server-side-rendering)

---

## 3. Valibot 1.x vs Zod for SDK Validation

### 2026 Size Comparison

| Library | Min+gzip (full) | Tree-shaken (simple schema) |
|---|---|---|
| Valibot 1.x | ~3 KB | **~1.37 KB** |
| Zod v4 (mini) | ~4 KB | ~6.88 KB |
| Zod v4 (full) | ~17.7 KB | ~12 KB |

### Recommendation

- **[P1]** Use **Valibot 1.x** for all SDK-internal schema validation (config objects, event payloads). A medical SDK must minimize its own footprint — the 90% bundle reduction is real and directly impacts app bundle budgets.
- Valibot v1 runtime performance is ~2× faster than Zod v3 on invalid parses (important for validating the high-volume STT event stream).
- The `@valibot/to-json-schema` adapter exists if you need interop with OpenAPI/JSON Schema.
- Zod v4 remains the correct choice for the `apps/api` NestJS layer where ecosystem (zod-to-json-schema, class-validator adapters) matters more than browser bundle size.

```typescript
import { object, string, number, optional, parse } from 'valibot';

const VoxConfigSchema = object({
  language: optional(string(), 'en'),
  vadThreshold: optional(number(), 0.5),
  noiseReduction: optional(string(), 'deepfilter'),
});
// Bundled cost: ~600 bytes after tree-shaking
```

**Source**: [Valibot comparison guide](https://valibot.dev/guides/comparison/), [PkgPulse 2026](https://www.pkgpulse.com/guides/ajv-vs-zod-vs-valibot-schema-validation-2026)

---

## 4. Whisper on the Browser (2026)

### Model Options

| Model | Params | Browser-ready ONNX | Recommended use |
|---|---|---|---|
| `whisper-large-v3-turbo` | 809M | `onnx-community/whisper-large-v3-turbo` | Best accuracy/speed tradeoff |
| `distil-whisper/distil-large-v3.5-ONNX` | 756M | Yes, official ONNX repo | Drop-in replacement, better WER |
| `whisper-small` / `whisper-base` | 244M/74M | Xenova ONNX repos | Fast, lower-end hardware |
| Moonshine (moonshine-ai/moonshine-js) | ~60M | Native browser JS SDK | Lowest latency, English-focused |

### Transformers.js v3.x / ONNX Runtime Web

- **[P1]** Use `@huggingface/transformers` v3.x with `device: 'webgpu'` + quantized dtype for GPU path:

```typescript
import { pipeline } from "@huggingface/transformers";

const transcriber = await pipeline(
  "automatic-speech-recognition",
  "onnx-community/whisper-large-v3-turbo",
  {
    device: "webgpu",
    dtype: {
      encoder_model: "fp16",       // Keeps < 2GB model size limit
      decoder_model_merged: "q4",  // 4-bit decoder
    },
  }
);
```

- **[P1]** Always set WASM as the automatic fallback. The `browser-whisper` library ([npm](https://registry.npmjs.org/browser-whisper)) demonstrates the pattern: WebGPU → ONNX WASM → error boundary.
- **[P1]** Use the concurrent two-worker pipeline pattern: one worker for audio decoding (WebCodecs or AudioContext fallback), one for ONNX inference. Use `ArrayBuffer` transfer (zero-copy) via `MessageChannel`.
- **[P2]** Model weights should be cached in **OPFS** (Origin Private File System) — faster and more persistent than Cache API. `browser-whisper` 1.0.x migrates from Cache API to OPFS automatically.

### Streaming / Low-Latency

- **[P1]** For real-time medical dictation, implement sliding-window streaming: buffer 5–10s of audio, run VAD, transcribe on speech segment end, yield partial segments as an async iterator.
- **[P2]** **MoonshineJS** (`moonshine-ai/moonshine-js`) — purpose-built browser STT with integrated VAD. ~60M params, streaming mode available. Better first-token latency than whisper-small in browser due to architectural design. Currently in beta but promising for real-time use.
- **[P3]** **Kyutai STT** (1B/2.6B) — `kyutai/stt-1b-en_fr` is architecturally designed for streaming (delayed-streams modeling). Has built-in semantic VAD. Currently requires a backend server (Rust WebSocket). Not yet browser-native (PyTorch/MLX only), but WebAssembly port is plausible.

### distil-whisper v3.5

- **[P2]** `distil-whisper/distil-large-v3.5-ONNX` was released March 2025, trained on 4× more data than v3 with SpecAugment — better OOD robustness. Suitable as a drop-in upgrade over distil-large-v3.

**Sources**: [Transformers.js WebGPU guide](https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/guides/webgpu.md), [whisper-large-v3-turbo ONNX](https://huggingface.co/onnx-community/whisper-large-v3-turbo), [MoonshineJS](https://github.com/moonshine-ai/moonshine-js), [Kyutai STT](https://kyutai.org/stt)

---

## 5. Voice Activity Detection (VAD): 2026 State

### Comparison

| Library | WASM size | Latency | Precision vs Silero |
|---|---|---|---|
| **TEN-VAD** (TEN-framework) | 277 KB (Web) | RTF 0.010 on M1 | Superior (fewer missed silences) |
| Silero VAD v5 via `@ricky0123/vad-web` | 2.2 MB ONNX | Slight delay (multi-hundred ms) | Baseline |
| WebRTC VAD | Native | Very low | Lower precision |

### Recommendations

- **[P1]** **Switch from Silero VAD to TEN-VAD** for new installations. TEN-VAD is:
  - 277 KB vs 2.2 MB — 87% smaller
  - Lower RTF (0.010 vs 0.013+ on equivalent hardware)
  - Faster speech-to-nonspeech transition detection (critical for clinical dictation where Silero's multi-hundred-ms delay causes clipping)
  - npm: `@gooney-001/ten-vad-lib` (WASM wrapper), or use the official TEN-framework WASM build
  - Requires 16kHz audio, 256-sample frames (16ms), threshold 0.0–1.0

- **[P2]** Keep `@ricky0123/vad-web` (Silero v5) as a fallback / A-B testing option since it has more production maturity.

- **[P1] User-specific VAD threshold calibration**: The SDK should expose a `calibrateVAD(durationMs: number)` method that records ambient noise, computes a local noise floor, and adjusts threshold ±0.1 from the user's baseline. Store calibrated threshold in `localStorage` or encrypted IndexedDB per user profile.

**Source**: [TEN-VAD GitHub](https://github.com/TEN-framework/ten-vad), [ricky0123 VAD docs](https://docs.vad.ricky0123.com/user-guide/browser/)

---

## 6. Audio Noise Suppression: RNNoise vs DeepFilterNet vs facebook/denoiser

### 2026 Browser Status

| Library | WASM/WebGPU | Real-time capable | Package |
|---|---|---|---|
| **DeepFilterNet3** | WASM + SIMD (v1.2.0+) | Yes (AudioWorklet) | `deepfilternet3-noise-filter` |
| RNNoise | WASM | Yes | `@shiguredo/rnnoise-wasm` |
| facebook/denoiser | Not browser-native | No | Server-only |

### Recommendations

- **[P1]** **Use DeepFilterNet3** (`deepfilternet3-noise-filter` ≥ 1.2.0, based on `mezonai/mezon-noise-suppression`). Reasons:
  - Significantly better noise suppression quality than RNNoise in clinical environments (keyboard, HVAC, crowd noise)
  - v1.2.0+ has SIMD128 + bulk-memory WASM (20-30% faster than v1.1.x)
  - Ships as a self-contained AudioWorklet — no bundler config required
  - Works in Chrome 91+, Firefox 89+, Safari 16.4+
  - Configurable `noiseReductionLevel` (0–100)

```typescript
const filter = new DeepFilterNoiseFilterProcessor({
  sampleRate: 48000,
  noiseReductionLevel: 75, // tunable per-session
  enabled: true,
});
```

- **[P3]** RNNoise (`@shiguredo/rnnoise-wasm`) remains a viable lighter fallback (~90KB WASM vs ~17MB for DeepFilterNet3 model). Use RNNoise if the model size is prohibitive for the deployment context.

**Source**: [deepfilternet3-noise-filter npm](https://libraries.io/npm/deepfilternet3-noise-filter), [mezonai/mezon-noise-suppression](https://github.com/mezonai/mezon-noise-suppression), [boredland/noise](https://github.com/boredland/noise)

---

## 7. AudioWorklet Best Practices: SharedArrayBuffer + Atomics

### Architecture

The authoritative pattern (Google Chrome AudioWorklet design guide) uses:

```
AudioWorklet (real-time thread)
    ↕ SPSC ring buffer (SharedArrayBuffer + Atomics)
Web Worker (non-real-time thread)
    → WASM inference / ONNX / model execution
```

### Critical Rules

- **[P1]** Use a **lock-free SPSC ring buffer** (`ringbuf.js` or equivalent). The `Atomics.wait()` call is **not available** in `AudioWorkletGlobalScope` — never block the audio thread.
- **[P1]** For transferring PCM frames: use `ArrayBuffer` transfer in `postMessage()` (zero-copy). For the ring buffer itself, use a `SharedArrayBuffer` backed `Float32Array`.
- **[P1]** Handle underflow gracefully: output silence or repeat the last frame — do NOT throw or allocate in the process callback.
- **[P1]** **COOP/COEP headers are mandatory** for `SharedArrayBuffer`. Your deployment must serve:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
  All cross-origin subresources (CDN-loaded WASM, HuggingFace model chunks) must include `Cross-Origin-Resource-Policy: cross-origin` or `CORS` headers. Verify `window.crossOriginIsolated === true` at runtime and gate SAB usage on this check.
- **[P2]** For pre-React-19 legacy deployments that cannot serve COOP/COEP (e.g., embedded in an iframe third-party page), fall back to `MessageChannel` polling with `postMessage` instead of SAB ring buffers. Accept the latency penalty.

```typescript
// Runtime guard
if (!crossOriginIsolated) {
  console.warn('[vox] SharedArrayBuffer unavailable — using postMessage fallback');
  useFallbackAudioTransport();
}
```

**Source**: [Chrome AudioWorklet design pattern](https://developer.chrome.com/blog/audio-worklet-design-pattern), [ringbuf.js](https://github.com/padenot/ringbuf.js/), [COOP/COEP guide 2026](https://uper.pl/en/blog/coop-coep-corp-cross-origin-isolation/)

---

## 8. Medical NER On-Device (2026)

### Available Models

| Model | Size | Browser-runnable | Notes |
|---|---|---|---|
| **GLiNER-BioMed-small** | Small encoder | Via `@lmoe/gliner-onnx` | Zero-shot, Apache 2.0 |
| GLiNER-BioMed-base | Base encoder | Via ONNX export | Best F1 / speed tradeoff |
| GLiNER v2.x general | Small–large | `onnx-community/gliner_small-v2.1` | General-purpose fallback |
| Bio_ClinicalBERT-v2 | 110M | Transformers.js ONNX | Classification head, not span NER |

### Recommendation

- **[P2]** Use **GLiNER-BioMed** (`Ihor/gliner-biomed-base-v1.0`) running via `@lmoe/gliner-onnx` (published Feb 2026). This provides:
  - Zero-shot recognition of arbitrary medical entity types with natural-language labels: `["Disease", "Drug", "Dosage", "Lab test", "Procedure", "Demographic"]`
  - 5.96% F1 improvement over prior SOTA on biomedical benchmarks (arXiv:2504.00676)
  - ONNX-compatible, runs on Node.js or browser (with ONNX Runtime Web)
  - Apache 2.0 license — commercial-safe

```typescript
import { GLiNER1ONNXRuntime } from '@lmoe/gliner-onnx';

const model = await GLiNER1ONNXRuntime.fromPretrained('onnx-community/gliner_small-v2.1');
const entities = await model.predict({
  text: "Patient takes 10mg lisinopril for hypertension",
  labels: ["Drug", "Dosage", "Disease"],
  threshold: 0.5
});
```

- **[P3]** For richer clinical context, consider running a quantized **BioMistral-mini** or **Phi-3.5-mini** via WebLLM/WebGPU for complex entity relationship extraction. However, model sizes (2-4GB) make this impractical for most browser deployments — a cloud hybrid is more realistic.

**Source**: [GLiNER-BioMed paper](https://arxiv.org/html/2504.00676), [@lmoe/gliner-onnx npm](https://registry.npmjs.org/@lmoe/gliner-onnx), [GLiNER repo](https://github.com/urchade/GLiNER)

---

## 9. Personalization for Medical STT

### A. Per-User Vocabulary / Hot-Word Biasing

- **[P1]** **Decoder prompt injection** is the most practical approach for on-device Whisper in 2026. Whisper's decoder accepts a `prompt` token sequence injected before decoding. Pass a concise list of domain-specific terms (doctor's name, specialty-specific medications, procedure names) as the initial prompt context:

```typescript
await transcriber(audio, {
  language: "en",
  task: "transcribe",
  initial_prompt: "Dr. Nguyen. metformin hydrochloride. laparoscopic cholecystectomy."
});
```

- **[P2]** For production-quality biasing, reference the **B-Whisper** / **CB-Whisper** approach (arXiv:2502.11572): fine-tune Whisper on contextual biasing with instruction-tuning to improve rare-word recall by 45–60% without per-user retraining. This is a one-time server-side fine-tune that produces a shared biasable model.

### B. Speaker Adaptation with LoRA

- **[P2]** The **PQM strategy** (arXiv:2309.09136) demonstrates that per-speaker LoRA adapters on quantized Whisper achieve 15-23% WER reduction with NF4 quantization. Each user profile stores a tiny LoRA weight delta (~0.5–2MB).
- For `@arcaai/vox`, the architecture is: ship a base quantized model, allow optional per-user LoRA sidecar loadable from the cloud (downloaded after consent, stored encrypted in OPFS).

### C. Domain-Specific Fine-Tuning

| Approach | Tradeoff |
|---|---|
| Full fine-tune Whisper on medical corpora | Best WER, requires server GPU, one shared model |
| LoRA per specialty (cardiology, oncology, etc.) | Small sidecar per specialty, minimal base model change |
| LoRA per user (S2-LoRA) | 0.02% trainable params, per-user WER improvement, cloud fine-tune feasible |

- **[P2]** **S2-LoRA** (arXiv:2309.11756) achieves speaker adaptation with only 0.02% trainable parameters — making cloud fine-tuning fast enough (~minutes per user) for a personalized medical dictation product.

### D. VAD Threshold Calibration

- **[P1]** Implement a 5-second ambient noise sampling routine on first session per device. Compute RMS noise floor, map to a recommended VAD threshold. Persist in `localStorage` or encrypted IndexedDB. Re-calibrate if ambient noise floor shifts by >3dB across sessions.

**Sources**: [CB-Whisper paper](https://arxiv.org/html/2309.09552v3), [B-Whisper paper](https://arxiv.org/html/2502.11572v2), [PQM LoRA](https://ar5iv.labs.arxiv.org/html/2309.09136), [S2-LoRA](http://arxiv.org/pdf/2309.11756v1)

---

## 10. Tree-Shaking, ESM Dual-Build: tsdown (tsup Successor)

### 2026 Tooling Landscape

- **[P1]** **Migrate from tsup to tsdown** (Rolldown-based). tsup is officially in maintenance mode ("not actively maintained anymore"). tsdown is the community-endorsed successor with 3-10× faster builds.

Migration steps:
```bash
npx tsdown-migrate   # auto-renames config + updates imports
pnpm build           # verify output
```

### Canonical `package.json` exports map for `@arcaai/vox`

```json
{
  "name": "@arcaai/vox",
  "sideEffects": false,
  "exports": {
    ".": {
      "react-server": "./dist/index.react-server.mjs",
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs"
      },
      "require": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.cjs"
      }
    },
    "./worker": {
      "import": "./dist/worker.mjs"
    }
  },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts"
}
```

- **[P1]** `"sideEffects": false` on the root, OR specify an array of files that DO have side effects (AudioWorklet registration scripts). Incorrect `sideEffects: false` on worklet scripts will cause bundlers to drop them.
- **[P1]** Expose the `react-server` export condition returning a stub that throws a clear error when SDK hooks are called server-side.
- **[P1]** Run `publint` and `are-the-types-wrong` in CI to catch mismatched export conditions before publishing.
- **[P2]** Use `tsconfig.json` `"isolatedDeclarations": true` — enables parallel `.d.ts` emission, significantly faster in tsdown.

**Source**: [tsup maintenance notice](https://registry.npmjs.org/tsup), [tsdown migration guide](https://tsdown.dev/guide/migrate-from-tsup), [tree-shaking with tsup/tsdown](https://dorshinar.me/posts/treeshaking-with-tsup), [2026 bundler comparison](https://www.pkgpulse.com/guides/tsup-vs-tsdown-vs-unbuild-typescript-library-bundling-2026)

---

## 11. WebGPU Browser Availability Matrix (2026)

| Browser | Stable WebGPU | OS requirements |
|---|---|---|
| Chrome/Edge 113+ | ✅ Windows, macOS, ChromeOS | Direct3D 12 / Metal |
| Chrome 121+ | ✅ Android 12+ | Qualcomm/ARM GPUs |
| Chrome 144+ | ✅ Linux (Intel Gen12+) | Vulkan required |
| Firefox 141+ | ✅ Windows | — |
| Firefox 145+ | ✅ macOS (Apple Silicon) | macOS Tahoe 26+ |
| Safari 26 | ✅ macOS/iOS/iPadOS/visionOS 26 | macOS Tahoe 26 / iOS 26 |
| Firefox (Linux/Android) | Behind flags | Enable `gfx.webgpu.ignore-blocklist` |

**Global availability (2026)**: ~75-80% of browser sessions.

### Fallback Strategy for `@arcaai/vox`

```typescript
// Tier detection at SDK init
async function detectRuntime(): Promise<'webgpu' | 'wasm-simd' | 'wasm'> {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        device.destroy();
        return 'webgpu';
      }
    } catch {}
  }
  // Check SIMD support
  const simd = await WebAssembly.validate(new Uint8Array([
    0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11
  ]));
  return simd ? 'wasm-simd' : 'wasm';
}
```

- **[P1]** Implement the three-tier fallback: WebGPU → WASM-SIMD → WASM. Emit a `runtimeDetected` event so consumers can show an appropriate "Loading..." or "Slower mode" notice.
- **[P1]** For Safari 26 / macOS Tahoe 26 — Intel Mac users on older macOS silently fall through to WASM. Do not assume WebGPU just because the user is on macOS.

**Source**: [web.dev WebGPU announcement](https://web.dev/blog/webgpu-supported-major-browsers), [gpuweb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status), [WebGPU 2026 compatibility guide](https://webo360solutions.com/blog/webgpu-browser-support/)

---

## 12. Privacy / HIPAA-Aligned Patterns for On-Device Audio

### Core Principles

- **[P1]** **Never transmit raw audio without explicit user consent**. The processing pipeline must complete on-device (VAD → noise reduction → Whisper → NER). Only transmit the final transcript or structured data, never audio frames.
- **[P1]** **Model consent state in SDK**: `VoxSession.create({ audioConsent: 'device-only' | 'cloud-assist' })`. Expose this visibly to consumers.

### Storage

- **[P1]** **Do not persist raw audio by default**. Only persist if the user explicitly opts in via a `storeAudio: true` flag. Auto-delete raw audio after transcription by default.
- **[P1]** When persisting ANY audio or transcript to IndexedDB, encrypt first using `crypto.subtle`:

```typescript
// AES-GCM 256 + PBKDF2 key derivation
async function encryptAudio(buffer: ArrayBuffer, userKey: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    userKey,
    buffer
  );
  return { iv, encrypted }; // store both in IndexedDB
}
```

- **[P2]** Use **OPFS** (Origin Private File System) for model weight caching — it has stronger isolation than IndexedDB and is not accessible via `indexedDB.databases()`. This also mitigates CVE-2026-6770 (Firefox IndexedDB ordering leak, patched in FF 148+ but illustrates the risk).
- **[P1]** Store user personalization data (LoRA weights, vocabulary lists, VAD calibration) in OPFS under a hashed/non-identifiable filename. Never use PII in database names.

### Audit Events

- **[P2]** Emit an audit-log event for each processing step: `{ type: 'audio_captured', timestamp, durationMs, retainedRaw: false }`. Let consumers forward this to their HIPAA audit trail.

### HTTPS / Context

- **[P1]** `crypto.subtle` requires a secure context (HTTPS or `localhost`). Fail fast with a clear error if `window.isSecureContext === false`.

**Source**: [VoiceVault privacy model](https://github.com/NakliTechie/VoiceVault), [browser-whisper OPFS caching](https://registry.npmjs.org/browser-whisper), [TetraScript64 AES-GCM pattern](https://github.com/Haarya/TetraScript64), [CVE-2026-6770 IndexedDB](https://ppc.land/firefox-private-browsing-flaw-let-ad-trackers-fingerprint-tor-users/)

---

## 13. WebSocket Reconnect: Exponential Jitter + Resumability Tokens

### Recommended Implementation

```typescript
class ReconnectingVoxSocket {
  private delay = 500;             // ms
  private readonly maxDelay = 30_000;
  private attempts = 0;
  private readonly maxAttempts = 12; // ~2 minutes total window
  private resumeToken: string | null = null;
  private lastSeq = 0;

  private nextDelay(): number {
    const base = Math.min(this.delay * 2 ** this.attempts, this.maxDelay);
    // Full jitter: uniform [0, base] — avoids thundering herd better than ±50% jitter
    return Math.random() * base;
  }

  onOpen() {
    this.attempts = 0;
    this.delay = 500; // reset
    if (this.resumeToken) {
      this.send({ type: 'resume', token: this.resumeToken, lastSeq: this.lastSeq });
    }
  }

  onClose() {
    if (this.attempts >= this.maxAttempts) {
      this.emit('disconnected_permanent');
      return;
    }
    setTimeout(() => this.connect(), this.nextDelay());
    this.attempts++;
  }

  onMessage(msg) {
    this.lastSeq = msg.seq;
    if (msg.resumeToken) this.resumeToken = msg.resumeToken;
  }
}
```

- **[P1]** Use **full jitter** (`Math.random() * cappedDelay`) rather than ±50% jitter. Full jitter has better theoretical properties for thundering herd prevention (AWS whitepaper).
- **[P1]** **Resumability tokens**: server issues an opaque `resumeToken` on connect. On reconnect, client sends `{ type: 'resume', token, lastSeq }`. Server replays messages since `lastSeq` from a bounded TTL buffer (5 minutes, max 1000 messages).
- **[P1]** **Token pre-refresh**: if JWT expiry < reconnect window (cap 30s × 12 retries ≈ 2 min), refresh the access token BEFORE attempting reconnect. Do not connect with a stale token.
- **[P2]** **Application-level staleness detection**: track `lastMessageReceivedAt`. If `Date.now() - lastMessageReceivedAt > 3 × expectedGapMs`, treat connection as stale and force reconnect even if the socket shows `OPEN`. This catches half-open TCP connections that TCP keepalive misses.
- **[P2]** Emit a user-visible `connectionState` change: `'connected' | 'reconnecting' | 'degraded' | 'offline'`. Medical users need clear status indicators.

**Source**: [websocket.org reconnection guide](https://websocket.org/guides/reconnection/), [oneuptime 2026 reconnect guide](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view), [stale connection detection](https://dev.to/mixa_dev/your-websocket-says-connected-but-stopped-sending-data-heres-the-bug-tcp-keepalive-cant-catch-5424)

---

## Priority Summary for `@arcaai/vox`

### P1 — Adopt Immediately

| Area | Action |
|---|---|
| React 19 | Remove `forwardRef`; expose `react-server` export condition; guard browser globals behind lazy init |
| Zustand 5 | Migrate to vanilla `createStore()` + Context provider; atomic selectors; slices architecture |
| Valibot 1.x | Replace Zod in SDK internals for all config/event validation |
| Whisper/Transformers.js | Ship `onnx-community/whisper-large-v3-turbo` with `encoder_model: fp16, decoder: q4`; WebGPU → WASM fallback |
| browser-whisper pattern | Two-worker concurrent pipeline (audio decode + ONNX inference) with zero-copy ArrayBuffer transfer |
| TEN-VAD | Replace Silero VAD; implement user VAD calibration |
| DeepFilterNet3 v1.2+ | Replace RNNoise as default noise suppressor |
| AudioWorklet SAB | Lock-free SPSC ring buffer; enforce COOP/COEP; graceful underflow |
| COOP/COEP headers | Gate SAB on `crossOriginIsolated === true`; document deployment requirements |
| WebGPU fallback | Three-tier: WebGPU → WASM-SIMD → WASM; emit `runtimeDetected` event |
| Privacy | No raw audio transmission; no default audio persistence; AES-GCM encrypt before IndexedDB; OPFS for models |
| WebSocket | Full jitter exponential backoff; resumability tokens; token pre-refresh |
| tsdown | Migrate from tsup; canonical exports map with `react-server` condition; `sideEffects: false` (or granular) |

### P2 — Next Iteration

| Area | Action |
|---|---|
| MoonshineJS | Evaluate as lower-latency Whisper alternative for real-time dictation |
| distil-whisper v3.5 | Evaluate ONNX variant as drop-in for better OOD medical vocabulary |
| GLiNER-BioMed | Integrate for client-side medical entity extraction |
| LoRA personalization | Cloud-side per-user fine-tune pipeline (S2-LoRA); store encrypted sidecar in OPFS |
| B-Whisper hot-word biasing | Prompt-based contextual biasing with specialty vocabulary lists |
| `use()` Suspense pattern | Expose SDK init as Suspense-compatible resource |
| OPFS model caching | Migrate from Cache API to OPFS for all model weights |
| Audit events | Emit HIPAA audit-log events from the SDK processing pipeline |

### P3 — Monitor

| Area | Action |
|---|---|
| Kyutai STT | Watch for browser-native port; architecturally ideal for low-latency streaming |
| GLiNER v3 / Million-Label NER | arXiv:2602.18487 — bi-encoder architecture, scaling to millions of labels |
| WebGPU compute shaders | Direct GLSL/WGSL pipelines for VAD/NER (bypass ONNX RT overhead) |
| Firefox Linux/Android WebGPU | Mozilla targeting 2026 for stable Linux; track for expanded device support |

---