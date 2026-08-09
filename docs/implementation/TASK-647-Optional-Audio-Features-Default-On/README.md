# TASK-647 — Optional audio features (VAD, noise cancellation, NER/embeddings) are ENABLED by default in the Vox SDK

| Field | Value |
|---|---|
| **Status** | Review |
| **Type** | bugfix |
| **Area** | `packages/agentic-sdk-v2` (`@arcaai/vox`) — config defaults + `compat` fallback; `packages/vad`, `packages/noise-filter`, `packages/med-ner` (downstream) |
| **Reported by** | User (2026-08-09) |
| **Related** | TASK-597 (VAD compat opt-out), TASK-608 (browser DSP switches), TASK-560/561 (compat surface), TASK-506 (model registry), TASK-633 (fail-closed optional telemetry) |

---

## Requirement Analysis

**Reported symptom:** when consuming `@arcaai/vox/compat`, the SDK **always** fetches the `silero_vad` model on the first capture, even for apps that never asked for voice-activity detection.

**Stated requirement (user):** VAD, noise suppression/cancellation, and voice/medical embeddings are **optional** features. They must **not** be enabled by default. A consumer should opt *in* to each heavyweight capability (and its model download), not opt *out*.

**Why this matters:**
- Each optional stage pulls a model/binary at runtime on the first `audio.start()`:
  - **VAD** → Silero ONNX + ONNX-Runtime WASM from the **jsDelivr CDN** (`cdn.jsdelivr.net`).
  - **Noise cancellation** → RNNoise WASM via `@arcaai/noise-filter`.
  - **Medical NER** → `@arcaai/med-ner` (~300 MB peer) when `autoExtract` runs and the peer is present.
- For a **PHI platform**, an unsolicited fetch from a public CDN is a CSP / data-egress concern, not just a bandwidth one.
- On the **backend-STT** path the browser VAD stage is largely wasted work: its `location` is hardwired to `'browser'` and its gate output does **not** gate the backend uplink (`useVadGate` is local-only — see Current State §3). So a backend-STT compat app pays a CDN download and client inference for a gate the backend ignores.

---

## Current State Evaluation

### 1. The SDK-wide defaults enable optional stages

`packages/agentic-sdk-v2/src/types/config.ts:620`
```ts
export const DEFAULT_AUDIO_CONFIG: AudioPluginConfig = {
  noiseFilter: { enabled: true, level: 'medium' },   // ← optional, ON
  vad:         { enabled: true, sensitivity: 0.5 },   // ← optional, ON
  stt:         { enabled: true, provider: 'auto', ... },
};
```

`packages/agentic-sdk-v2/src/types/config.ts:600`
```ts
export const DEFAULT_LOCAL_CONFIG: LocalWorkflowConfig = {
  noiseCancellation: { modelId: 'rnnoise', level: 'medium' },
  vad:  { modelId: 'silero-vad-v5', sensitivity: 0.5 },
  ner:  { modelId: 'biomedical', autoExtract: true },   // ← optional NER auto-runs
  diarization:    { enabled: false, autoEnroll: false }, // already OFF ✔
  voiceEmbedding: { modelId: '' },                        // already OFF ✔
  ...
};
```

So **noise-filter, VAD, and NER auto-extract are ON by default**; diarization and voice embeddings are already off.

### 2. The `compat` fallback path force-enables them

`AgenticProvider` does **not** merge — it substitutes the whole default when no audio config is supplied:

`packages/agentic-sdk-v2/src/providers/AgenticProvider.tsx:337`
```ts
const audioConfig = cfg.audio ?? DEFAULT_AUDIO_CONFIG;   // no-merge substitution
```

The compat adapter only produces a `cfg.audio` object when the v1 config supplies `audioSettings` **or** `sttPipelineId`:

`packages/agentic-sdk-v2/src/compat/config-adapter.ts:43`
```ts
function mapAudioSettings(audio, sttPipelineId): AudioPluginConfig | undefined {
  if (!audio && !sttPipelineId) return undefined;   // ← both absent → undefined
  ...
  // vad key emitted ONLY if audio.voiceActivityDetection !== undefined (line 56)
}
```

Consequence — a v1→compat port that passes **neither** `audioSettings` nor `sttPipelineId` (common: v1 never had a `voiceActivityDetection` field) gets `cfg.audio === undefined` → falls to `DEFAULT_AUDIO_CONFIG` → **VAD + noise-filter ON** → Silero + RNNoise fetched on first `audio.start()`.

The "adapter replaces, does not merge, so omitted stages are OFF" guarantee only holds when an audio object is emitted at all. Its test fixture always sets `sttPipelineId`, so the both-absent branch is uncovered:
`packages/agentic-sdk-v2/src/compat/__tests__/config-adapter.vad.task597.test.ts:95`

### 3. Enablement is correctly lazy — the defect is the DEFAULT, not the loader

The download itself is well-gated and lazy (this part is **not** the bug):
- Stage factory runs only for enabled stages: `TranscriptionPipeline.ts:726` (`getEnabledStages()` filters on `stage.enabled`).
- VAD import is dynamic and runs inside the factory: `TranscriptionPipeline.ts:145` `const { createVAD } = await import('@arcaai/vad');`
- Noise-filter likewise: `TranscriptionPipeline.ts:129` `await import('@arcaai/noise-filter');`
- Silero is fetched at processor init, from the CDN const: `packages/vad/src/processors/VADProcessor.ts:293` (`baseAssetPath ?? DEFAULT_BASE_ASSET_PATH`), `packages/vad/src/constants.ts:40`.

VAD `location` is always `'browser'` and the backend uplink gate is local-only:
- `packages/agentic-sdk-v2/src/core/PluginManager.ts` (`getTranscriptionPipelineConfig` → `vad: { location: 'browser', enabled: vadConfig.enabled ?? false }`).
- `packages/agentic-sdk-v2/src/core/TranscriptionPipeline.ts:168` `const useVadGate = runtimeProvider === 'local' && this.config.vad.enabled;`

### 4. Existing opt-out (workaround available today)

Setting any `audioSettings` key forces an explicit config object, so omitted stages resolve to `{ enabled: false }` via `PluginManager.getConfig()` (`PluginManager.ts:957`):
```tsx
<ArcaCompatProvider options={{ ...SDK_CONFIG_OPTIONS, audioSettings: { voiceActivityDetection: false } }}>
```
There is **no** disable knob for the browser noise-filter stage on the compat surface beyond `audioSettings.noiseSuppression: false` (`config-adapter.ts:48`), and **no** SDK-level way to redirect the VAD asset path off jsDelivr (see Additional Findings).

---

## Impact / Severity

- **Severity:** Medium (correctness + privacy posture; no data loss).
- **Blast radius of a fix:** flipping `DEFAULT_AUDIO_CONFIG` affects **every** `@arcaai/vox` consumer that relies on implicit defaults (not just compat) — `apps/ui-playground`, any core/native SDK consumer, and every compat app that passes no audio config. Apps that today get "free" VAD/NS would get none until they opt in. This is the crux of the plan decision below.

---

## Implementation Plan (APPROVED SCOPE — 2026-08-09)

**Decision (user):** **Option A — flip the platform defaults to OFF**, and **keep STT enabled by default** (STT is the core product, not an optional add-on). Self-hostable VAD/ORT assets (former Option C) is **deferred to a follow-up ticket**, not this one.

**Guiding principle: optional = opt-in.** Only VAD, noise cancellation, and medical-NER auto-extract become opt-in; STT stays on.

### Changes
1. `packages/agentic-sdk-v2/src/types/config.ts:620` — `DEFAULT_AUDIO_CONFIG`:
   - `noiseFilter.enabled: true → false`
   - `vad.enabled: true → false`
   - `stt.enabled: true` (unchanged)
2. `packages/agentic-sdk-v2/src/types/config.ts:600` — `DEFAULT_LOCAL_CONFIG`:
   - `ner.autoExtract: true → false`
   - (`diarization.enabled: false`, `voiceEmbedding.modelId: ''` already off — no change)
3. Docs: update the `config-adapter.ts` header comment (`:35-41`) and compat docs to state the new "optional stages default OFF" behavior.

### TDD (Red → Green)
- **RED first:** a test asserting `createVAD` and `createNoiseFilter` are NOT invoked for a **default** core mount and a **default** (no-audio-config) compat mount — expected to fail against today's defaults.
- Assert each stage is still opt-in-able: `audioSettings.voiceActivityDetection: true` / `noiseSuppression: true` (compat) and `audio.vad.enabled: true` (core) DO load their processors.
- Assert `stt` still enabled by default (no regression to the core path).
- Assert NER does not auto-extract by default; still runs on explicit `autoExtract: true`.

### Consumer audit (behavior change — blast radius)
- `apps/ui-playground` — deprecated, but verify it explicitly enables VAD/NS where it relies on them; add explicit config if it was leaning on the implicit default.
- Any other in-repo `@arcaai/vox` / compat consumer — grep for `AgenticProvider` / `ArcaCompatProvider` without an `audio`/`audioSettings` block.

### Verification
- `pnpm --filter @arcaai/vox build test lint typecheck` green (root: `pnpm sdk:build`).
- New RED test observed failing, then green.
- Manual: a default compat mount performs NO jsDelivr Silero fetch on `audio.start()` (network panel); opt-in path still fetches.

### Deferred (own ticket)
- Plumb `baseAssetPath` / `onnxWASMBasePath` through `TranscriptionPipeline.createVAD(...)` (`:147`) so Silero/ORT can be self-hosted off `cdn.jsdelivr.net` (CSP-friendly for PHI). See Additional Findings.
- Optionally skip the **browser** VAD/NS stages entirely on the **backend-STT** path (browser VAD gate is unused there) — evaluate separately.

---

## Implementation Summary

Implemented via TDD (RED → GREEN).

**Test (RED-first):** `packages/agentic-sdk-v2/src/__tests__/config-defaults.task647.test.ts` — asserts (1) the default config objects declare VAD/noise OFF and STT ON; (2) `PluginManager.getTranscriptionPipelineConfig()` resolves the DEFAULT audio config to VAD/noise disabled, STT enabled; (3) a `TranscriptionPipeline` built from defaults never calls `createVAD`/`createNoiseFilter` (no `@arcaai/vad`/`@arcaai/noise-filter` import, no model fetch), with a positive control proving opt-in still constructs VAD. Confirmed 4/4 failing against the old defaults before the change.

**Source changes:**
- `packages/agentic-sdk-v2/src/types/config.ts` — `DEFAULT_AUDIO_CONFIG`: `noiseFilter.enabled` and `vad.enabled` → `false`; `stt.enabled` unchanged (`true`). `DEFAULT_LOCAL_CONFIG`: `ner.autoExtract` → `false`. Added explanatory comments citing the ticket.
- `packages/agentic-sdk-v2/src/compat/config-adapter.ts` — header comment updated: the `cfg.audio ?? DEFAULT_AUDIO_CONFIG` fallback is now safe (VAD/noise off), so a compat app that supplies neither `audioSettings` nor `sttPipelineId` no longer inherits them or triggers a Silero/RNNoise fetch.

**Consumer audit (behavior-change blast radius) — no edits needed:**
- `apps/compat-playground` — already sets both switches explicitly and defaults each to `false` in its own store; its UI documents "Both are off by default" (`ConnectionTab.tsx:182`). The SDK default now matches that assumption.
- `apps/example` — sets `noiseSuppression: true` explicitly; VAD was already off (an emitted `audioSettings` object leaves the omitted `vad` key resolving to `{enabled:false}`).
- `apps/quick-compat-app` — uses `sttPipelineId`, which already emitted an explicit audio object → VAD/noise already off.
- `apps/admin-console` playground demo — explicitly opts in `vad: { enabled: true }` → still on as intended.
- `apps/ui-playground` (deprecated) — drives audio through its own user-preference system, not the implicit default.

**Verification evidence:**
- `pnpm --filter @arcaai/vox test` → **Test Files 255 passed, Tests 4131 passed** (full suite; the 4 new TASK-647 tests green, no regressions).
- `pnpm --filter @arcaai/vox build` → **Build success** (tsup + dts).
- `pnpm --filter @arcaai/vox typecheck` → clean (`tsc --noEmit`, no errors).
- `pnpm --filter @arcaai/vox lint` → **0 errors** (3 pre-existing unrelated warnings in `useArcaConfig.ts` / `AgenticProvider.tsx`, untouched by this change).

**Net effect:** VAD, noise cancellation, and medical-NER auto-extract are now opt-in. A default `@arcaai/vox` or `@arcaai/vox/compat` mount performs no unsolicited Silero (jsDelivr) / RNNoise fetch on `audio.start()`. Opt in per stage via `audio.vad.enabled` / `audio.noiseFilter.enabled` (core) or `audioSettings.voiceActivityDetection` / `noiseSuppression` (compat).

### Files changed
- `packages/agentic-sdk-v2/src/types/config.ts`
- `packages/agentic-sdk-v2/src/compat/config-adapter.ts`
- `packages/agentic-sdk-v2/src/__tests__/config-defaults.task647.test.ts` (new)

---

## Change History

| Date | Author | Change |
|---|---|---|
| 2026-08-09 | Claude (opus-4.8) | Ticket opened. Root-caused the "compat always downloads silero_vad" report to `DEFAULT_AUDIO_CONFIG`/`DEFAULT_LOCAL_CONFIG` enabling optional stages (VAD, noise-filter, NER auto-extract) by default, plus the no-merge `cfg.audio ?? DEFAULT_AUDIO_CONFIG` fallback in `AgenticProvider`. Documented current state with evidence, blast radius, and three fix options (A: flip defaults, B: compat-only, C: self-hostable assets). Awaiting decision on scope. |
| 2026-08-09 | Claude (opus-4.8) | Scope approved by user: **Option A** (flip global defaults off) with **STT kept on**. Self-hostable assets deferred to a follow-up ticket. Narrowed Implementation Plan to the three config edits + TDD (RED-first: no `createVAD`/`createNoiseFilter` on default mount) + consumer audit. Not yet implemented. |
| 2026-08-09 | Claude (opus-4.8) | Implemented via TDD. Added RED test (`config-defaults.task647.test.ts`, 4/4 failing on old defaults), flipped `DEFAULT_AUDIO_CONFIG` vad/noiseFilter → off and `DEFAULT_LOCAL_CONFIG` ner.autoExtract → off (STT stays on), updated the compat adapter comment. Consumer audit found no app relied on the implicit VAD/NS default (compat-playground & example already treat them as off; quick-compat-app off via pipelineId; admin-console demo explicitly opts VAD on). Verified: full `@arcaai/vox` suite 4131 passed, build success, typecheck clean, lint 0 errors. Status → Review (not yet committed). |

---

## Additional Findings (out of primary scope — noted for follow-up)

- **No self-host path for VAD assets.** `TranscriptionPipeline.createVAD(...)` (`TranscriptionPipeline.ts:147`) does not forward `baseAssetPath`/`onnxWASMBasePath`, so when VAD is enabled the Silero model and ORT WASM are hardwired to `cdn.jsdelivr.net` (`packages/vad/src/constants.ts:40,49`). The `@arcaai/vad` package supports overriding these; the SDK does not plumb them through. Captured as Option C above; can be split into its own ticket.
