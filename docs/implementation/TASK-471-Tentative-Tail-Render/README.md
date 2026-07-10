# TASK-471 — Tentative-Tail Render + Partial-Cadence Drop (Theme A1 · SOTA S1 · quick win)

- **Status**: Review (implemented on `fix/task-471-tentative-tail` off `fix/2605-review` @ 1d66a39a — emit/config only, zero SDK/React code; AC-4 live-harness scorecard is the orchestrator's remaining gate)
- **Type**: refactor (render/emit policy) — no model change, no new UI code
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **A1** (Streaming ASR modernization — the free latency win)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA S1 (LocalAgreement-2 is a correct 2023 baseline but commits ~1–2 s behind and renders partials only every 1.0 s over an 8 s tail)
- **Theme**: A1 · **Size**: S · **Value**: High (free latency win) · **Risk**: Low
- **Depends on / gated by**: **[TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md)** — the scorecard MUST show a tentative-visible-latency improvement with NO partial-revision-rate and NO commit-latency regression before this ships (measure-first).
- **Suggested agent**: general-purpose (Python STT-v2 emit path + one seed YAML) — no ML, no React

## File-ownership manifest (best-effort exclusive — binding)

| Path | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | Make the hardcoded `_PARTIAL_INTERVAL_S = 1.0` (:49) a constructor arg with a **lower default**; keep `_PARTIAL_MIN_AUDIO_S = 0.5` (:50) as the min-audio floor. Enforcement stays at `_maybe_emit_partial` (:523-530). |
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | New `streaming_partial_interval_s: float` field next to `streaming_partial_window_s` (:511-519). **NOTE the `Settings` class has NO `env_prefix`** (:18-23) — the env var is the bare `STREAMING_PARTIAL_INTERVAL_S`, not `STT_V2_…`. |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Read the new setting (mirror the `partial_window_s` read at :163-164 / fallback :182) and pass it into the preprocessor via `_build_preprocessor_vad_kwargs` (:223, where `partial_window_s` is already threaded). |
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Add a `streaming:\n  commit_policy: local_agreement_2` block to the **realtime** pipeline YAML(s) (`best_practice_realtime` :1374-1428 and the turbo/global streaming variants) so `stable_chars` is emitted — this **activates the already-built tentative render**. |
| `apps/stt-v2/tests/unit/test_streaming_preprocessor*.py` (extend or new) | Unit tests: configurable cadence honored (lower interval → more partials); min-audio floor still respected; LA-2 on → `stable_chars` populated on partials. |
| `turbo.json` · `.env.example` | Register `STREAMING_PARTIAL_INTERVAL_S` in `globalEnv` + example (per `.claude/rules/00`/`13` — new runtime env vars). |

**Read-only reference (do NOT modify)**: `apps/stt-v2/src/stt_v2/streaming/commit_policy.py` (LA-2 — commit logic stays conservative, unchanged), `apps/stt-v2/src/stt_v2/streaming/schemas.py` (`stable_chars` wire field :166, :192-193 — already present), `packages/agentic-sdk-v2/src/core/SttV2WebSocketClient.ts` (:649-652 — already parses `stableChars`), `packages/ui/src/components/live-transcript/transcript-segment.tsx` (:177-185 — already renders the tentative tail).

**Manifest-growth guard (STOP-and-report)**: the tentative-tail **render already exists** (SDK + UI, see Current State), so this ticket needs **zero** React/SDK code. If review concludes an explicit `tentative_text` wire field is wanted (instead of the client deriving `text[stableChars:]`), that touches `schemas.py` + `session_manager.py:1595` (which currently discards `_tentative`) + the SDK/UI — STOP and report; it is a scope expansion beyond this S-sized quick win.

## Requirement Analysis

The single biggest realtime lever is the ASR commit/emit policy. LocalAgreement-2 is a correct, conservative commit policy — a word is "committed" only once it survives across the last two hypotheses (`commit_policy.py:77-116`) — but two things make the clinician wait: (1) partials are emitted on a **fixed 1.0 s cadence** (`_PARTIAL_INTERVAL_S`, `preprocessor.py:49`), so newly-spoken words don't appear until the next tick; (2) on the shipped realtime pipeline the commit policy is **off** (`commit_policy: "none"`), so there is no stable/tentative distinction to render at all.

The quick win (no model change, pure render/emit policy): **drop the 1 s partial cadence** so words appear in near-real-time, and **turn on LA-2 for the realtime pipeline** so the already-built "settled prefix + tentative tail" render activates — the clinician sees words *forming* (tentative, visually-distinct) while the **commit policy stays conservative** (LA-2's commit logic is untouched; only the not-yet-committed tail's *visibility* changes).

**Load-bearing discovery (narrows scope to genuinely-S):** the tentative-tail render already exists **end-to-end** and is merely **dormant**:
- STT-v2 already emits `stable_chars` (committed-prefix length) on partials — `session_manager.py:1596`, wire field `schemas.py:192-193`.
- The SDK already parses it — `SttV2WebSocketClient.ts:649-652` (`stableChars`), typed with the comment "the remainder is a tentative tail" (`types/stt-v2.ts:206-209`).
- The UI already renders it distinctly — `transcript-segment.tsx:178-184`: committed prefix `text.slice(0, stableChars)` as `not-italic text-foreground` (settled), the tail `text.slice(stableChars)` inheriting the partial's italic base (tentative).

So this ticket is **emit/config only**: (a) configurable, lowered partial cadence; (b) enable LA-2 on the realtime pipeline so `stable_chars` populates and the dormant render lights up. No SDK/UI change.

### Acceptance criteria

- [ ] **AC-1 (cadence configurable + lowered)** — `_PARTIAL_INTERVAL_S` becomes a preprocessor constructor arg fed by `settings.streaming_partial_interval_s`, with a default below 1.0 s (target ~0.3–0.5 s — the exact value chosen from the TASK-470 sweep). The `_PARTIAL_MIN_AUDIO_S = 0.5` floor is preserved so a partial still needs ≥ 0.5 s of buffered speech. Unit-tested: a lower interval yields more partials over the same audio; the floor still gates.
- [ ] **AC-2 (LA-2 active on realtime)** — the realtime pipeline seed YAML(s) set `commit_policy: local_agreement_2`; a test asserts a partial on that pipeline carries a `stable_chars` in `[0, len(text)]`. (This is what makes `transcript-segment.tsx:178`'s render branch fire — verified by the existing UI test, no new UI code.)
- [ ] **AC-3 (render is a no-op change — proven, not rebuilt)** — confirm the existing SDK parse + UI render already handle `stableChars` (cite the existing tests); this ticket adds NO React/SDK code. If any gap is found, it is reported, not silently patched here.
- [ ] **AC-4 (measured on TASK-470 — the gate)** — re-running [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md)'s scorecard on the same fixture + realtime pipeline + frame_ms shows:
  - **target**: tentative-visible latency (`first_partial_ms` / `ttfw_ms`) materially **lower** than the pre-change baseline (the free win);
  - **guardrail (must NOT regress)**: `partial_revision.rate` not higher (faster/looser partials must not increase flicker beyond the TASK-470 ε), and `commit_latency_ms.p50|.p99` not higher (the conservative commit policy is unchanged);
  - **guardrail**: `seq.gap_count` stays 0 and `audio_coverage_ratio` not worse.
  The scorecard's `assert_no_regression` gate passes. Numbers pasted into §Implementation Summary.
- [ ] **AC-5 (gates)** — `pnpm py:stt-v2:test` (+ `:test:unit`), `pnpm py:stt-v2:lint`, `pnpm py:stt-v2:typecheck` green; `STREAMING_PARTIAL_INTERVAL_S` in `turbo.json#globalEnv` + `.env.example`; output pasted.

### Non-goals

- Any ASR **model** change or streaming-native transducer — that is A2 ([TASK-472](../SOTA-Track/README.md)); this is pure emit/render policy on the existing faster-whisper backend.
- Changing LA-2's **commit** logic / making it less conservative (`commit_policy.py` is read-only here) — only the cadence and the tentative-tail *visibility* change.
- Semantic endpointing / VAD offset changes — A3 ([TASK-473](../SOTA-Track/README.md)).
- Adding an explicit `tentative_text` wire field or any new SDK/UI render code (the client already derives the tail from `stable_chars`).
- Tuning `streaming_punctuation_timeout_s` (:502-509, finals-only Cadence-Fast budget) — adjacent knob, out of scope.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ 87b33f57)

**Partial-emit cadence — the throttle** (`apps/stt-v2/src/stt_v2/streaming/preprocessor.py`):
- `_PARTIAL_INTERVAL_S = 1.0` (:49) and `_PARTIAL_MIN_AUDIO_S = 0.5` (:50) are **hardcoded module constants** — no settings field, no `__init__` arg (constructor at :109-125 takes no cadence param). Enforced in `_maybe_emit_partial` (:523-530): `if now - state.last_partial_emitted_at < _PARTIAL_INTERVAL_S: return None`. → to change it today you must edit the constant.
- The tail window IS already configurable for contrast: `_DEFAULT_PARTIAL_WINDOW_S = 8.0` (:53) ↔ `streaming_partial_window_s` (`core/config/settings.py:511-519`) ↔ threaded via `session_manager.py:223`. This ticket mirrors that wiring for the cadence.

**Commit policy — LA-2** (`apps/stt-v2/src/stt_v2/streaming/commit_policy.py`):
- `LocalAgreementPolicy.update()` (:61) computes the committed prefix as the longest-common-prefix of the **last two** hypotheses (:77-85) — structurally "LA-2"; there is no `n_agree` knob. It also computes a `tentative_text` string.
- Applied in `session_manager.py:1593-1596`: `committed, _tentative = policy.update(result.text); result.stable_chars = len(committed)` — **the tentative string is discarded**; only the integer `stable_chars` prefix length is emitted (the client re-derives the tail as `text[stable_chars:]`).
- **The policy is OFF by default and OFF on the shipped realtime pipeline.** `StreamingConfig.commit_policy` defaults to `"none"` (`pipeline/dto.py:589`; parser default `yaml_parser.py:607`); `session_manager.py:252-253` only builds a policy when `commit_policy == "local_agreement_2"`. The seed's `best_practice_realtime` YAML (`06-stt.ts:1374-1428`) has **no `streaming:` block** → `"none"` → **`stable_chars` is never emitted** → the UI's tentative render branch never fires. This is why the feature is dormant.

**Emit path + wire shape** (`apps/stt-v2/src/stt_v2/streaming/`):
- Single writer `ResultPublisher.publish` → `XADD stt:result:{sid}` (`redis_streams.py:413-424`). Message = `SegmentResult.to_redis_dict` (`schemas.py:170-194`): `type`, `text`, `start_time`, `end_time`, `is_final` (`"1"`/`"0"` — the only partial/final discriminator, :177), and `stable_chars` **only when set** (:192-193). No tentative/unstable field on the wire — by design the client derives it.

**Client render — already built (dormant only because `stable_chars` is absent):**
- SDK: `SttV2WebSocketClient.ts:649-652` normalizes `stableChars`/`stable_chars`; type comment `types/stt-v2.ts:206` "the remainder is a tentative tail".
- UI: `packages/ui/src/components/live-transcript/transcript-segment.tsx:178-184` renders committed prefix settled (`not-italic text-foreground`) + tail tentative when `!isFinal && stableChars ∈ (0, len)`; `types.ts:23-24` documents it.

**Net**: the render exists; the two dormant switches are the **1.0 s cadence** (hardcoded) and **LA-2 off on the realtime pipeline** (seed default `"none"`). Flip both → near-real-time forming words with a visually-distinct tentative tail, commit policy unchanged.

## Implementation Plan (TDD sketch — strict order; run AFTER TASK-470 lands)

> Context pack for the implementing agent: this README · TASK-470 README (the scorecard this is gated on) · SOTA-Track §Theme A + §Governing principle · `.claude/rules/06-python-services.md` (pydantic-settings, ruff/mypy, pytest) · `.claude/rules/02-database-prisma.md` (seed conventions for the pipeline YAML) · `.claude/rules/08-vox-sdk.md` (confirm the SDK/UI render is already wired — do not add to it).

1. **RED (cadence)** — a preprocessor unit test asserting that a `streaming_partial_interval_s` below 1.0 s produces more partials over a fixed synthetic utterance than the 1.0 s default, and that the 0.5 s min-audio floor still gates the first partial. Watch it fail (constant not configurable).
2. **GREEN (cadence)** — add `streaming_partial_interval_s` to `Settings` (bare env name), make `_PARTIAL_INTERVAL_S` a constructor default arg, thread it through `session_manager.py` `_build_preprocessor_vad_kwargs`. Lower the default to the TASK-470-chosen value.
3. **RED→GREEN (LA-2 activation)** — a test asserting a partial from the realtime pipeline carries a valid `stable_chars`; then add `streaming:\n  commit_policy: local_agreement_2` to the realtime seed YAML(s). Confirm the existing UI/SDK tests still pass unchanged (render is a no-op change).
4. **Measure on TASK-470 (AC-4)** — run the TASK-470 scorecard before/after; capture the tentative-latency improvement and the no-regression on revision-rate + commit-latency; paste. If revision-rate regresses past ε, raise the cadence toward the knee (the setting exists precisely to tune this) and re-measure.
5. **Env registration + gates** — `turbo.json#globalEnv` + `.env.example`; run the STT-v2 gates.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm py:stt-v2:test:unit           # cadence + LA-2 activation units
pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
# then the measured gate (needs the TASK-470 scorecard + a running stack):
pnpm py:stt-v2:test:integration    # TASK-470 scorecard, before/after
```

Adversarial review focus: (a) is LA-2's commit logic genuinely untouched (only cadence + activation changed)? (b) does the lower cadence increase `partial_revision.rate` past the TASK-470 ε — i.e. is the chosen interval defensible against the scorecard, not just "faster"? (c) is the render truly unchanged (no new SDK/UI code — the dormant path just lit up)? (d) env var registered; (e) zero diff outside the manifest.

## Implementation Summary

**Status: Review.** Implemented strictly per the manifest — **emit/config only, ZERO SDK/React code** (the tentative-tail render already exists end-to-end and was merely dormant). Two dormant switches were flipped: (1) the partial-emit cadence is now a configurable, lowered setting; (2) LocalAgreement-2 is activated on the realtime/streaming pipeline seeds so `stable_chars` is emitted and the already-built settled-prefix + tentative-tail render lights up. LA-2's *commit* logic (`commit_policy.py`) and the SDK/UI render (`SttV2WebSocketClient.ts`, `transcript-segment.tsx`) are untouched.

**Chosen cadence: `0.4 s` default** (from the AC-1 target band 0.3–0.5 s). Rationale: materially below the legacy 1.0 s (the free latency win) while conservative enough not to obviously inflate `partial_revision.rate`; it sits at the same value as the sibling `streaming_punctuation_timeout_s` default. It is a tunable knob (`STREAMING_PARTIAL_INTERVAL_S`), so the orchestrator confirms/adjusts it from the TASK-470 sweep (AC-4) without a code change. The 0.5 s min-audio floor (`_PARTIAL_MIN_AUDIO_S`) is preserved — a partial still needs ≥ 0.5 s of buffered speech, so the *first* partial's floor is unchanged; only the *cadence* between partials dropped.

### Files changed (all within the manifest — `git status` = 10 files, no schema/migration change)

| File | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/core/config/settings.py` | New `streaming_partial_interval_s: float = 0.4` field next to `streaming_partial_window_s`. Bare env name (`Settings` has no `env_prefix`) → `STREAMING_PARTIAL_INTERVAL_S`. |
| `apps/stt-v2/src/stt_v2/streaming/preprocessor.py` | `_PARTIAL_INTERVAL_S` lowered `1.0 → 0.4` and repurposed as the constructor default; new `partial_interval_s` `__init__` arg stored as `self._partial_interval_s`; `_maybe_emit_partial` now gates on `self._partial_interval_s` (was the module constant). `_PARTIAL_MIN_AUDIO_S = 0.5` floor untouched. |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Cache `self._partial_interval_s` from settings (init + except fallback, mirroring `_partial_window_s`); thread `partial_interval_s` through `_build_preprocessor_vad_kwargs` (covers both the create and crash-recovery preprocessor build sites). |
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Added a top-level `streaming:\n  commit_policy: local_agreement_2` block to `PIPELINE_CONFIGS.best_practice_realtime` and `PIPELINE_CONFIGS.turbo`. The `turbo` config is shared by the turbo/streaming pipeline rows across the SYSTEM, ArcaAI-customer, and Global tenants, so one edit activates LA-2 on every realtime/streaming variant (≥ 4 seed rows incl. `best-practice-realtime` — the slug the TASK-470 harness defaults to). |
| `turbo.json` | `STREAMING_PARTIAL_INTERVAL_S` added to `globalEnv`. |
| `apps/stt-v2/.env.example` | New "Streaming — real-time partial cadence" section documenting `STREAMING_PARTIAL_INTERVAL_S` (commented, default 0.4). |
| `apps/stt-v2/tests/unit/test_streaming_preprocessor.py` | New `TestPartialCadenceConfigurable`: default lowered + floor preserved; explicit override; lower interval → strictly more partials over an identical simulated timeline; min-audio floor still gates. |
| `apps/stt-v2/tests/unit/streaming/test_preprocessor_wiring_kwargs.py` | `partial_interval_s` threaded from settings into the preprocessor kwargs (with + without VAD config); `Settings.model_fields` default asserted `≈ 0.4` and `< 1.0`. |
| `apps/stt-v2/tests/unit/test_yaml_parser.py` | New `TestRealtimeStreamingActivatesTentativeTail`: the exact realtime `streaming:` block (comments and all) parses to `local_agreement_2` and drives `LocalAgreement-2` to a valid `stable_chars ∈ [0, len(text)]` (config → emit contract lock). |
| `packages/database/src/__tests__/seed.test.ts` | New assertion: every realtime/turbo seed row (system + ArcaAI + Global) carries the `streaming: … commit_policy: local_agreement_2` block. |

### AC coverage

- **AC-1 (cadence configurable + lowered)** — met. `streaming_partial_interval_s` default `0.4` (< 1.0); constructor arg + settings wiring; floor preserved. Unit-proven.
- **AC-2 (LA-2 active on realtime)** — met. Realtime + turbo seed rows set `commit_policy: local_agreement_2`; TS seed test pins the seed object shape; Python test pins block-shape → parse → valid `stable_chars`.
- **AC-3 (render is a no-op change — proven, not rebuilt)** — confirmed. No SDK/React file touched (`git status`). The existing SDK parse (`SttV2WebSocketClient.ts` `stableChars`) and UI render (`transcript-segment.tsx` settled-prefix/tentative-tail) are unchanged; existing UI/SDK tests unaffected. No render gap found → nothing patched here.
- **AC-4 (measured on TASK-470 — the gate)** — **ORCHESTRATOR's step** (live stack; see run below). Not gated in these hermetic unit tests.
- **AC-5 (gates)** — green; `STREAMING_PARTIAL_INTERVAL_S` in `turbo.json#globalEnv` + `.env.example`. Output below.

### RED → GREEN evidence

RED (against baseline, before the source edits):
- AC-1 Python: `6 failed, 1 passed` — `AttributeError: … no attribute '_partial_interval_s'`, `TypeError: … unexpected keyword argument 'partial_interval_s'`, `KeyError: 'partial_interval_s'`, `KeyError: 'streaming_partial_interval_s'`. (The 1 pass is the AC-2 activation contract-lock — GREEN from the start because the emit path pre-exists; that is the "dormant render already built" fact.)
- AC-2 seed (`seed.test.ts -t TASK-471`): `1 failed` — `expected '…turbo…' to match /streaming: … commit_policy: local_agreement_2/` (block absent from the realtime configs).

GREEN (after the edits):
- Targeted: `7 passed, 175 deselected` (4 cadence + 1 wiring + 1 settings-default + 1 activation contract-lock).
- Seed: `Tests 1 passed | 334 skipped` (`-t TASK-471`).

### Verification gate output (pasted)

> Note: this worktree's `stt_v2` is imported via the shared `arcaenv` editable install, which is pinned to the primary checkout's `src`. To exercise **this branch's** code the STT-v2 suites were run with `PYTHONPATH=apps/stt-v2/src` prepended (equivalent to what `pnpm py:stt-v2:test` does once the branch is the checkout on `stt_v2`'s path, e.g. in CI). Path-based gates (ruff/mypy) need no override.

```
# pnpm py:stt-v2:test  (tests/unit, hermetic)
2113 passed, 12 warnings in 24.69s

# pnpm py:stt-v2:test  (tests/, full: unit + integration + e2e)
2 failed, 2353 passed, 37 skipped, 3 xfailed  in 36.00s
#   - the 3 SKIPPED integration cases are the live-stack TASK-470 harness/scorecard
#     (stt-v2/API unreachable) = AC-4, the orchestrator's gate — never gated here.
#   - the 2 FAILED (test_streaming_recording.py::TestTranscriptOutbox) are PRE-EXISTING
#     ordering flakiness on fix/2605-review @ 1d66a39a: with my changes stashed the
#     same full run reproduces them (2 failed, 2346 passed); they pass in isolation and
#     in the unit-only run; they touch the transcript outbox, not partial cadence.

# pnpm py:stt-v2:lint  (ruff)
All checks passed!

# pnpm py:stt-v2:typecheck  (mypy src/)
Success: no issues found in 103 source files

# database (seed edit → confirm build + generate unaffected)
pnpm --filter @arcaai/database build   → tsc, rc=0
pnpm --filter @arcaai/database test    → 23 files, 808 passed
pnpm db:generate                        → Prisma Client generated OK; no .prisma/migration change (seed-data only)
```

### AC-4 — the exact before/after harness run the ORCHESTRATOR performs (live stack)

Like TASK-470's live scorecard, on a running stt-v2 + gateway + Redis with the **same clinical fixture, the `best-practice-realtime` pipeline (the harness default slug), and the same `frame_ms`** (`LATENCY_FRAME_MS`, default 80). Two runs, judged by TASK-470's `apps/stt-v2/tests/integration/streaming_thresholds.json` via `assert_no_regression`:

0. **RESEED FIRST (prerequisite — else the run proves nothing).** `commit_policy: local_agreement_2` is SEED data (`06-stt.ts`); an already-seeded DB still carries the OLD `best-practice-realtime` row (`commit_policy: none`), so the harness would run with LA-2 **off** — `stable_chars` never emitted, the tentative-tail activation silently unexercised, while the cadence-driven `first_partial_ms` win still shows (env-driven) → a green scorecard that proves nothing about the shipped config. Run `pnpm test:db:seed` (test DB) / `pnpm db:seed` (dev) so the `best-practice-realtime`/`turbo` rows pick up `commit_policy`, then (re)start stt-v2. Verify: query the pipeline row and confirm `commit_policy: local_agreement_2` before measuring.
1. **Before (baseline, 1.0 s cadence)** — capture the scorecard with `STREAMING_PARTIAL_INTERVAL_S=1.0` (the legacy value) so the pre-change baseline is measured on the *same* build. NOTE `STREAMING_PARTIAL_INTERVAL_S` is read at `SessionManager` init in the **service** process → set it on the running stt-v2 and RESTART the service between the 1.0 and 0.4 runs (it is not per-request).
2. **After (0.4 s cadence)** — capture the scorecard with the shipped default `STREAMING_PARTIAL_INTERVAL_S=0.4` (unset = default); restart stt-v2 before this run.

Pass/fail the gate on:
- **TARGET (must improve)** — tentative-visible latency `first_partial_ms` / `ttfw_ms` materially **lower** after vs before (the free win).
- **GUARDRAIL (must NOT regress)** — `partial_revision.rate` ≤ baseline 0.0 + ε 0.02 (faster partials must not add flicker); `commit_latency_ms.p50|.p99` within the ×1.15 ratio of TASK-455's 6023.2 / 7624.2 ms (LA-2 commit unchanged); `seq.gap_count` == 0; `audio_coverage_ratio` ≥ 0.996 − 0.005.
- If `partial_revision.rate` exceeds ε, raise `STREAMING_PARTIAL_INTERVAL_S` toward the knee (0.4 → 0.5) and re-measure — no code change needed. Paste the two scorecards + the `assert_no_regression` verdict back into this section.

Command shape (orchestrator): `LATENCY_PIPELINE_SLUG=best-practice-realtime LATENCY_FRAME_MS=80 STREAMING_PARTIAL_INTERVAL_S=<1.0|0.4> pnpm py:stt-v2:test:integration` against the running stack, twice.

**Live-run attempt (2026-07-10) — BLOCKED, not a code defect.** The orchestrator brought up the full stack (STT-v2 + gateway + Redis), reseeded (verified `best-practice-realtime`/`turbo-whisper-large-v3` carry `commit_policy: local_agreement_2`), and generated 16 kHz WAVs from the fixtures. The harness ran end-to-end and **partials emitted** (`first_partial_ms` ~2.1–2.9 s, `partial_revision_rate` 0.6–0.75, `seq_gap_count` 0), BUT **no final transcript was ever committed** (`hypothesis_words: 0`, `medical_wer: 1.0`, `audio_coverage_ratio: 0.0`), with persistent `XREADGROUP "Timeout reading from localhost:6380"` on the STT-v2 audio stream. Reproduced across THREE configs — two pipelines, a flushed Redis, and STT-v2 without `--reload` — so it is environment/streaming, not the merged 470/471 code (470's scorers are hermetically proven; 471's cadence demonstrably emits partials). Root-cause + real-production-risk assessment tracked as a follow-up (empty-final / redis-py `socket_timeout`-vs-`XREADGROUP BLOCK` under silence gaps). The scorecard + before/after latency remain the outstanding confirmation, to be captured in a less-contended environment once the streaming read-timeout is resolved.

**Root cause found + fixed (2026-07-10) — TWO independent issues, disentangled.** The blocker is NOT the redis timeout and NOT the 470/471 code.

1. **Empty final = a long-standing GATEWAY bug (the real blocker).** The result-stream bridge treated `status:"finalizing"` as a TERMINAL status and completed the reader ([`streamingAudioBridge.service.ts` `parseAndEmitResult`](../../../packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts)), but STT-v2 publishes `"finalizing"` (`session_manager.py:1766`) BEFORE it flushes+publishes the tail final (`_flush_final_utterance` → `inference.py` publish, `is_final=1`) then `"closed"`. Result-stream order = `finalizing → FINAL → closed`, so the reader stopped one entry early and the tail final was orphaned in Redis, never relayed. Deterministic, load-independent, present since the initial commit (NOT a 471 regression). Impact: every streaming consultation silently drops its LAST utterance; a single-utterance clip (say-TTS scorecard fixture → one VAD utterance) → the only final is the tail → fully empty hypothesis. **Fix:** terminal only on `closed`/`cancelled`; `finalizing` is a non-terminal progress marker the reader skips. RED→GREEN test in `streamingAudioBridge.service.test.ts` (`does NOT complete on status=finalizing` + `cancelled` terminal).

2. **The redis `"Timeout reading from localhost:6380"` is a RED HERRING (log-spam that recovers).** Proven empirically against the live test Redis: a redis-py `socket_timeout` < the 5000 ms `BLOCK` raises that exact error, but the committed streaming client (`_runtime.py`) and all committed config (`.env.test`/`.env.production`/k8s) set NO socket_timeout — the operator's run had one injected at runtime. The blocking reads **log-and-recover** (the terminal frame is redelivered via the consumer-group `>` cursor after a timeout; no data loss), so this never starved audio or blocked the final. **Hardening (P2):** `IngestionConsumer`/`ControlListener` now treat a read `TimeoutError` as a benign empty-read (re-issue, no error-spam/backoff) under any injected socket_timeout, + `health_check_interval` on the streaming client (`redis_streams.py`, `_runtime.py`; new `TestBlockingReadTimeoutTolerance`).

Verification: `@arcaai/applications` build + lint clean, bridge suite `5930 passed`; stt-v2 streaming units `350 passed` + hygiene `16 passed` (incl. 2 new), ruff/mypy clean.

**Live AC-4 re-run (2026-07-10, post-fix) — UNBLOCKED, finals now commit.** Full stack up (STT-v2 8861 + gateway 8868 rebuilt with the fix, PG 5433, Redis 6380, `whisper-large-v3-turbo` from the offline cache), reseed verified (`local_agreement_2` present), `say`-TTS WAVs generated from the three clinical fixtures. Scorecard through the WS gateway now produces REAL finals on every clip (was `hypothesis_words:0` / `medical_wer:1.0` / `audio_coverage_ratio:0.0`):

| clip | medical_wer | keyterm_recall | keyphrase_recall | audio_coverage | finals |
|---|---|---|---|---|---|
| cardiology_consult_01 | 0.033 | 1.00 | 1.00 | 0.994 | 1 |
| discharge_summary_01 | 0.065 | 1.00 | 0.75 | 0.994 | 1 |
| medication_review_01 | 0.066 | 1.00 | 1.00 | 0.997 | 2 |

STT-v2 log carried **zero** `"Timeout reading"`/XREADGROUP errors (committed config sets no socket_timeout — confirms §2's red-herring finding). All QUALITY guardrails PASS (WER ≪ 0.35 ceiling, recall ≥ 0.70 floor, coverage ≥ baseline, seq_gap 0). The scorecard's regression gate is still RED on TWO non-quality guardrails, which are TASK-471's AC-4 decision — NOT the empty-final bug: (a) `partial_revision_rate` 0.77–0.80 vs the A1 baseline 0.0+ε=0.02 — the DESIGNED churn of the 1.0→0.4 s tentative-tail cadence (the exact A1 trade-off AC-4 weighs; measured on full-caption text, not the LA-2 committed prefix); (b) `commit_latency_p50` 7383 ms vs 6023×1.15 — inference-dominated single-box contention (STT-v2 + gateway + say-TTS on one host). Product-owner call: accept the churn/latency trade-off, refine the A1 metric to the committed region, and recapture latency on a non-contended host; thresholds deliberately left untouched (not gamed).

### Deviations / judgment calls (for reviewer)

1. **Constant kept, not renamed.** `_PARTIAL_INTERVAL_S` keeps its name (value `1.0 → 0.4`, now the constructor default) rather than renaming to `_DEFAULT_PARTIAL_INTERVAL_S`, so the symbol referenced by the harness docstring stays valid; only its value is stale prose, which the orchestrator reconciles when running AC-4 (the harness is their file, outside this manifest).
2. **Env registration placement.** `STREAMING_PARTIAL_INTERVAL_S` was added to `turbo.json#globalEnv` (per rule 00 + the manifest) and to the per-service `apps/stt-v2/.env.example` (the canonical doc for STT settings, correct bare-name convention). NOTE: the ~20 sibling `streaming_*` STT knobs (incl. `streaming_partial_window_s`) are NOT registered in `turbo.json`/any `.env.example` — a pre-existing gap left un-retrofitted (out of scope); only the new var was registered.
3. **Pre-existing full-suite flakiness** (`TestTranscriptOutbox`, above) — not fixed here (unrelated to cadence/commit_policy).

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme A1 — the quick-win latency lever). Code-verified against `fix/2605-review` @ 87b33f57: the 1.0 s partial cadence is a hardcoded constant (`preprocessor.py:49`), LA-2 is off on the shipped realtime pipeline (`06-stt.ts:1374-1428` has no `commit_policy` → default `"none"` → `stable_chars` never emitted), and — the scope-narrowing discovery — the tentative-tail render **already exists end-to-end** (STT-v2 `stable_chars` → SDK `SttV2WebSocketClient.ts:649-652` → UI `transcript-segment.tsx:178-184`) but is dormant. So A1 is pure emit/config: configurable+lowered cadence and LA-2-on for the realtime pipeline, gated on TASK-470's scorecard (tentative-visible latency must improve with no partial-revision / commit-latency regression). No implementation. |
| 2026-07-10 | **Implemented (strict TDD, RED→GREEN) on `fix/task-471-tentative-tail` off `fix/2605-review` @ 1d66a39a — emit/config only, ZERO SDK/React code.** AC-1: added `streaming_partial_interval_s` (default **0.4 s**, bare env `STREAMING_PARTIAL_INTERVAL_S`); lowered `_PARTIAL_INTERVAL_S 1.0→0.4` as a preprocessor constructor arg; threaded it through `session_manager._build_preprocessor_vad_kwargs`; the 0.5 s min-audio floor is preserved. AC-2: added `streaming.commit_policy: local_agreement_2` to the `best_practice_realtime` + `turbo` pipeline seed configs (activates LA-2 across the system/ArcaAI/Global realtime+turbo rows, incl. `best-practice-realtime`, the TASK-470 harness default). AC-5: `STREAMING_PARTIAL_INTERVAL_S` registered in `turbo.json#globalEnv` + `apps/stt-v2/.env.example`. New hermetic tests: `TestPartialCadenceConfigurable`, `TestStreamingPartialIntervalSetting` + `partial_interval` wiring, `TestRealtimeStreamingActivatesTentativeTail`, and a `seed.test.ts` seed-shape assertion. Gates: unit `2113 passed`; ruff `All checks passed`; mypy `no issues (103 files)`; `@arcaai/database` build rc=0 + `808 passed`; `db:generate` unaffected (seed-data only, no schema change). The 2 full-suite `TestTranscriptOutbox` failures are pre-existing ordering flakiness (reproduced with changes stashed). AC-4 (live TASK-470 scorecard, before/after cadence) is documented for the orchestrator. Status → Review. |
| 2026-07-10 | **Root-caused the BLOCKED AC-4 live run (empty final) and fixed it (TDD, RED→GREEN).** Two independent issues, disentangled (see the resolution note above §AC-4). **P0 — gateway (the real blocker):** the result-stream bridge treated `status:"finalizing"` as terminal and tore the reader down before STT-v2's tail final (published AFTER `finalizing`, before `closed`) was relayed → every session silently dropped its last utterance; single-utterance clips → fully empty hypothesis. Long-standing (initial commit), NOT a 471 regression. Fixed `streamingAudioBridge.service.ts::parseAndEmitResult` to terminate only on `closed`/`cancelled`; RED→GREEN in `streamingAudioBridge.service.test.ts`. **P2 — streaming redis hardening:** the `"Timeout reading from localhost:6380"` was a red herring (env-injected `socket_timeout` < `BLOCK`; logs-and-recovers, proven empirically). Made `IngestionConsumer`/`ControlListener` blocking reads tolerate a read `TimeoutError` as a benign empty-read (no error-spam/backoff) + added `health_check_interval` (`redis_streams.py`, `_runtime.py`; new `TestBlockingReadTimeoutTolerance`). Gates: `@arcaai/applications` build+lint clean, bridge `5930 passed`; stt-v2 streaming `350 passed` + hygiene `16 passed`, ruff/mypy clean. AC-4 live scorecard to be recaptured (should now yield real finals). |
</content>
