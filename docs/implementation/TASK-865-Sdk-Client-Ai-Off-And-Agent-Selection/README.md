# TASK-865 — SDK Vox & Vox-node: client-side AI off by default, agent/workflow selection, deprecations

| | |
|---|---|
| **Status** | Review |
| **Type** | refactor |
| **Program** | [TASK-859 — AI Platform Consolidation](../TASK-859-Ai-Platform-Consolidation-Program/README.md) |
| **Packages** | `packages/agentic-sdk-v2` (`@arcaai/vox`), `packages/vox-node`, `packages/vad`, `packages/noise-filter`, `packages/stt`, `packages/med-ner`, `apps/admin-console/src/features/playground-*` |
| **Depends on** | TASK-861 (ASR Agent replaces `pipelineId`), TASK-863 (Agent invoke API) |
| **Rules** | `08-vox-sdk.md`, `07-react-ui.md`, `13-nextjs-apps.md` |
| **Created** | 2026-09-04 |

## 1. Requirement Analysis

Owner directive (2026-09-04):

> By default, disable all local/client-side AI capabilities such as VAD, noise suppression. Therefore, no need to load VAD model or any AI models in the client side.

Restated as verifiable outcomes:

1. **No AI model is fetched or executed in the browser unless a host application explicitly opts in.** "AI model" means: Silero VAD (ONNX + onnxruntime-web WASM), RNNoise (WASM), in-browser Whisper (Transformers.js worker), WavLM speaker-verification (Transformers.js), and browser medical NER. Native `getUserMedia` constraints (`noiseSuppression`, `echoCancellation`, `autoGainControl`) are **not** AI models and stay on: they cost nothing, load nothing, and improve capture quality.
2. **The SDK's default consultation path is backend-only.** Audio goes to the gateway's STT stream; VAD, denoising, diarization and ASR run server-side, selected by the tenant's **ASR Agent** (TASK-861/863), never by a client-side pipeline id.
3. **The admin console's own consumers respect the default.** No first-party screen may hard-enable a client model.
4. **The client AI packages are marked deprecated**, kept importable for two releases, and then removed (program deprecation policy, TASK-859 §6).
5. **`@arcaai/vox-node` gains the agent invocation surface** so a server integrator can call a published Agent (LLM / TTS / batch ASR) and a published Workflow with the same client, and confirm it still ships zero runtime dependencies and zero client AI.

Out of scope: the browser SDK's consultation hooks (`useArcaSession`, `useArcaLiveSummary`, `useConsultationEvents`, `useArcaLiveAssist`) — they are already backend-driven and change only where the pipeline-id contract changes.

## 2. Current State Evaluation

Verified 2026-09-04 against source; every claim below has a file citation.

### 2.1 What is already default-off (keep, and lock harder)

| Capability | Default | Where | Evidence |
|---|---|---|---|
| RNNoise noise filter plugin | **OFF** | `DEFAULT_AUDIO_CONFIG.noiseFilter.enabled = false` | `packages/agentic-sdk-v2/src/types/config.ts:636-644` |
| Silero VAD plugin | **OFF** | `DEFAULT_AUDIO_CONFIG.vad.enabled = false` | same |
| In-browser Whisper STT | **OFF platform-wide** | `LOCAL_TRANSCRIPTION_ENABLED = false`; `resolveSTTRuntimeProviderLocalDisabled()` never returns `'local'` and throws `LOCAL_TRANSCRIPTION_DISABLED` when no backend transport exists | `packages/agentic-sdk-v2/src/core/constants.ts:615`, `core/TranscriptionPipeline.ts:626,667-716` |
| Browser medical NER | OFF (`ner.autoExtract: false`), isolated entry `@arcaai/vox/plugins/med-ner` | `types/config.ts` local config; `core/PluginManager.ts:328` lazy `import('@arcaai/med-ner')` | |
| Model loading trigger | Lazy: stage factories run `import('@arcaai/vad')` / `import('@arcaai/noise-filter')` only inside `TranscriptionPipeline.start()` and only for stages with `enabled: true` | `core/TranscriptionPipeline.ts:118-215, 726-730` | |
| Pinning test | `config-defaults.task647.test.ts` asserts VAD + noise-filter OFF, STT ON | `packages/agentic-sdk-v2/src/__tests__/config-defaults.task647.test.ts` | |

Conclusion: the SDK's **library defaults already satisfy the directive**. The directive is not met in practice because of the three items below.

### 2.2 What still loads client models

| # | Finding | Evidence |
|---|---|---|
| F-1 | The flagship **Consultation Scribe playground hard-enables both client models**: `audio: { noiseFilter: { enabled: true }, vad: { enabled: true }, stt: { enabled: true, provider: 'backend' } }`. Every admin who opens `/playground/consultation` downloads the Silero ONNX + onnxruntime WASM from jsDelivr and instantiates RNNoise, while the backend runs its own Silero VAD per 512-sample frame anyway (`apps/stt/src/stt/streaming/preprocessor.py:1-9`). Double VAD, double download, no benefit. | `apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx:196-201` |
| F-2 | **VAD assets come from a public CDN at runtime**: `DEFAULT_BASE_ASSET_PATH = https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.30/dist/`, `DEFAULT_ONNX_WASM_BASE_PATH = https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/`. In a clinical deployment behind Cloudflare/CSP this is an egress the platform does not control. Once client VAD is off by default this becomes a deprecated code path rather than a CSP exception. | `packages/vad/src/constants.ts:22,29` |
| F-3 | **`useLocalVoiceEmbedding`** runs WavLM speaker verification in the browser via Transformers.js. Opt-in (a hook the host must call), but it is exported from the root entry and documented as a peer of the server path. | `packages/agentic-sdk-v2/src/hooks/useLocalVoiceEmbedding.ts:1-20` |
| F-4 | The **`/plugins` entry re-exports `useVAD`, `useSTT`, `useNoiseFilter`** from the peer packages, so a host that imports `@arcaai/vox/plugins` for `useArcaAudio` also gets three hooks whose only purpose is client inference. | `packages/agentic-sdk-v2/src/plugins.ts:39-46` |
| F-5 | `PluginManager` and `TranscriptionPipeline` JSDoc examples still show `noiseFilter: { enabled: true }`, `vad: { enabled: true }`, `stt: { provider: 'auto' }` — the documented example contradicts the default. | `packages/agentic-sdk-v2/src/core/PluginManager.ts:174-176` |
| F-6 | A **second, unrelated config surface** (`AudioConfigSchema` in `core/ConfigSchema.ts:25-29`) has `noiseSuppression: true`, `echoCancellation: true`, `autoGainControl: true`, `vadEnabled: false`. These are native `getUserMedia` constraints (`packages/room/src/processors/NativeProcessor.ts:50-52`). They are **correct and stay on**; the naming collision with the RNNoise plugin (`noiseFilter`) is the confusion to document, not a defect to fix. |

### 2.3 Transcription selection still keys on a pipeline id

| # | Finding | Evidence |
|---|---|---|
| F-7 | `AudioStartOptions.pipelineId` is the switch to backend streaming and is POSTed in the `POST /audio/transcription-jobs/stream/session` body; the WS URL carries only `sessionId`/`ticket`/`tenantId`. | `packages/agentic-sdk-v2/src/types/audio.ts:152,265,317`, `core/StreamingSessionManager.ts:106,150-190` |
| F-8 | `usePipelines()` (`list/get/getBySlug/select`) and the per-user `selectedPipelineId` preference (`PATCH /users/me/settings/arcaai-sdk/selectedPipelineId`) expose `AsrPipeline` rows to clinicians. TASK-861 retires the resource; these hooks retire with it. | `packages/agentic-sdk-v2/src/hooks/usePipelines.ts`, `useArcaPipelines.ts`; `docs/architecture/clinician-integration-guide.md` §1.1 |
| F-9 | The v1-compat layer (`compat/config-adapter.ts:29-68`, `useArcaSpeechToText`, `BatchTranscriptionQueue`) re-derives `sttPipelineId`. | `packages/agentic-sdk-v2/src/compat/**` |
| F-10 | `AudioStartOptions` is not exported from any entry point (integration guide §1.2 warns "annotating it will not compile"). | `docs/architecture/clinician-integration-guide.md` §1.2 |

### 2.4 `@arcaai/vox-node`

| Fact | Evidence |
|---|---|
| `dependencies: {}`; only `@opentelemetry/api` peer — zero client AI, confirmed | `packages/vox-node/package.json` |
| Workflow invocation exists: `hope.workflows.{list,run,runAndWait,runAndStream,getRun,cancelRun,streamRun,waitForRun}` → `POST /api/v1/workflows/{slug}/runs?mode=async|blocking|stream`, `GET …/runs/{runId}[/stream]` | `packages/vox-node/src/resources/workflows.ts` |
| Consultation-bound invocation exists: `hope.consultations.workflows.*` → `POST /api/v1/consultations/{id}/workflows/{slug}/runs` | same file |
| **No agent invocation surface** — there is no published-Agent concept yet (TASK-863) | — |
| Admin resources are generated from the route manifest; `hope.admin.audioPipeline.*` retires automatically when TASK-861 removes the routes and `gen:admin` reruns | `packages/vox-node/src/resources/admin/audio-pipeline.ts` (generated) |

### 2.5 Bundled assets

| Asset | Where | Size | Fate |
|---|---|---|---|
| `rnnoise.wasm` | `packages/noise-filter/assets/rnnoise.wasm` (LFS) | ~110 KB | deprecated with the package; the CI LFS smudge special-case (`.gitlab/ci` "smudge only rnnoise.wasm") goes with it |
| Whisper worker | `packages/stt/dist/workers/whisper.worker.mjs` | ~1.2 MB + 2 MB map | deprecated; weights were never bundled (fetched by Transformers.js at runtime) |
| Silero ONNX / ORT WASM | not bundled; jsDelivr at runtime | — | deprecated path |

## 3. Target Design

### 3.1 The rule, stated once

> The browser captures audio and renders results. It never runs a model.

Consequences:

- `@arcaai/vox` core + plugins ship **no inference**. `useArcaAudio` captures via `@arcaai/room` (native constraints on), streams PCM to the gateway, and renders the transcript the backend returns.
- Selection of *what transcribes* is a **server-side decision** made by the tenant's ASR Agent (TASK-861/863): the client passes an optional `agentSlug` (a lineage key, like `workflowDefinitionSlug` at `open()`), or nothing and lets the assignment cascade decide. The client never names a pipeline, an engine, a model or a VAD.
- Anything that *must* stay client-side for a genuine product reason (none identified today) is an explicit, documented opt-in behind a separate entry point, never a default.

### 3.2 Deprecation set (mark now, remove after two releases)

| Item | Deprecation marker | Replacement |
|---|---|---|
| `@arcaai/vad` package | `package.json#deprecated`, README banner, `@deprecated` JSDoc on `useVAD` | server-side VAD (ASR Agent `audioFrontEnd.vad`) |
| `@arcaai/noise-filter` package | same | server-side denoise (ASR Agent `audioFrontEnd.denoise`) |
| `@arcaai/stt` (browser Whisper worker) | same | backend streaming ASR |
| `@arcaai/med-ner` + `@arcaai/vox/plugins/med-ner` entry | same | `apps/nlp` via the realtime lane (`agent.ner`) |
| `useLocalVoiceEmbedding` | `@deprecated` JSDoc + console warning on first call | `useVoiceEmbedding` (server enrol) |
| `AudioStartOptions.pipelineId`, `usePipelines`, `useArcaPipelines`, `selectedPipelineId` user setting, `useSttProviderToggle` | `@deprecated` JSDoc; runtime warning when `pipelineId` is passed | `AudioStartOptions.agentSlug` (optional), `useSelectableAsrAgents()` (TASK-863) |
| `TranscriptionPipeline` local stages (`noiseFilter`, `vad`, local `stt` factory), `LOCAL_TRANSCRIPTION_ENABLED`, `DEFAULT_LOCAL_CONFIG` model pins (`rnnoise`, `silero-vad-v5`) | `@deprecated`; the constant stays `false` | remove with the packages |
| v1-compat `sttPipelineId` mapping (`compat/config-adapter.ts`) | `@deprecated`; maps to `agentSlug` when a slug is supplied | — |

Deprecation is recorded in the program register (`docs/operations/deprecation-register.md`, TASK-859 §6) with the release in which removal happens.

### 3.3 New / changed public surface

**`@arcaai/vox`**

```ts
// audio.start — pipelineId deprecated, agentSlug added. Both optional.
await audio.start({ agentSlug?: string; language?: string; deviceId?; secondaryDeviceId? });

// Export the option type so hosts can annotate it (closes F-10).
export type { AudioStartOptions } from './types/audio';

// Discovery of what the tenant may select, same predicate as session-open (TASK-863).
const { agents, tenantDefault } = useSelectableAsrAgents(); // GET /audio/agents (business plane)
```

`AgenticConfig.audio` keeps `noiseFilter` / `vad` / `stt.provider` for two releases but the runtime **ignores `enabled: true` for the two client stages and logs a deprecation warning** — the directive is "off by default and nothing loads", so an explicit `true` from an old host must not silently re-enable a model download. A host that genuinely needs client VAD in that window sets `audio.clientInference: { allow: true }` (new, explicit, documented as deprecated on arrival).

**`@arcaai/vox-node`**

```ts
hope.agents.list()                                    // GET  /api/v1/agents
hope.agents.invoke(slug, input, { mode })             // POST /api/v1/agents/{slug}/invocations?mode=blocking|stream
hope.agents.invokeAndStream(slug, input)              // SSE frames
hope.agents.transcribe(slug, file, opts)              // POST /api/v1/agents/{slug}/transcriptions  (batch ASR → job)
hope.agents.synthesize(slug, text, opts)              // POST /api/v1/agents/{slug}/speech           (TTS → audio artifact)
```

Routes are defined by TASK-863; the SDK methods are hand-authored (business plane), while `hope.admin.agent.*` is generated by `gen:admin`.

### 3.4 Console consumers

- `consultation-demo-screen.tsx`: `audio: { stt: { enabled: true, provider: 'backend' } }` only; remove the two hard-enables (F-1). `audio.start({ agentSlug })` replaces `audio.start({ pipelineId })`; the footer's "Transcription Agent" picker (`scribe/scribe-footer.tsx`) binds to `useSelectableAsrAgents()`.
- `playground-live-transcription`: same substitution.
- `account-screen.tsx`: the "selected pipeline" row becomes "selected transcription agent" or is dropped (the preference retires with `selectedPipelineId`).

## 4. Implementation Plan

TDD, in this order. Each step names its RED test first.

| # | Step | RED test | Files |
|---|---|---|---|
| 1 | Extend the defaults pin: `PluginManager.getEnabledStages()` with `DEFAULT_AUDIO_CONFIG` never contains `vad`/`noiseFilter`; `TranscriptionPipeline.start()` under defaults never calls `import('@arcaai/vad')`/`import('@arcaai/noise-filter')` (mock `import`) | `config-defaults.task647.test.ts` (extend) | `packages/agentic-sdk-v2/src/__tests__/` |
| 2 | Hard-off gate: an explicit `vad.enabled: true` without `clientInference.allow` is ignored + warns | new `client-inference-gate.test.ts` | `core/TranscriptionPipeline.ts`, `types/config.ts` |
| 3 | `AudioStartOptions.agentSlug` plumbed to `StreamingSessionManager.createSession` body (`agentSlug`), `pipelineId` still accepted with a deprecation warning | `StreamingSessionManager.test.ts` (extend) | `types/audio.ts`, `core/StreamingSessionManager.ts`, `hooks/useAudioCapture.ts` |
| 4 | Export `AudioStartOptions` from `core` + root; `check:exports` green | `exports.test.ts` | `src/core.ts`, `src/index.ts` |
| 5 | `useSelectableAsrAgents()` hook over the TASK-863 business route; `null` vs `[]` states distinct (integration-guide rule) | `useSelectableAsrAgents.test.ts` | `hooks/` |
| 6 | Deprecation markers: `@deprecated` JSDoc on every item in §3.2, `package.json#deprecated` on the four packages, README banners; lint rule `no-restricted-imports` for `@arcaai/vad`/`noise-filter`/`stt`/`med-ner` inside `apps/admin-console` | `deprecations.test.ts` asserts the markers exist (string presence) | packages + `packages/config-eslint` |
| 7 | Console: remove hard-enables, switch playground + scribe footer + account screen to `agentSlug`/`useSelectableAsrAgents` | existing screen tests updated (`consultation-demo-screen`, `scribe-footer`, `naming.test.ts` wording) | `apps/admin-console/src/features/playground-*`, `account` |
| 8 | vox-node `hope.agents.*` resource (hand-authored) + `check:exports`; regenerate `hope.admin.*` after TASK-863 lands routes | `resources/__tests__/agents.test.ts` | `packages/vox-node/src/resources/agents.ts` |
| 9 | Docs: `packages/agentic-sdk-v2/README.md`, `packages/vox-node/README.md`, `docs/architecture/clinician-integration-guide.md` §1 rewritten ("Pick an agent"), rule `08-vox-sdk.md` gains "the browser never runs a model" | — | docs |
| 10 | Deprecation register entries with removal release | — | `docs/operations/deprecation-register.md` |

### Verification criteria

- `pnpm sdk:build` (build + test + lint + typecheck for `@arcaai/vox`) green; `pnpm sdk-node:build` green; `pnpm --filter @arcaai/vox check:exports` green.
- A Playwright run of `/playground/consultation` shows **zero** network requests to `cdn.jsdelivr.net` and zero `*.onnx` / `*.wasm` fetches (proof for the directive).
- `grep -rn "enabled: true" apps/admin-console/src --include=*.tsx | grep -E "vad|noiseFilter"` returns nothing.
- Backend transcription still works end to end from the playground (live transcript renders) with `agentSlug` omitted (cascade default) and with an explicit slug.

## 5. Open questions for the owner

1. **Keep any client-side inference at all?** Recommendation: none. If a demo needs offline capture, that is a separate opt-in package outside the platform SDK.
2. **Remove `@arcaai/vad` / `@arcaai/noise-filter` / `@arcaai/stt` / `@arcaai/med-ner` from the monorepo at removal time, or archive as unpublished packages?** Recommendation: delete; git history keeps them.
3. **`useLocalVoiceEmbedding`**: deprecate now (recommended) or keep as the one sanctioned client model? It is the only client model with a stated product rationale (offline quick-test).

## 6. Implementation Summary

Implemented 2026-09-04 on branch `task-865-sdk-client-ai-off` (worktree `hope-v2-task-865`, base `dev-2.2` @ `1896ebc03`), TDD, one commit per plan step. All ten plan steps landed; the console's `build` gate is blocked by a pre-existing error outside this ticket (see below).

### What changed, per step

| # | Step | Outcome |
|---|---|---|
| 1 | Defaults pin | `DEFAULT_TRANSCRIPTION_PIPELINE_CONFIG` flipped both client stages OFF (the pipeline-level fallback had `enabled: true`); `config-defaults.task647.test.ts` extended (pipeline-level defaults, bare `PluginManager`, bare `TranscriptionPipeline`). |
| 2 | Hard-off gate | `TranscriptionPipeline` ignores `noiseFilter.enabled` / `vad.enabled` unless `clientInference: { allow: true }`; warns ONCE per pipeline naming the ignored stages. `AudioPluginConfig.clientInference` (deprecated on arrival) forwarded by `PluginManager`. New `client-inference-gate.task865.test.ts`. |
| 3 | `agentSlug` | `AudioStartOptions.agentSlug`, `STTPluginConfig.agentSlug`, `PluginManagerRuntimeOptions.agentSlug`, `CreateStreamingSessionRequest.agentSlug`; `StreamingSessionManager.normalizeSelection` is the single chokepoint (both → `agentSlug` only + warn; `pipelineId` alone → sent + deprecation warn; neither → no selector). `@arcaai/stt` transport/provider/session-like accept `agentSlug`, `pipelineId` optional, no throw without one. An explicit `provider: 'backend'` with nothing named now opens a selector-less session (gateway resolves the tenant default, TASK-861). |
| 4 | Exports | `AudioStartOptions` was already exported from `/core` + root (F-10 closed before this branch); the export test now pins `agentSlug` from both barrels. `ClientInferenceConfig`, `AudioPluginStageName`, `SelectableAgent`/`SelectableAsrAgent`/`AgentTask` exported. No `check:exports` script exists for `@arcaai/vox`. |
| 5 | `useSelectableAsrAgents()` | `GET /agents?task=SPEECH_TO_TEXT`; `null` ≠ `[]`; non-ASR rows dropped; exported from hooks barrel, `/core`, root. |
| 6 | Deprecations | `@deprecated TASK-865 — removed in R4` on every §3.2 item; `package.json#deprecated` + README banner on `@arcaai/vad`/`noise-filter`/`stt`/`med-ner`; `useLocalVoiceEmbedding` console-warns once; compat `sttAgentSlug` added (wins over `sttPipelineId`); `@arcaai/config-eslint` `flat/next.js` bans the client-AI imports in the console (`@arcaai/stt` keeps `createAudioCapture`/`float32ToInt16`); `deprecations.task865.test.ts` pins every marker + its removal release. |
| 7 | Console | Scribe: hard-enables removed (F-1), picker on `useSelectableAsrAgents`, `audio.start({ agentSlug })` or nothing (cascade), footer label "Transcription agent", `naming.test.ts` updated, orphaned `useAudioPipelines` plumbing removed. Live Transcription: picker on `GET /agents?task=SPEECH_TO_TEXT`, session + batch bodies send `agentSlug` only when picked, no agent required. Account: "Assigned transcription agent". |
| 8 | `hope.agents` | `packages/vox-node/src/resources/agents.ts` (hand-authored): `list/get/invoke/invokeAndStream/synthesize/transcribe`; transport passes `FormData` through; `AGENT_PLANE_ROUTES` + contract test that skips until TASK-863's manifest rows exist; `TODO(TASK-864)` on both stream-option surfaces. |
| 9 | Docs | `@arcaai/vox` README ("The browser never runs a model"), `@arcaai/vox-node` README ("Invoking agents"), integration guide §1 ("Pick an agent"), rule `08-vox-sdk.md` new section. |
| 10 | Register | SDK rows → `marked` (+ `clientInference` and compat `sttPipelineId` rows). |

### Gate evidence (actual output, 2026-09-04)

```
$ pnpm sdk:build            Tasks: 7 successful, 7 total   (build + dts)
$ pnpm sdk:test             Test Files 282 passed (282) · Tests 4373 passed (4373)
$ pnpm sdk:lint             ✖ 1 problem (0 errors, 1 warning)   ← pre-existing prettier warning in src/hooks/useRoles.ts (0 diff vs base)
$ pnpm sdk:typecheck        Tasks: 7 successful, 7 total
$ pnpm --filter @arcaai/vox-node build   ESM/CJS/DTS ⚡️ Build success
$ pnpm --filter @arcaai/vox-node test    Test Files 25 passed (25) · Tests 365 passed | 10 skipped (375)   ← skipped = agents contract suite awaiting TASK-863 manifest rows
$ pnpm --filter @arcaai/vox-node check:exports   attw: node10 🟢 · node16 CJS 🟢 · node16 ESM 🟢 · bundler 🟢 · publint: All good!
$ pnpm --filter @arcaai/vad test           Test Files 9 passed (9)  · Tests 205 passed
$ pnpm --filter @arcaai/noise-filter test  Test Files 15 passed (15) · Tests 186 passed
$ pnpm --filter @arcaai/stt test           Test Files 27 passed (27) · Tests 446 passed
$ (admin-console) npx vitest run           Test Files 263 passed (263) · Tests 2343 passed (2343)
$ (admin-console) eslint src --max-warnings 0   ✖ 1 error — src/features/ai-platform/components/__tests__/ai-platform-screen.test.tsx:366 (pre-existing, 0 diff vs base, not owned by this ticket)
$ (admin-console) tsc --noEmit             1 error — src/features/ai-platform/components/huggingface-fetch-drawer.tsx(32,45) TS2339 (pre-existing, 0 diff vs base)
$ pnpm --filter @arcaai/admin-console build   "Failed to type check." on the SAME pre-existing ai-platform error; Turbopack compiled successfully in 9.0s; 5 Edge-runtime WARNINGS in instrumentation.ts (pre-existing, 0 diff vs base)
$ pnpm sdk-node:build       FAILS in the DEPENDENCY @arcaai/vox-node-codegen (src/schema-to-ts.ts(234,10) TS2322) — 0 diff vs base; the package-level vox-node build above is green
$ grep -rn "enabled: true" apps/admin-console/src --include=*.tsx | grep -E "vad|noiseFilter"   → (nothing)
```

Not run (out of the worktree's remit): Playwright proof of zero `cdn.jsdelivr.net` / `*.onnx` / `*.wasm` requests from `/playground/consultation`, and the end-to-end backend transcription check — both need a running stack and land with the orchestrator's integration pass after TASK-861/863 merge.

### Cross-ticket contracts this branch codes against

- **TASK-861** — `POST /audio/transcription-jobs/stream/session` and `POST …/transcribe` accept `agentSlug?: string` and make `pipelineId` optional. Today's gateway DTO still REQUIRES `pipelineId` and `forbidNonWhitelisted` rejects `agentSlug`, so a console session opened with an explicit agent (or none) 400s until 861 merges.
- **TASK-863** — `GET /agents[?task]`, `GET /agents/{slug}`, `POST /agents/{slug}/invocations?mode=blocking|stream`, `POST /agents/{slug}/speech`, `POST /agents/{slug}/transcriptions` — business plane, `svcScopes: []`. Row shape coded: `{ slug, name, description, task, versionNumber, isTenantDefault, inputSchema?, outputSchema?, protocols? }` under `{ data: [...] }`. The blocking invocation response is assumed `{ output, …extra }`.
- **TASK-864** — `TODO(TASK-864)` on `UseWorkflowRunOptions` (vox) and `StreamRunOptions` (vox-node) where a socket transport option lands.

### Deviations / decisions to confirm

1. `naming.test.ts` lives in `features/agents/**` (not in this ticket's ownership list) but the brief named it explicitly; only its wording/assertion changed.
2. `provider: 'auto'` with nothing named keeps its pre-865 resolution (no transport ⇒ `LOCAL_TRANSCRIPTION_DISABLED`). Widening `'auto'` to auto-open a backend session on the tenant default is a behaviour change left for an owner decision (the scribe and live playgrounds use an explicit `'backend'`).
3. `useLocalVoiceEmbedding` deprecated now (README §5 Q3 recommendation), with a console warning on first use.
4. No SDK version bump was made; recommendation: `@arcaai/vox` and `@arcaai/vox-node` 3.0.0 → 3.1.0 together at the next `publish-sdk` run (additive surface + deprecations, no removals).
5. The scribe's transcription picker has no explicit "clear" affordance yet (`ModelSelector` without `noneOption`) — a reload returns to the cascade default; the live-transcription picker has an explicit "Tenant default" option.

## 7. Change History

| Date | Change |
|---|---|
| 2026-09-04 | Ticket created from the TASK-859 review: current-state evidence, target design, plan. |
| 2026-09-04 | Implemented steps 1–10 on `task-865-sdk-client-ai-off` (9 commits); status → Review. Console `build` gate blocked by a pre-existing `ai-platform` type error; `sdk-node:build` blocked by a pre-existing `vox-node-codegen` DTS error — both 0 diff vs base, reported to the orchestrator. |
