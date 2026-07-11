# TASK-491 — SDK TTS Playback Hook (`useTtsPlayback`)

| | |
|---|---|
| **Status** | `Review` — implemented + unit-verified 2026-07-11; browser playback is a manual/consuming-app check |
| **Type** | `feature` — browser SDK (`@arcaai/vox`) audio playback |
| **Created** | 2026-07-11 |
| **Parent** | [TASK-488 — Realtime TTS Service](../TASK-488-Realtime-TTS-Service/README.md) §6 follow-up #1 (Q5-prioritized) |
| **Branch** | `feature/488-tts-service` (shared with TASK-488) |

## 1. Requirement Analysis

TASK-488 built the TTS service + gateway proxy: `POST /api/v1/speech/synthesize` streams raw PCM (s16le / 24 kHz / mono) when `stream_format:"audio"`. But `@arcaai/vox` is **capture-only** — nothing in the browser plays synthesized audio. This ticket adds the consumer that makes the **summary read-aloud** use case audible end-to-end (TASK-488 Q5).

**Requirements**
- R1 — A `useTtsPlayback` hook: `speak(input, { voice })`, `stop()`, and reactive `isPlaying` / `isLoading` / `error` state.
- R2 — Gapless streaming playback: pump PCM chunks into Web Audio as they arrive (AudioWorklet ring buffer), not buffer-then-play.
- R3 — Reuse SDK conventions: internal `useAgenticStore()`, `AgenticClient` auth, `@arcaai/room` `AudioContextManager` + `createWorkletLoader`, plugins entry export. No new UI kit, no store-object leakage.
- R4 — Robust to the shared-AudioContext sample-rate (capture may hold 48 kHz; TTS is 24 kHz) → resample to the context rate before playback.
- R5 — Reset playback state on tenant switch / logout (mirrors `activeStream`).

## 2. Current State Evaluation (SDK map, 2026-07-11)

- Hooks import internal `useAgenticStore()` from `'../store'` (full-state destructure); **no `"use client"`** (tsup `banner` injects it). Return one `useMemo({ ...state, ...actions })`.
- `AgenticClient` (`src/core/AgenticClient.ts`) buffers JSON on the normal path; `getBlob`/`getCsv` are the **manual-`fetch` templates** (build headers via `resolveAuthToken` → Bearer + `X-API-Key`/`X-Tenant-ID`/correlation, `AbortController`, `classifyHttpError`). No streaming method exists yet → add one that returns the raw `Response` (so `.body` streams).
- Gateway contract: `POST /api/v1/speech/synthesize`, `@Authorize()` (Bearer JWT), body `{ input, voice, response_format?, speed?, stream_format? }`, pipes upstream bytes with `no-store, no-transform` + `X-Accel-Buffering: no` (genuinely incremental).
- `@arcaai/room` exports `AudioContextManager.getInstance({sampleRate}).acquire()` and `createWorkletLoader({generateSource,label})` (blob-URL + double-register guard). Existing worklets are all **capture** (input); no playback ring-buffer worklet exists — this is the first.
- Tests: vitest jsdom; mock `'../../store'`, `vi.stubGlobal('AudioContext', Mock)`, mock `fetch`/client returning a fake `Response` whose `.body.getReader()` yields chunks. `renderHook` + `act`.
- A placeholder `TTSPluginConfig { enabled; voiceId?; rate? }` exists in `src/types/config.ts`.

## 3. Design Decisions

- **DD-1** — PCM→playback split: the TS `TtsPlaybackPlayer` converts PCM16 bytes → float32, resamples 24 kHz → `audioContext.sampleRate` (linear interp), and `postMessage`s float32 frames to the worklet; the worklet is a dumb ring buffer that emits `outputs[0][0]`. Keeps the worklet trivial + testable and sidesteps the shared-context rate collision.
- **DD-2** — Client returns the raw `Response` (mirror `getBlob`, skip `.blob()`); the player pumps `response.body.getReader()`. No 401-refresh retry (foreground action, repeatable — same as `getBlob`).
- **DD-3** — Default `stream_format:"audio"`, `response_format:"pcm"`. (wav/mp3 would need decode; PCM is the realtime path.)
- **DD-4** — Store slice `ttsIsPlaying`/`ttsIsLoading`/`ttsError` + setters, reset in `clearTenantSessionData`. Hook exported from `plugins.ts` (audio stays out of `core`); type-only from `core.ts`.
- **DD-5** — Out of scope: word-timestamp highlighting, SSE mode, wav/mp3 playback, a demo UI component (belongs to the consuming app).

## 4. Implementation Plan (TDD)

Files (per SDK map):

| Action | Path |
|---|---|
| CREATE | `src/core/ttsPlaybackWorklet.ts` — worklet source + `createWorkletLoader` registration + node factory (`numberOfInputs:0, outputs:1`) |
| CREATE | `src/core/TtsPlaybackPlayer.ts` — acquire ctx, register/create node, PCM16→float32 + resample, `enqueue`/`flushEnd`/`stop`, `onended` |
| CREATE | `src/hooks/useTtsPlayback.ts` — `speak`/`stop` + `isPlaying`/`isLoading`/`error` |
| EDIT | `src/core/AgenticClient.ts` — `synthesizeSpeech(input, {voice,response_format?,speed?,stream_format?}, {signal?}) → Promise<Response>` |
| EDIT | `src/core/constants.ts` — `SPEECH_ENDPOINTS` |
| EDIT | `src/store/agenticStore.ts` — tts slice + setters + `initialState` + initializer + `clearTenantSessionData` reset |
| EDIT | `src/plugins.ts` — `export { useTtsPlayback }`; `src/core.ts` — `export type { UseTtsPlayback }` |
| CREATE | tests: `hooks/__tests__/useTtsPlayback.test.ts`, `core/__tests__/AgenticClient.synthesizeSpeech.test.ts`, `core/__tests__/TtsPlaybackPlayer.test.ts` |

TDD list: client posts to `/speech/synthesize` with Bearer + `input`/`voice` body, returns Response; player converts PCM16→float32 + resamples + enqueues, stop() tears down; hook `speak` sets loading→playing, `stop` resets, errors surface to `ttsError`.

**Gate**: `pnpm --filter @arcaai/vox test lint typecheck build` green. Browser playback is a manual/CI check (jsdom has no real Web Audio) — noted, same posture as the TASK-488 Azure live gate.

## 5. Implementation Summary — ✅ (2026-07-11)

**Created**
- `src/core/ttsPlaybackWorklet.ts` — the **first playback AudioWorklet** in the repo (ring buffer, `numberOfInputs:0`), registered via `@arcaai/room`'s `createWorkletLoader` (inline source → blob URL, double-register guard); emits silence on underrun + a one-shot `{type:'ended'}` once drained.
- `src/core/TtsPlaybackPlayer.ts` — acquires the shared 24 kHz `AudioContext`, `pcm16ToFloat32` + `resampleLinear` (24 kHz → ctx rate), carries an odd trailing byte across chunk boundaries, posts Float32 frames; `start`/`enqueuePcm16`/`end`/`stop`.
- `src/hooks/useTtsPlayback.ts` — `speak(input, {voice, speed})` streams `apiClient.synthesizeSpeech` (PCM / `stream_format:"audio"`) into the player; `stop()`; reactive `isPlaying`/`isLoading`/`error`.

**Edited**
- `AgenticClient.synthesizeSpeech()` — mirrors the `getBlob` manual-fetch (auth via `resolveAuthToken` → Bearer, timeout, `classifyHttpError`), returns the raw streaming `Response`; POST body uses `input`/`voice`. `SPEECH_ENDPOINTS` constant.
- Store: `ttsIsPlaying`/`ttsIsLoading`/`ttsError` slice + setters + `initialState` + `clearTenantSessionData` reset (playback stops on tenant switch).
- `plugins.ts` exports the hook + `UseTtsPlayback`/`SpeakOptions` types (audio stays out of `core`).

**Evidence**

```
vitest (3 suites)                → 14 passed
tsc --noEmit                     → 0 errors
eslint src                       → clean (new files)
pnpm --filter @arcaai/vox build  → success; useTtsPlayback in dist/plugins.js, 0 occurrences in dist/core.js
```

Tests cover: client request shape (POST `/speech/synthesize`, Bearer + `input`/`voice` body, format/speed overrides, non-ok → `AgenticError`); DSP correctness (`pcm16ToFloat32` s16le decode, `resampleLinear` no-op + 2× upsample); player lifecycle (acquire/register/connect, resampled chunk post, odd-byte carryover, stop teardown); hook orchestration (loading→streaming→playing, SDK-not-initialized, stop reset, error surfacing).

**Manual / CI check (not runnable here):** actual audible gapless playback in a real browser — jsdom has no Web Audio, so the unit tests mock `AudioContext`/`AudioWorkletNode`. Same posture as TASK-488's Azure live gate; verify in the consuming app once the gateway + a provider are live.

## 6. Change History

| Date | Change | Author |
|---|---|---|
| 2026-07-11 | Ticket created (TASK-488 follow-up #1); SDK surface mapped; plan written | Claude (Fable 5) + Tap Huynh |
| 2026-07-11 | Implemented (§5): playback AudioWorklet + `TtsPlaybackPlayer` (PCM→float32, resample, odd-byte carryover), `useTtsPlayback` hook, `AgenticClient.synthesizeSpeech`, `SPEECH_ENDPOINTS`, store slice + tenant-reset, `plugins` export. Evidence: 14 vitest, tsc 0 errors, eslint clean, vox build success (hook in plugins not core). Status → Review | Claude (Fable 5) + Tap Huynh |
