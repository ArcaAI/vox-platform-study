# TASK-944 — Cold-start timeouts and secret hot-reload

**Status:** Pending
**Type:** bugfix
**Opened:** 2026-09-10
**Found by:** live verification of the `hope-v2-dev` k3s deployment (pipeline #862, rev `50b2db5`)

## Requirement Analysis

Three defects measured on the live dev cluster. All three share one shape: a value
that must change or be waited on at RUNTIME is fixed at BUILD or BOOT time.

### Lane A — the STT streaming-session timeout is hardcoded, and too short

`packages/applications/src/services/stt/streaming/streamingSession.service.ts:240`
carries a literal `timeout: 15000` on the gateway → STT `POST /internal/streaming/sessions`
call.

Measured 2026-09-10 09:37Z, first session after an STT pod restart:

```
stt.access   POST /internal/streaming/sessions  status_code 201  duration_ms 16870.07
api          StreamingSessionService  "Failed to create streaming session"
             error: "timeout of 15000ms exceeded"   (ECONNABORTED)
api          POST /api/v1/audio/transcription-jobs/stream/session -> 503 in 15027ms
```

STT answered **201** — 1,870 ms after the gateway had already given up. A warm session
is 0.1–0.5 s, so this fails ONLY on the first request after any STT restart, i.e. after
every single deploy. It is also a hardcoded configuration literal, which
`.claude/rules/09-infrastructure-devops.md` §"No hardcoded configuration" forbids
outright.

**Do NOT just raise the number.** It must become a governed value (a
`SettingDescriptor`, `failMode: 'open-to-default'`) or, at minimum, a declared env var
in `turbo.json#globalEnv` plus the relevant `.env.sample`. A bare literal bumped to
30000 re-creates the same defect one restart later.

### Lane B — ~9.3 s of that cold start is a broken optional import

From the same session, `apps/stt`:

```
stt.streaming.session_manager  level=warning
  "Failed to warm embedding model for streaming pipeline"
  error: "Missing required package for HuggingFace loader: Could not import module
          'AutoProcessor'. Are this object's requirements defined correctly?"
```

`wespeaker-voxceleb-resnet34` starts loading at 09:37:15.700 and the warm fails at
09:37:25.033 — **9.33 s burned before the pipeline even reaches whisper**. Fixing this
very likely brings cold start under any sane Lane-A timeout on its own, and it silently
disables the speaker-embedding stage (diarization/voice-profile) as a side effect, which
is a correctness bug in its own right.

Root cause is a dependency shape in the `stt-ml-runtime` image (transformers /
`AutoProcessor` availability), not the model file. Fix the dependency; do not paper over
it by deleting the warm step.

### Lane C — a changed JWT secret cannot be picked up at runtime, and sign/verify diverge

Discovered while closing a Vault↔k8s `JWT_SECRET_KEY` drift on the same cluster. After
writing the new value to Vault:

- the SIGN path picked up the new value within the SecretsService re-warm (~150 s)
- the VERIFY path kept the BOOT-time value indefinitely

Result: `POST /auth/login` issued tokens that every authenticated route then rejected
with 401. Every request 401'd until `hope-api` was restarted. Proven by HMAC-ing a
freshly issued token against both candidate secrets inside the pod: the new value
signed it, and the guard still refused it.

This is a live-rotation trap, and the platform owner is planning a Vault credential
rotation. A JWT-secret rotation today is an auth OUTAGE, not a rolling change.

Decide and document the intended contract, then make the code match it:
either (a) verification resolves the secret per-request through `SecretsService` so a
rotation converges without a restart, honouring a previous-key grace window, or
(b) it is explicitly boot-only, and rotation is documented as requiring a restart —
in which case sign and verify MUST be pinned to the same source so they can never
diverge mid-flight.

Related: `arca:secrets:invalidate` is published by `SettingsRegistryWriteService` but
measured **0 subscribers** on this deployment — nothing attaches the SecretsService
invalidation subscriber, so the documented propagation path is inert and only the TTL
re-warm works. Worth confirming whether that is a wiring bug.

## Implementation Plan

To be written by the implementing agent, into this file, before any code.
TDD per `.claude/rules/01-development-workflow.md` — failing test first, every lane.

## Verification Criteria

- Lane A: a test pins that the timeout comes from configuration, not a literal; the
  cold-start path no longer 503s when STT answers within the configured budget.
- Lane B: `apps/stt` warms the embedding model without the import warning;
  the pre-whisper warm cost is measured before/after and recorded here.
- Lane C: a test proves sign and verify resolve the SAME secret source; the chosen
  rotation contract is documented in `docs/operations/`.
- Gates: `pnpm --filter @arcaai/applications test build`, `pnpm test:unit`,
  `pnpm stt:test`, `pnpm stt:lint`, `pnpm stt:typecheck`, `pnpm lint`.

## Implementation Summary

_pending_

## Change History

| Date | Change |
|---|---|
| 2026-09-10 | Ticket opened from live-cluster verification evidence (three lanes). |
