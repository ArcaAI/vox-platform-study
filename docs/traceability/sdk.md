# Traceability — Browser SDK & Audio Packages

The `@arcaai/vox` browser consultation SDK and the audio packages it composes: capture →
backend streaming STT → live documentation, driven from the browser against the gateway's
session / WS / SSE surfaces. The browser runs no model (SDK 4.0.0, TASK-1006): VAD, denoise,
diarization and ASR are server-side, chosen by the tenant's published ASR Agent. Migrates legacy
matrix row **35**.

The SDK is a **client-side consumer** of capabilities documented in other domain files — it
owns no gateway routes or Prisma models. Test shorthand is defined in
[`index.md`](./index.md#test-location-shorthand). `—` means verified-absent.

Architecture (rule 08): each `AgenticProvider` mount creates its own private Zustand store;
consumers read only through the public hook layer. The SDK ships three entry points (`.`, `./core`,
`./plugins`) that keep audio code out of `/core`. Server-side
tenancy stays authoritative; the SDK's per-tenant namespacing is defense-in-depth.

## Capabilities

### SDK1 — Consultation SDK (`@arcaai/vox`)

| Field | Value |
|---|---|
| App / service | `packages/agentic-sdk-v2` (`@arcaai/vox`) — client-side |
| Key modules | `packages/agentic-sdk-v2/src` (`core/` provider + store + `AgenticClient`/`SttWebSocketClient`/`SSEClient`, ~45 `hooks/`, `store/agenticStore.ts`); entry points `@arcaai/vox` (full), `@arcaai/vox/core` (no audio code), `@arcaai/vox/plugins` (audio hooks + `PluginManager`) |
| Prisma models | — (client-side; server owns persistence) |
| Consumes (gateway surfaces) | consultation `session.open` → `POST /consultations/open` ([`consultation.md`](./consultation.md)); live STT WS `/ws/stt/stream` + stream ticket ([`transcription.md`](./transcription.md)); summary + live-documentation SSE ([`summarization.md`](./summarization.md), [`consultation.md`](./consultation.md)); auth refresh / stream-ticket ([`auth-identity.md`](./auth-identity.md)) |
| Tests | pkg unit: `packages/agentic-sdk-v2/src/**/__tests__/*` (hooks, store, clients — Vitest + `renderHook`, mocked `AudioContext`/`MediaStream`/workers); e2e: `tests/e2e/sdk/sdk-api.e2e.spec.ts` (SDK API against the live gateway) + package-local Playwright (`packages/agentic-sdk-v2/e2e/playwright.config.ts`, `pnpm --filter @arcaai/vox test:e2e`) |

### SDK2 — Audio packages (capture / streaming transport / pipeline)

| Field | Value |
|---|---|
| App / service | browser packages composed by `@arcaai/vox` |
| Key modules | `@arcaai/room` (`packages/room` — capture, `AudioTrack`, `AudioMixer`), `@arcaai/stt` (`packages/stt` — capture helpers + the backend streaming transport), `@arcaai/pipeline` (`packages/pipeline` — sequential/parallel processing primitives) |
| Prisma models | — |
| Tests | pkg unit: `packages/{room,stt,pipeline}/src/**/__tests__/*` (e.g. `AudioContextManager.test.ts`, `AudioMixer.test.ts`, `ParallelPipeline.test.ts`) |

## Honest notes / gaps

- **No server routes or models.** The SDK composes capabilities owned elsewhere; its "endpoints" are the gateway surfaces it consumes, cross-referenced above rather than re-owned.
- **No in-browser models.** `@arcaai/vad`, `@arcaai/noise-filter`, `@arcaai/med-ner`, the `@arcaai/vox/plugins/med-ner` entry and the Whisper worker were deleted in 4.0.0 (TASK-1006); `audio.start({ agentSlug })` names the ASR Agent and the gateway resolves the rest (rule 08). Bundle-size figures are deliberately not cited (they drift).
- **The console playground is a separate consumer.** The tier-50–59 playground screens (`apps/admin-console/src/features/playground-*`) consume this SDK; they are inventoried in [`admin-console.md`](./admin-console.md) (AC3) and, for the STT-backed ones, [`transcription.md`](./transcription.md).
- **e2e depends on a live gateway.** `tests/e2e/sdk/sdk-api.e2e.spec.ts` and the package-local Playwright suite require the API on `http://localhost:8868` (`pnpm build && playwright test`).
- **The integrator-facing documentation is one guide.** [`docs/guides/client-integration-guide.md`](../guides/client-integration-guide.md) covers both SDKs end to end — credentials, codegen, open, stream, the review gate, approve, close, completion signals — with chapter 10 mapping every server-side step to its browser equivalent. `docs/architecture/clinician-integration-guide.md` and `docs/consultation-context-schema-integration-guide.md` are pointer stubs to it. Every snippet longer than a few lines is a compiled file under `packages/vox-node/examples/`, type-checked by `pnpm --filter @arcaai/vox-node typecheck`; `pnpm docs:check` verifies every scope, refusal code and SDK method name the guides quote against the code.

Last verified: 2026-09-29
