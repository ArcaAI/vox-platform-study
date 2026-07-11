# TASK-475 — Streaming 2-Speaker Diarization (Theme B2 · SOTA S1-DIAR · **Streaming Sortformer**)

- **Status**: Review (scaffold delivered 2026-07-11 — `DiarizationConfig.backend` switch + Sortformer backend skeleton (fail-closed until staged) + DER/JER/confusion/attribution metric + de-identified 2-speaker fixture + config parse/validate, all hermetic and green: `pnpm py:stt-v2:test` 2392 passed / 37 integration-skipped, ruff clean, mypy clean. The LIVE Sortformer diarizer, the hot-path wiring (`inference.py`/`session_manager.py` incl. recovery), and the AC-5/AC-6 live capture are **BLOCKED on model staging** — see §Implementation Summary → Model-staging ask. User-visible labels are **additionally blocked on TASK-489** (surfacing-contract fix; not implemented here).)
- **Type**: feature (adds a capability HOPE lacks and every comparable ambient scribe has: live clinician/patient speaker labels)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **B2** (diarization)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA S1 — *"Speaker label: frame-level, sub-second (SOTA) vs **none in live loop** (HOPE) → capability absent"* + verdict *"Add streaming 2-speaker diarization (Streaming Sortformer) — every comparable ambient scribe emits clinician/patient labels; HOPE emits none."*
- **Theme**: B2 · **Size**: L · **Value**: High (capability absent today; feeds the live note + NER/summary lineage) · **Risk**: Med–High
- **Depends on**: [**TASK-474**](../TASK-474-Diarization-Internals-Review/README.md) (B1 — its §B2 Build Brief is this ticket's Definition-of-Ready: replace-vs-augment, coexistence, surfacing-contract fixes) **and** [**TASK-470**](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (F — the scorecard this ticket is gated on; extended here with a diarization-accuracy metric). **Hot path → measurement-gated**, exactly like A2/A3.
- **Hard guardrail**: **self-hosted only** — Streaming Sortformer runs on-prem via NeMo; **no cloud diarization/ASR vendor receives clinical audio** (SOTA-track §Hard guardrails).
- **Suggested agent**: a Python/ML engineer (NeMo model-ops + `apps/stt-v2` streaming) + the tester who owns TASK-470's scorecard for the diarization-metric extension.

## Requirement Analysis

TASK-448 judged HOPE **behind (absent)** on streaming diarization: the SOTA target is frame-level, sub-second speaker labels (peer ambient scribes emit clinician/patient turns); HOPE's clinician-facing live transcript emits **none**. TASK-474 (B1) code-verified *why*: a disabled-by-default, finals-only **embedding-clustering** path exists, but is off in the default pipeline, lost on recovery, and its speaker data is dropped by the caption gateway and mismatched against the UI's label field. The capability the clinician actually needs — **live, sub-second clinician/patient attribution on the transcript** — is not delivered.

This ticket adds it with **NVIDIA Streaming Sortformer** (arXiv:2507.18446) — a self-hostable, frame-level, low-latency streaming diarizer (NeMo, open weights) purpose-built for the exact 2-speaker streaming case. It:
1. **Emits clinician/patient labels on the live transcript** — frame-level speaker turns attached to streaming segments (partials *and* finals, per the B1 cadence recommendation), surfaced through the fixed gateway/bridge contract so the clinician sees "Doctor:" / "Patient:" as words form.
2. **Coexists with the existing assets** per the B1 brief — keeps `preseed_speaker` (names the clinician from their enrolled voice profile), keeps the batch path, and adds a `backend` selector to `DiarizationConfig` so Sortformer is the streaming diarizer while embedding-clustering remains available.
3. **Feeds the live note + NER/summary lineage** — speaker turns ride the transcription event so the live-documentation service and the durable `NamedEntity` lineage can attribute utterances (clinician vs patient) downstream — a lineage improvement that pairs with Theme C/E, not a live-note redesign here.
4. **Is measurement-gated** — it touches the hot inference path, so it ships only if TASK-470's scorecard shows the **new diarization-accuracy metric** meets its threshold **and none of the ASR guardrails regress** from adding diarization to the loop.

**Why gated, why after B1**: the single biggest realtime lever is measured, not asserted (SOTA-track §Governing principle). B1 tells this ticket whether to replace or augment the existing identifier, what accuracy metric to gate on, and exactly which surfacing bugs to fix — building Sortformer without it risks fighting the embedding-clustering stack or shipping labels the UI can't render.

### Acceptance criteria (gated on TASK-470 + TASK-474)

- [ ] **AC-1 (self-hosted streaming Sortformer loads)** — the Streaming Sortformer NeMo model loads on-prem through the existing model plumbing (`AiModelFormat.NEMO`, `ModelTaskType.SPEAKER_DIARIZATION` — both already in `pipeline/dto.py`), on GPU with a documented CPU-fallback posture; **no audio leaves the cluster** (guardrail, asserted by an outbound-egress check in review). Model pinned by revision.
- [ ] **AC-2 (live clinician/patient labels)** — with a Sortformer-enabled pipeline, streaming segments carry a 2-speaker turn label reaching the clinician **on the live transcript** (partials + finals per the B1 cadence), rendered as the human-readable label (`speaker_label`) the UI already paints. Proven end-to-end (STT-v2 → gateway/bridge → SDK → playground), not just at the model boundary.
- [ ] **AC-3 (surfacing contract fixed — from B1)** — the TASK-474-identified seam bugs are closed: the caption path forwards speaker data (gateway or the confirmed-live bridge), and `speaker_id` → `speaker_label` mapping/semantics are defined (clinician vs patient), so no diarized segment is silently unlabeled. Regression test locks the contract end-to-end.
- [ ] **AC-4 (recovery keeps state)** — a session resume no longer drops diarization: the recovery path (`session_manager.py:2713`, today `speaker_identifier=None`) reconstructs/continues the streaming diarizer. Test covers reconnect-keeps-labels.
- [ ] **AC-5 (diarization accuracy gate — extends TASK-470)** — TASK-470's scorecard gains a **speaker-attribution metric** (the exact metric — DER / JER / 2-speaker confusion / attribution accuracy — is the B1 recommendation) with a committed threshold in `streaming_thresholds.json`, scored on a de-identified 2-speaker clinical fixture with speaker-turn ground truth. The metric **meets its threshold** on the baseline capture.
- [ ] **AC-6 (ASR guardrails hold — TASK-470 gate contract)** — re-running TASK-470's scorecard on the same fixtures + pipeline shows **no regression** in the guardrail metrics from adding diarization to the hot path: `medical_wer`, `keyterm_recall`, `commit_latency_ms` P50/P99, `partial_revision_rate`, `seq_gap_count`=0, `audio_coverage_ratio` (the B2 row of TASK-470 §Gate contract, extended with the diarization target).
- [ ] **AC-7 (coexistence, no batch regression)** — the embedding-clustering path and `preseed_speaker` still work (clinician naming preserved); the batch diarization path (`batch_service.py`) is unaffected; `DiarizationConfig` grows a `backend` selector (default preserves current behavior). Existing `tests/unit/diarization/*` stay green.
- [ ] **AC-8 (config + rollout)** — a pipeline enables Sortformer streaming diarization via seed/config; the default-pipeline posture is a documented, deliberate choice (given `production-whisper-large-v3` currently omits diarization). New runtime env/config documented in `turbo.json#globalEnv` / `.env.example` if any.
- [ ] **AC-9 (quality gates)** — `pnpm py:stt-v2:test`, `py:stt-v2:lint`, `py:stt-v2:typecheck` green; hot-path change verified against a running stack (not just compiled); TS surfacing changes pass `apps/api` + `packages/*` builds/lints.

### Non-goals

- Replacing the durable HARNESS or making the live speaker labels the system of record — the durable transcript/`NamedEntity` stays authoritative (SOTA-track §Hard guardrails); B2 improves the ephemeral live surface + its lineage.
- >2 speakers / general N-speaker diarization — clinician/patient (2-speaker) is the target; the model supports more but the clinical scope and gate are 2-speaker.
- Redesigning the live-documentation note or the NER pipeline to *consume* turns — B2 makes speaker turns **available** on the transcript event; deep consumption belongs to Theme C (TASK-477) / E (TASK-480).
- Batch-path diarization changes — batch keeps the embedding-clustering path.
- Cloud diarization/ASR — self-hosted only.
- Building the diarization eval metric from scratch as a separate harness — it **extends** TASK-470's scorecard (do not fork it), coordinated with TASK-470's owner (see manifest).

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ 87199e33)

Fully detailed in [TASK-474 §Current State](../TASK-474-Diarization-Internals-Review/README.md#current-state-evaluation-code-verified-2026-07-10-against-fix2605-review--87199e33); the load-bearing facts for B2:

- **No streaming Sortformer today.** The only diarizer is **embedding-clustering** (`stt_v2/diarization/*`: pyannote/wespeaker 256-d embeddings → session-scoped `SpeakerTracker` `max_speakers=2` → threshold `SpeakerIdentifier` + pyannote/segmentation-3.0 refinement). No frame-level streaming diarizer exists.
- **Streaming diarization is gated + finals-only + lossy.** `DiarizationConfig.enabled` defaults **False** ([`pipeline/dto.py:472`](../../../apps/stt-v2/src/stt_v2/pipeline/dto.py)); when on, `inference.py` attributes **finals only** (`process_partial` hard-sets `speaker_id=None`, [`streaming/inference.py:895-928`](../../../apps/stt-v2/src/stt_v2/streaming/inference.py)); recovery drops the diarizer (`speaker_identifier=None`, [`session_manager.py:2713`](../../../apps/stt-v2/src/stt_v2/streaming/session_manager.py)).
- **The default pipeline is off.** `production-whisper-large-v3` (`isDefault: true`) omits the diarization block; the non-default `faster_whisper_turbo_int8` sets `diarization.enabled: true` but carries a model-repo TODO ([`seed/06-stt.ts`](../../../packages/database/src/prisma/db_main/seed/06-stt.ts)).
- **The surfacing seam is inconsistent.** The caption gateway [`stt-ws.gateway.ts`](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts) has **zero** speaker refs; the applications bridge [`streamingAudioBridge.service.ts:627-680`](../../../packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts) parses `speaker_id`/`speaker_confidence`; the UI renders `speaker_label` (which the backend never emits on the streaming path). **Net: no labels reach the clinician** — the capability B2 delivers.
- **Existing hooks that de-risk B2** (already present): `ModelTaskType.SPEAKER_DIARIZATION` + `AiModelFormat.NEMO` enums (`pipeline/dto.py:16, 35`), a working NeMo loader path (`nemo-parakeet-english` pipeline seed), `ModelRefs.segmentation`/`.embedding` slots, `SegmentResult.speaker_id/speaker_confidence` serialization ([`streaming/schemas.py:159-160, 182-184`](../../../apps/stt-v2/src/stt_v2/streaming/schemas.py)), a rendering path in the SDK + playground (`speaker_label`), and the doctor `preseed_speaker` naming helper.

**SOTA delta** (TASK-448 §SOTA S1, dated): peer target is frame-level sub-second speaker labels; Streaming Sortformer (arXiv:2507.18446) is the self-hostable state of the art for low-latency streaming diarization. The precise replace-vs-augment call, cadence, and accuracy metric come from **TASK-474's B2 Build Brief** (this ticket's DoR) — the Implementation Plan below is the frame those decisions fill.

## Implementation Plan (TDD sketch — strict order; refined by TASK-474's brief)

> Context pack for the implementing agent: this README · **TASK-474's B2 Build Brief** (DoR — the replace/augment + cadence + metric + surfacing decisions) · TASK-470 README (§Gate contract + the scorecard files to extend, NOT fork) · [SOTA-Track §Theme B + §Governing principle](../SOTA-Track/README.md) · `.claude/rules/06-python-services.md` (NeMo/uv, `X-Service-Token`, hermetic tests) · `.claude/rules/05-nestjs-api.md` (gateway change).

1. **Extend the gate first (TASK-470 coordination)** — add the diarization-accuracy metric + threshold to TASK-470's scorecard and a de-identified 2-speaker clinical fixture with speaker-turn ground truth; capture the pre-change baseline (RED-for-the-gate: the metric exists, the current stack scores ~0 labels). Coordinate with TASK-470's owner per the manifest-growth guard.
2. **RED (diarizer unit)** — write the Sortformer streaming-diarizer contract tests (frame→turn labels, 2-speaker, load/shutdown, self-hosted-only egress assertion) before the implementation.
3. **GREEN (diarizer)** — implement the streaming Sortformer diarizer (new `diarization/` module) behind the `DiarizationConfig.backend` selector; NeMo model load via the existing `AiModelFormat.NEMO` path, pinned revision, GPU + documented CPU fallback.
4. **Wire the hot path** — integrate frame-level turns into `streaming/inference.py` at the B1-recommended cadence (partials + finals), construct it in `session_manager.py`, and **fix recovery** to keep the diarizer across resume.
5. **Fix the surfacing contract (from B1)** — forward speaker data on the confirmed live caption path (gateway and/or bridge) and map `speaker_id` → `speaker_label` with clinician/patient semantics; end-to-end regression test STT-v2 → SDK → playground.
6. **Coexistence** — keep `preseed_speaker` naming the clinician; keep embedding-clustering + batch intact behind the selector; enable Sortformer on a pipeline via seed/config.
7. **Score + gate** — run TASK-470's extended scorecard: the diarization metric meets threshold (AC-5) **and** every ASR guardrail holds (AC-6). Record the scorecard artifact in this folder.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm docker:test:up
pnpm test:api:up            # terminal 1
pnpm test:stt-v2:up         # terminal 2 (Sortformer-enabled pipeline seeded)
pnpm py:stt-v2:test:integration   # TASK-470 scorecard: diarization metric + ASR guardrails
pnpm py:stt-v2:test && pnpm py:stt-v2:lint && pnpm py:stt-v2:typecheck
pnpm --filter @arcaai/applications build lint test   # bridge/emitter surfacing change
pnpm build:api && pnpm lint                          # gateway change (hard errors here)
```

Adversarial review focus: (a) does audio truly stay on-prem (no cloud call in the Sortformer path)? (b) do the labels reach the *clinician* end-to-end, or only the STT-v2 result dict? (c) does the extended scorecard **actually fail** on a synthetic diarization regression (proven, not asserted)? (d) do the ASR guardrails hold — no `commit_latency`/`partial_revision`/`medical_wer` regression from the added hot-path work? (e) is the embedding-clustering + batch + preseed path preserved behind the selector? (f) does recovery keep labels?

## File-ownership manifest (best-effort exclusive — binding — refined by TASK-474's brief)

| Path | Change |
|---|---|
| `apps/stt-v2/src/stt_v2/diarization/streaming_sortformer.py` (new) | The self-hosted Streaming Sortformer diarizer (frame→2-speaker turns); NeMo load via `AiModelFormat.NEMO`, `backend`-selected. |
| `apps/stt-v2/src/stt_v2/diarization/__init__.py` | Export the new diarizer. |
| `apps/stt-v2/src/stt_v2/pipeline/dto.py` | `DiarizationConfig.backend: "embedding" | "sortformer"` selector (default preserves current behavior); any Sortformer-specific knobs. |
| `apps/stt-v2/src/stt_v2/streaming/inference.py` | Wire frame-level turns into the per-utterance loop at the B1 cadence (partials + finals). |
| `apps/stt-v2/src/stt_v2/streaming/session_manager.py` | Construct the streaming diarizer; **fix recovery** to keep it (`:2713`). |
| `apps/stt-v2/src/stt_v2/streaming/schemas.py` | `speaker_label` on `SegmentResult` (+ `to_dict`) if the B1 mapping lands server-side. |
| `apps/stt-v2/tests/unit/diarization/`, `tests/unit/streaming/` (new tests) | Diarizer contract + hot-path wiring + recovery-keeps-labels. |
| `packages/database/src/prisma/db_main/seed/06-stt.ts` | Enable Sortformer streaming diarization on a pipeline (config template). |
| `apps/api/src/modules/streaming/stt-ws.gateway.ts` **or** `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts` | Forward speaker data on the confirmed live caption path (B1 decides which is live); `speaker_id`→`speaker_label` mapping. |

**Shared with TASK-470 (coordinate — additive only)**: `apps/stt-v2/tests/integration/streaming_quality.py`, `streaming_thresholds.json`, `apps/stt-v2/tests/e2e/fixtures/clinical/` — extend with the diarization metric + threshold + a 2-speaker speaker-turn fixture. **STOP-and-report** before any non-additive edit to a TASK-470 file (its manifest owns them); prefer an additive function + a new threshold row, or a sibling `streaming_diarization_quality.py` if the B1 brief so recommends.

**Read-only reference (do NOT modify)**: `apps/stt-v2/src/stt_v2/transcription/batch_service.py` (batch path stays), `diarization/preseed.py` (naming stays), `diarization/{speaker_tracker,speaker_identifier,embedding_service}.py` (embedding path stays behind the selector), the SDK `stt-v2.ts` types + admin-console playground renderers.

## Non-goals

(See §Requirement Analysis Non-goals — self-hosted only; 2-speaker only; no harness/system-of-record change; no live-note/NER redesign; no batch change; extend TASK-470's scorecard, don't fork it.)

## Implementation Summary (2026-07-11 — scaffold; model-blocked remainder deferred)

Delivered the **buildable, model-independent** slice of B2 (the exact posture of TASK-479): everything that does NOT require the un-staged Streaming Sortformer weights, behind a clean seam, TDD red→green, hermetic. Then stopped at the model boundary.

### What was BUILT (green)

| Piece | Detail |
|---|---|
| **Backend selector** (`pipeline/dto.py`, `pipeline/yaml_parser.py`) | `DiarizationConfig.backend: "embedding" \| "sortformer"` **defaults to `embedding`** (current behavior preserved — AC-7), plus Sortformer knobs (`sortformer_model_id` = `nvidia/diar_streaming_sortformer_4spk-v2` cc-by-4.0, `sortformer_revision`, `sortformer_threshold`, `sortformer_frame_shift_s`). Parsed + validated (`VALID_DIARIZATION_BACKENDS`; unknown backend → validation error). No new env var (per-pipeline config, not host env) → no `turbo.json`/`.env.example` change; no deps → no `uv lock`. |
| **Sortformer backend skeleton** (`diarization/streaming_sortformer.py`, exported from `diarization/__init__.py`) | `SortformerBackend` Protocol + `StreamingSortformerDiarizer` (injectable backend for hermetic tests) + `StreamingDiarizationResult.to_turns()` (pure frame-prob → 2-speaker turn thresholding — the reusable half that survives once the model lands). `load_default_backend()` **raises `SortformerModelUnavailableError` until the `.nemo` is staged** (mirrors `groundedness_nli.load_default_scorer`); the diarizer **degrades to "no labels" (`applied=False`)** rather than crashing the ASR hot path, reproducing today's diarization-off behavior. PHI-safe logs (sample COUNT + reason only, never samples/text). |
| **Diarization-accuracy metric** (`tests/integration/streaming_diarization_quality.py` — a **sibling** of TASK-470's `streaming_quality.py`, NOT a fork) | `diarization_error_rate` (NIST DER, optimal speaker-label mapping → label-permutation invariant), `jaccard_error_rate`, `speaker_confusion_rate`, `attribution_accuracy`, `build_diarization_scorecard` / `diarization_regression_report` / `assert_no_diarization_regression` (the AC-5 gate, mirroring TASK-470's shape), `load_turns_fixture`. Committed sibling thresholds `tests/integration/streaming_diarization_thresholds.json` (bootstrap ceilings/floors; `baseline: null` until the model-staged live capture). **TASK-470's `streaming_quality.py` + `streaming_thresholds.json` were left byte-untouched.** |
| **De-identified synthetic fixture** (`tests/e2e/fixtures/clinical/two_speaker_consult_01.turns.json`) | 10 non-overlapping clinician/patient turns w/ speaker-turn ground truth. Fully invented dialogue — no real PHI. |

RED→GREEN tests (all hermetic, no model, no infra):
- `tests/unit/diarization/test_streaming_sortformer.py` (11): factory **raises** unavailable + names model/ticket; diarizer **degrades** to `applied=False`/`reason=sortformer_model_unavailable` and never raises; PHI-safe log (asserts audio samples absent from log); `to_turns` merges same-speaker frames, splits on sub-threshold silence; `reset()` drops the lazy backend.
- `tests/unit/diarization/test_streaming_diarization_quality.py` (17): DER perfect-with-swapped-labels = 0; single-speaker-hyp confusion 0.5; missed / false-alarm / empty-hyp / empty-ref; JER 0.75 case; confusion + attribution; **gate FAILS on a synthetic DER regression and on an attribution regression, PASSES on a good card, never passes vacuously** (the AC-5 "gate actually fails" proof); fixture loads 2 speakers + self-scores DER 0.
- `tests/unit/diarization/test_diarization_config.py` (+7 additive): backend default `embedding`; Sortformer-knob defaults; parse `sortformer`; **validation rejects an unknown backend**.

### What is BLOCKED (not built here — explicit boundary)

| Deferred | Why | Owner/ticket |
|---|---|---|
| Live Sortformer inference inside `load_default_backend` + AC-1 GPU load | `.nemo` weights un-staged + no NeMo/GPU runtime | this ticket, **post model-staging** |
| Hot-path wiring (`inference.py` frame cadence), diarizer construction + **recovery fix** (`session_manager.py:2713`, AC-4), server-side `speaker_label` on `schemas.py` | Cannot be verified end-to-end without the model (would only degrade to today's no-op); TDD would be non-hermetic | this ticket, **post model-staging** |
| AC-5 live DER capture + AC-6 ASR-guardrail no-regression run | Needs the model + a live stack + real de-identified audio | this ticket, **post model-staging** |
| Seed a Sortformer-enabled pipeline (`seed/06-stt.ts`) | Would point at an un-staged model (like the existing `MODEL_REPO_PLACEHOLDER`); default stays `embedding` | this ticket, **post model-staging** |
| **Surfacing contract** (gateway/bridge/DTO/frame-51 hook) — labels reaching the clinician | **Separate ticket TASK-489** (from the TASK-474 FT-1 finding) — do-not-touch here | **TASK-489 (blocking prerequisite)** |

### Model-staging ask (for the orchestrator)

- **Model**: `nvidia/diar_streaming_sortformer_4spk-v2` (HF repo id) — NVIDIA Streaming Sortformer (arXiv:2507.18446), ~**471 MB** `.nemo`, ~117 M params. Stage into `HF_HOME=/Volumes/aillusion/huggingface` (today holds only whisper + silero + pyannote-embedding).
- **Runtime**: needs the **NeMo/PyTorch GPU** runtime — **no working CPU/ONNX path** (open NeMo issue). Add `nemo_toolkit` + `torch` to `apps/stt-v2` deps (heavy) and `uv lock` at root when staging (mypy already pre-lists `nemo_toolkit`/`nemo` in `ignore_missing_imports`).
- **Licensing**: pick the **cc-by-4.0** checkpoint (`…4spk-v2`, commercial-OK) — **NOT** the cc-by-nc offline v1 (non-commercial) and not the v2.1 NVIDIA Open Model License. Pin by revision when staged (AC-1).
- **Once staged**: implement the NeMo streaming session inside `load_default_backend` against the `SortformerBackend` seam — the diarizer, `to_turns` thresholding, config, metric, and tests do NOT change. Then wire the hot path + recovery, capture the AC-5 baseline into `streaming_diarization_thresholds.json` (tighten `baseline` off null), and re-run TASK-470's scorecard for the AC-6 no-regression check. Track guardrail: self-hosted only — no cloud diarizer receives clinical audio.

### Blocking prerequisite — TASK-489 (surfacing contract)

Per the TASK-474 §B2 Build Brief item 4 / finding **FT-1**: even a perfectly-diarized stream shows **nothing** on the default admin surface today — the wire DTO has no `speakerLabel`, the frame-51 hook reads a `speakerLabel` the backend never sends, and the id→label derivation is fragmented. **TASK-489 must land for TASK-475's user-visible outcome (AC-2/AC-3).** It is a **separate ticket** and was deliberately **not touched** here.

### Gate evidence

```
pnpm py:stt-v2:test        → 2392 passed, 37 skipped (integration; infra down — graceful), 3 xfailed
                              (new: 45 diarization scaffold tests green)
pnpm py:stt-v2:lint (ruff)  → All checks passed!
pnpm py:stt-v2:typecheck    → Success: no issues found in 104 source files
black --line-length 100     → formatted (canonical)
```

## Change History

| Date | Change |
|---|---|
| 2026-07-11 | **Scaffold implemented** (Status → Review). Built the model-independent B2 slice TDD red→green (TASK-479 posture): `DiarizationConfig.backend` selector (default `embedding`) + Sortformer knobs with parse/validate; `diarization/streaming_sortformer.py` — `SortformerBackend` Protocol + `StreamingSortformerDiarizer` (injectable, fail-closed) + pure `to_turns` thresholding + `load_default_backend` **raising `SortformerModelUnavailableError` until the `.nemo` is staged** (degrades to "no labels", never crashes the hot path; PHI-safe logs); a DER/JER/confusion/attribution metric + regression gate as a **sibling** `streaming_diarization_quality.py` (+ sibling `streaming_diarization_thresholds.json`, bootstrap thresholds, `baseline: null`) — **TASK-470's scorecard files left untouched**; a de-identified synthetic 2-speaker clinical turn fixture. 45 new hermetic tests (incl. the AC-5 "gate actually fails on a synthetic diarization regression" proof). Gates: `pnpm py:stt-v2:test` 2392 passed / 37 integration-skipped / 3 xfailed, ruff clean, mypy clean. **Explicit boundary**: the live Sortformer inference (AC-1), hot-path wiring + recovery fix (AC-4), and AC-5/AC-6 live capture are **BLOCKED on model staging** (see §Model-staging ask); the **surfacing contract is TASK-489** (blocking prerequisite for AC-2/AC-3) and was not touched. No `inference.py`/`session_manager.py`/`schemas.py`/seed/TASK-489/TASK-490/TASK-470-owned files changed; no env var / dep changes. |
| 2026-07-10 | Ticket scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme B2). Current State **code-verified** against `fix/2605-review` @ 87199e33 (full inventory in [TASK-474](../TASK-474-Diarization-Internals-Review/README.md)): **no streaming Sortformer exists**; the only diarizer is disabled-by-default, finals-only, recovery-lossy **embedding-clustering**, and its speaker data never reaches the clinician (gateway drops it; UI renders a `speaker_label` the backend doesn't emit). Confirmed de-risking hooks already present (`ModelTaskType.SPEAKER_DIARIZATION` + `AiModelFormat.NEMO` enums, a working NeMo loader, `SegmentResult` speaker serialization, an SDK/playground `speaker_label` render path, doctor `preseed`). Defined the Streaming Sortformer (arXiv:2507.18446, self-hosted NeMo) build: emit live clinician/patient labels, coexist with embedding-clustering/preseed/batch behind a `DiarizationConfig.backend` selector, fix the surfacing seam + recovery-loses-state, and feed the live-note/NER lineage. **Dual-gated**: DoR is TASK-474's §B2 Build Brief; acceptance is TASK-470's scorecard extended with a diarization-accuracy metric (AC-5) with all ASR guardrails held (AC-6). Marked measurement-gated + self-hosted-only. No implementation — plan/manifest only; no code changed. |
