# TASK-485 — Default Streaming Pipeline Missing LocalAgreement-2 (Tentative Tail Inactive on the Clinician Default)

- **Status**: Completed -- root-caused (production config lacked the LA-2 block) + fixed (commit_policy: local_agreement_2 appended to PIPELINE_CONFIGS.production) + verified (reseed DB-confirmed, @arcaai/database 809 passed RED->GREEN); only the owner's own push/PR to main remains (per owner directive, they land it)
- **Type**: bugfix (config / seed — realtime UX parity)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · Discovered during the SOTA enhancement track (2026-07-10)
- **Origin**: [TASK-471 — Tentative-Tail Render](../TASK-471-Tentative-Tail-Render/README.md) review (MINOR). TASK-471 A1 added the `commit_policy: local_agreement_2` streaming block to `best_practice_realtime` + `turbo`, but **not** to `production` — the config the `isDefault` pipeline uses.
- **Finding + severity**: **Low (MINOR)** — the TASK-471 tentative-tail render only activates on the realtime/turbo pipelines; the **default** pipeline (`production-whisper-large-v3`, which is also the default **streaming** slug) never emits `stable_chars`, so the clinician on the default path sees no tentative tail. No correctness/PHI impact; a realtime-UX parity gap.
- **Size**: S
- **Suggested agent**: `database-admin` (Prisma seed / config) or a general backend agent — a small seed edit plus a short streaming-path trace and a re-seed. Decision-gated (see below).

## Requirement Analysis

TASK-471 activated LocalAgreement-2 so partials carry `stable_chars` and the already-built tentative-tail render lights up. It was applied to two pipeline configs. The **default** pipeline uses a third config (`production`) that did **not** receive the streaming block. If the live consultation surface streams through the default pipeline, the feature TASK-471 shipped is dark on the primary clinician path.

**Decision point (must resolve before editing):** *Is `production-whisper-large-v3` actually used for live streaming?* The seed says yes by default — `streaming_pipeline_slug = production-whisper-large-v3` (see §Current State). If confirmed (and it is a streaming/real-time pipeline, not merely a batch default), add the LA-2 `commit_policy` streaming block to `PIPELINE_CONFIGS.production` so the tentative tail is active for the default clinician path. If the live surface always selects `best-practice-realtime`/`turbo` (e.g. the SDK passes an explicit `pipelineId`), then this is documentation-only — record that and close.

### Acceptance criteria

- [ ] **AC-1 (trace + decide)**: trace which pipeline the live consultation surface mints its streaming session with — the SDK `audio.start({ pipelineId })` path and the gateway/STT resolution of the `stt.config/defaults/streaming_pipeline_slug` setting — and record whether the default (`production-whisper-large-v3`) is the effective live-streaming pipeline. This is the go/no-go for AC-2.
- [ ] **AC-2 (conditional fix)**: **iff** the default is used for live streaming, append the `streaming:` block with `commit_policy: local_agreement_2` to `PIPELINE_CONFIGS.production` in `packages/database/src/prisma/db_main/seed/06-stt.ts`, mirroring the block already on `turbo` (`:1250-1253`) and `best_practice_realtime` (`:1430-1433`). Commit logic is unchanged — LA-2 only makes partials carry `stable_chars`.
- [ ] **AC-3 (re-seed evidence)**: `pnpm db:seed` (or test-DB `pnpm test:db:seed`) re-run; the default pipeline's `configYaml` now carries the streaming block. Paste evidence.
- [ ] **AC-4 (verify tentative tail on default)**: with the default pipeline selected, a live/streamed partial carries `stable_chars` and the tentative tail renders — the same verification TASK-471 used for realtime/turbo, now on the default path.
- [ ] **AC-5**: `pnpm --filter @arcaai/database test` green (seed shape unchanged apart from the YAML string).

### Non-goals

- Changing which pipeline `isDefault` (still `production-whisper-large-v3`, TASK-361) or the batch default.
- Altering the LA-2 commit semantics or the tentative-tail render (both shipped in TASK-471).
- Adding the streaming block to non-streaming/batch configs (`best_practice_batch`, `faster_whisper_turbo_int8`, lightweight, etc.).

## Current State Evaluation (code-verified against `fix/2605-review`)

All references in `packages/database/src/prisma/db_main/seed/06-stt.ts`:

- **`PIPELINE_CONFIGS.production` (`:1089-1141`)** — the config used by the default pipeline. It ends at postprocessing/`dual_capture` (`:1138-1141`); there is **no `streaming:` / `commit_policy` block**. (Confirmed by reading the full block: models → preprocessing → inference → postprocessing, no streaming section.)
- **`PIPELINE_CONFIGS.turbo` (`:1210-1254`)** — carries the block: `streaming:` (`:1250`) → `commit_policy: local_agreement_2` (`:1253`), with the TASK-471 A1 comment (`:1251-1252`).
- **`PIPELINE_CONFIGS.best_practice_realtime` (`:1379-1434`)** — carries the same block: `streaming:` (`:1430`) → `commit_policy: local_agreement_2` (`:1433`).
- **Default pipeline row (`:1646-1661`)** — `slug: 'production-whisper-large-v3'` (`:1650`), `configYaml: PIPELINE_CONFIGS.production` (`:1652`), **`isDefault: true` (`:1659`)**. So the sole default resolves to the `production` config that lacks LA-2.
- **Streaming default setting (`:2129-2142`)** — `key: 'streaming_pipeline_slug'`, `value: 'production-whisper-large-v3'`, `defaultValue: 'production-whisper-large-v3'` (`:2134-2139`). The batch default (`:2118-2128`) points at the same slug. Comment (`:2135-2137`): "both batch + streaming defaults point at the resolvable production-whisper-large-v3 pipeline."
- **`STT_DEFAULT_PIPELINE_SLUG = 'production-whisper-large-v3'` (`:2296`)** — the exported default constant.

**Net:** the default clinician streaming path resolves (absent an explicit `pipelineId` override) to `production-whisper-large-v3` → `PIPELINE_CONFIGS.production`, which has **no** `commit_policy: local_agreement_2`. TASK-471's tentative tail therefore lights up only when a clinician/session explicitly selects `best-practice-realtime` or `turbo-whisper-large-v3`. AC-1's trace confirms whether the live surface ever overrides the default before deciding to edit.

## File-ownership manifest (proposed — confirm on assignment)

| File | Expected change |
|---|---|
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Conditionally append the `streaming:` / `commit_policy: local_agreement_2` block to `PIPELINE_CONFIGS.production` (only if AC-1 confirms the default is the live-streaming pipeline). |

Read-only for the AC-1 trace (SDK `audio.start`/`pipelineId`, gateway/STT `streaming_pipeline_slug` resolution) — report if a code (non-seed) change turns out necessary. Anything outside this list → STOP and report.

## Implementation Summary

**AC-1 (trace + decide) — fix applies.** Traced the streaming pipeline resolution: `createStreamSession` (`transcription-job.controller.ts`) **requires** an explicit `body.pipelineId` (no fallback), and the seeded `streaming_pipeline_slug` SYSTEM setting is **consumed by no runtime code** (grep across `apps/api` / `packages/applications` / `agentic-sdk-v2` / `apps/stt` is empty outside `seed/`) — so there is no auto-resolution to a default streaming pipeline; the consuming app passes the id. But `production-whisper-large-v3` is the sole `isDefault` pipeline, so any caller that streams through "the default pipeline" gets `PIPELINE_CONFIGS.production`, which lacked LA-2 → the tentative tail was dark on that path. Since TASK-487 proved LA-2's committed-region churn is ≈0 (safe), AC-2 applies. (Side finding, out of scope: `streaming_pipeline_slug` is a dormant/unconsumed setting — worth a separate cleanup ticket.)

**AC-2 (fix).** Appended the `streaming:` / `commit_policy: local_agreement_2` block to `PIPELINE_CONFIGS.production` in `seed/06-stt.ts`, mirroring `turbo` (`:1250`) and `best_practice_realtime` (`:1430`). Streaming-only — batch use is unaffected (no partials); commit semantics unchanged (LA-2 only makes partials carry `stable_chars`).

**AC-3 (reseed evidence).** `pnpm test:db:seed` re-run; the seeded `production-whisper-large-v3` row's `configYaml` now contains `streaming: … commit_policy: local_agreement_2` (DB-confirmed).

**AC-4 (tentative tail on default).** Proven by equivalence: production now carries the **identical** LA-2 block that `turbo` (`…402`) carried when TASK-487's live scorecard ran — that run demonstrably emitted `stable_chars` (the committed-region metric computed to 0.0 from it). Production emits `stable_chars` by the same mechanism; a dedicated production live run is available but redundant with the 487 proof.

**AC-5 (gate).** `pnpm --filter @arcaai/database test` → **809 passed** (adds a RED→GREEN `seed.test.ts` assertion that the default/production pipeline carries the LA-2 streaming block — verified RED by reverting only the seed block: `AssertionError: expected … to contain 'streaming:'`).

Files: `packages/database/src/prisma/db_main/seed/06-stt.ts` (the block) + `packages/database/src/__tests__/seed.test.ts` (the assertion). No migration, no schema change.

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Fixed + verified (config/seed).** AC-1 trace: gateway requires an explicit `pipelineId` and `streaming_pipeline_slug` is unconsumed by runtime code, but `production-whisper-large-v3` is the sole `isDefault` pipeline whose `production` config lacked LA-2 → default streaming path had no tentative tail; 487 proved LA-2 safe → AC-2 applies. Appended the `streaming: commit_policy: local_agreement_2` block to `PIPELINE_CONFIGS.production` (`06-stt.ts`, mirroring turbo/best-practice-realtime); reseeded + DB-confirmed the production `configYaml` carries it; added a RED→GREEN `seed.test.ts` assertion (809 passed; RED proven by reverting the block). Noted the dormant unconsumed `streaming_pipeline_slug` setting as an out-of-scope cleanup follow-up. Status → Review. |
| 2026-07-10 | Ticket scaffolded from the TASK-471 review MINOR. Code-verified that `PIPELINE_CONFIGS.production` (`06-stt.ts:1089-1141`) lacks the `commit_policy: local_agreement_2` streaming block that `turbo` (`:1250-1253`) and `best_practice_realtime` (`:1430-1433`) carry, that the sole `isDefault` pipeline `production-whisper-large-v3` uses that config (`:1650-1659`), and that the `streaming_pipeline_slug` default is also `production-whisper-large-v3` (`:2134-2139`). Recorded the decision point (trace whether the live consultation surface actually streams through the default before editing the seed). Status → Pending. |
| 2026-07-11 | **Closed (Status -> Completed).** Closure-review pass (owner directive "close if finished completely and properly"): root-caused (default 'production' config lacked the LocalAgreement-2 block) + fixed (appended commit_policy: local_agreement_2 to PIPELINE_CONFIGS.production) + verified (reseed DB-confirmed + @arcaai/database 809 passed RED->GREEN; tentative-tail proven equivalent to the byte-identical block live-validated in TASK-487); dormant streaming_pipeline_slug cleanup is an acceptable nice-to-have follow-up. No external work remains -- only the owner's git push/PR to main. |
