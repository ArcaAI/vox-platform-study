# TASK-474 — Diarization Internals Review (Theme B1 · SOTA S1-DIAR · **scoped follow-up review**)

- **Status**: Pending (review-only — mirrors TASK-448: produces a findings/assessment register + a build-brief for TASK-475, **zero source-code change**)
- **Type**: Quality audit / architecture review (closes an explicitly-deferred TASK-448 risk item)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **B1** (diarization)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §Risk register — *"Diarization/inference internals were outside the reviewed file set → speaker-attribution correctness **unassessed**; scope a follow-up review of `stt_v2/diarization/*` + `inference.py` alongside the S1-DIAR work"* (also §Per-subsystem state B and §SOTA S1 "Speaker label: none in live loop → capability absent").
- **Theme**: B1 · **Size**: S–M · **Value**: Med (unassessed-risk closure + de-risks TASK-475) · **Risk**: Low
- **Depends on**: — (**no dependency — can run any time**; it needs no running stack and gates nothing except that its brief informs TASK-475).
- **Gates / feeds**: [TASK-475](../TASK-475-Streaming-2Speaker-Diarization/README.md) (B2) — this review's §B2 Build Brief is TASK-475's Definition-of-Ready input.
- **Suggested agent**: a small opus-4.8/xhigh review campaign (2–3 subagents: 1 code reviewer over `diarization/*`, 1 over the streaming/batch wiring + surfacing seam, 1 SOTA researcher on Streaming Sortformer vs embedding-clustering) + a batched verifier — the TASK-448 method, scoped to Theme B.

## Requirement Analysis

TASK-448 reviewed the harness loop with 10 subagents but **deliberately excluded** the diarization internals and `inference.py`'s speaker path from the deep-read file set, and recorded the omission as a named risk: **speaker-attribution correctness is UNASSESSED**. It also asserted, at the S1 gap level, that the live loop attaches **no** speaker labels ("Speaker label: none in live loop → capability absent"). Before TASK-475 (B2) builds Streaming Sortformer on the hot path, that gap must be turned from an assumption into a **code-verified finding register** — otherwise B2 would be built on an un-reviewed base and might duplicate or fight an existing (partial) diarization stack.

This ticket is the **scoped follow-up review** that:
1. **Closes the unassessed-risk item** — deep-reads `stt_v2/diarization/*` + `streaming/inference.py` (+ the batch and gateway/SDK surfacing seam) and produces a TASK-448-style findings register (`file:line` evidence, adversarially verified) on **speaker-attribution correctness**, streaming behavior, and the surfacing path.
2. **Resolves the register's flat claim into the real, nuanced state** — the code-verified Current State below already shows the picture is *not* "no diarization code" but "**disabled-by-default, finals-only, embedding-clustering diarization with an inconsistent surfacing path**". The review confirms/refines/quantifies this.
3. **Produces the B2 Build Brief** — a Definition-of-Ready input for TASK-475: the replace-vs-augment recommendation for the streaming path, the speaker-attribution accuracy metric TASK-470 must gain (DER/JER/confusion — TASK-470 explicitly lists diarization scoring as its own Non-goal), the surfacing-contract fixes (gateway vs bridge, `speaker_id` vs `speaker_label`), and the migration/coexistence plan with the existing embedding-clustering + voice-profile-preseed assets.

**This is a review — no source code is changed.** Every finding becomes an input to TASK-475 or a small candidate fix; none is executed here (identical posture to TASK-448).

### Acceptance criteria (review-completeness gates)

- [ ] **AC-1 (full file coverage with evidence)** — every module under `apps/stt-v2/src/stt_v2/diarization/` (8 files) + `streaming/inference.py`'s speaker path + `transcription/batch_service.py`'s diarization path + the surfacing seam (`stt-ws.gateway.ts`, `streamingAudioBridge.service.ts`, `transcriptionRealtime.service.ts`, SDK `stt-v2.ts`) is reviewed, each finding carrying a verbatim `file:line` quote (the TASK-448 evidence gate).
- [ ] **AC-2 (speaker-attribution correctness assessed)** — the core deferred question is answered with evidence: does the embedding-clustering path (pyannote/wespeaker 256-d embeddings → session-scoped `SpeakerTracker` hybrid centroid+max-sim → high/low-threshold `SpeakerIdentifier` → on-demand pyannote/segmentation-3.0 refinement) produce **clinically-adequate clinician/patient separation**, and where does it fail (threshold brittleness, capacity fallback mislabeling, ambiguous-zone behavior, embedding quality on 5-s clips)?
- [ ] **AC-3 (streaming behavior characterized)** — the finals-only design (partials never diarized), the `speaker_id="unknown"` fallback, the **recovery-loses-speaker-state** path (`session_manager.py` recovery passes `speaker_identifier=None`), and per-utterance vs frame-level attribution are documented with their clinical consequences.
- [ ] **AC-4 (surfacing seam mapped)** — the review states, definitively, what a clinician sees today: the default (`isDefault: true`) pipeline runs with diarization **off**; the NestJS caption gateway drops speaker data while the applications bridge parses it; the backend emits `speaker_id` but the UI renders `speaker_label` (a field-name gap). The **net clinician-facing result (no labels by default)** is proven, not asserted.
- [ ] **AC-5 (existing test coverage inventoried)** — the review lists what `tests/unit/diarization/*` + `tests/unit/streaming/test_inference_embedding_separation.py` already lock (config defaults, preseed, tracker, identifier decision-tree, segmentation, partials-skip-diarization) vs what is **untested** (accuracy on real 2-speaker clinical audio, DER/JER, the surfacing contract, recovery-loses-state), so TASK-475's TDD list starts from ground truth.
- [ ] **AC-6 (SOTA delta)** — a short, dated (2024–2026) comparison of the current embedding-clustering approach vs **NVIDIA Streaming Sortformer** (arXiv:2507.18446) and peer ambient scribes, with a self-hosted-only posture note (no cloud diarization vendor receives clinical audio).
- [ ] **AC-7 (B2 Build Brief delivered)** — §B2 Build Brief below is filled with the replace-vs-augment recommendation, the new diarization accuracy metric for TASK-470, the surfacing-contract fix list, and the coexistence plan with voice-profile preseed + batch diarization. This is TASK-475's DoR.
- [ ] **AC-8 (zero source change)** — `git status` shows only this ticket doc; no `apps/stt-v2` / `apps/api` / `packages/*` source touched (TASK-448 scope-proof posture).

### Non-goals

- Implementing streaming Sortformer or any diarization change — that is [TASK-475](../TASK-475-Streaming-2Speaker-Diarization/README.md) (B2). This ticket only reviews and briefs it.
- Changing the **batch** diarization path (`batch_service.py`) — it is in scope to *read* (it shares the primitives), but its behavior is post-hoc/system-of-record-adjacent and not the live-surface gap; any batch fix is a separate candidate ticket.
- Fixing the surfacing-contract bugs found here (gateway-drop, `speaker_id`/`speaker_label` mismatch) inline — they are logged as findings and folded into TASK-475's manifest (or spun out as small P2 fixes), not patched in a review ticket.
- Voice-profile enrollment / `voice_profile/*` redesign — enrollment feeds `preseed_speaker`; it is context, not scope.
- Re-litigating the removed Qdrant vector store (TASK-330) — the session-scoped replacement is the reviewed baseline.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ 87199e33)

The TASK-448 register's one-line "no speaker labels in the live loop → capability absent" is **directionally correct for the default clinician experience but materially incomplete about the code**. The real state (the review formalizes this):

### A full embedding-clustering diarization subsystem EXISTS (not Sortformer)

`apps/stt-v2/src/stt_v2/diarization/` — 8 modules (~740 LOC), session-scoped, no external vector DB (replaced the Qdrant store removed in TASK-330; guarded by `tests/unit/diarization/test_no_qdrant_vectorstore.py`):

| File | Role |
|---|---|
| [`dto.py`](../../../apps/stt-v2/src/stt_v2/diarization/dto.py) | `SpeakerEmbedding` (256-d), `SpeakerIdentification`, `DiarizedSegment`, `DiarizationResult`. |
| [`embedding_service.py`](../../../apps/stt-v2/src/stt_v2/diarization/embedding_service.py) (255) | `EmbeddingService` ABC (threading + async dispatch + batch) + `create_embedding_service()` factory + `get_embedding_service()` singleton; picks pyannote vs speechbrain by HF model-ID prefix. |
| [`pyannote_embedding.py`](../../../apps/stt-v2/src/stt_v2/diarization/pyannote_embedding.py) (59) | pyannote `Inference(window="whole")` — `pyannote/embedding`, `pyannote/wespeaker-*`. |
| [`speechbrain_embedding.py`](../../../apps/stt-v2/src/stt_v2/diarization/speechbrain_embedding.py) (57) | speechbrain ECAPA-class embeddings. |
| [`speaker_tracker.py`](../../../apps/stt-v2/src/stt_v2/diarization/speaker_tracker.py) (105) | Per-session in-memory N-speaker state; **default `max_speakers=2`**; hybrid **centroid(0.7)+max-sim(0.3)** scoring over an L2-normalized rolling window (`max_embeddings_per_speaker=8`); generic `"Speaker N"` labels unless a custom id is supplied. |
| [`speaker_identifier.py`](../../../apps/stt-v2/src/stt_v2/diarization/speaker_identifier.py) (131) | Decision tree: no-speaker→register · `≥high_threshold`(0.7)→match(+update if `≥min_update_confidence`0.8) · `<low_threshold`(0.4)→new · **ambiguous zone**→on-demand pyannote/segmentation-3.0 sub-segment split (depth-guarded); capacity fallback → best match. |
| [`segmentation_service.py`](../../../apps/stt-v2/src/stt_v2/diarization/segmentation_service.py) (150) | Lazy CPU `pyannote/segmentation-3.0` turn detection; dominant-speaker-per-frame boundary extraction. |
| [`preseed.py`](../../../apps/stt-v2/src/stt_v2/diarization/preseed.py) (157) | Registers the consultation **doctor's enrolled voice profile** (from DB voice-profile embedding) into the tracker so labels use the real display name instead of `"Speaker N"`; non-fatal (TASK-296 echo contract); shared by streaming + batch. |

Settings defaults ([`core/config/settings.py:221-232`](../../../apps/stt-v2/src/stt_v2/core/config/settings.py)): `diarization_hf_model_id = "pyannote/wespeaker-voxceleb-resnet34-LM"` (256-d), `diarization_similarity_threshold = 0.7`, `diarization_device = "auto"`.

### It IS wired — into BOTH batch and streaming — but gated on `DiarizationConfig.enabled` (default **False**)

`DiarizationConfig.enabled = False` by default ([`pipeline/dto.py:472`](../../../apps/stt-v2/src/stt_v2/pipeline/dto.py); `high_threshold=0.7`, `low_threshold=0.4`, `max_speakers=2`, `enable_segmentation_refinement=True`).

- **Streaming** ([`streaming/inference.py`](../../../apps/stt-v2/src/stt_v2/streaming/inference.py), [`streaming/session_manager.py`](../../../apps/stt-v2/src/stt_v2/streaming/session_manager.py)):
  - `session_manager.py:492-582` builds a `SpeakerIdentifier` (+`SpeakerTracker`, +embedding service, +optional segmentation) and calls `preseed_speaker`, **all gated on `effective_diarization = diarization_config.enabled`**.
  - `inference.py:process_utterance` runs diarization **on FINAL utterances ONLY** — `embed + ASR in parallel → _identify_speaker → set result.speaker_id/speaker_confidence` (`:287, :307-433`). If enabled + text present + no id → `speaker_id = "unknown"` (`:428-429`).
  - `inference.py:process_partial` **explicitly skips** embedding + diarization and hard-sets `speaker_id=None` (`:895-928`) — **partials are never attributed** (the finals-only design `tests/unit/streaming/test_inference_embedding_separation.py::test_partial_utterance_skips_embedding_and_diarization` locks).
  - `SegmentResult` carries `speaker_id`/`speaker_confidence` and `to_dict` serializes them **only when present** ([`streaming/schemas.py:159-160, 182-184`](../../../apps/stt-v2/src/stt_v2/streaming/schemas.py)).
  - **Recovery loses speaker state** — the session-recovery construction passes `speaker_identifier=None` (`session_manager.py:2713`), so diarization silently stops after a resume even if it was enabled.
- **Batch** ([`transcription/batch_service.py`](../../../apps/stt-v2/src/stt_v2/transcription/batch_service.py)): full `Preprocess → VAD → ASR → Diarization → Postprocess`; two modes — **inline** per-chunk during ASR (`_inline_diarize_chunk`, `:1129-1197`) or **post-hoc** `_run_diarization` (`:592-716`); attaches `speaker_id`/`speaker_confidence` to segments and writes `metadata["diarization"]` (speakers_detected / new / ids). Runs when `spec.diarization.enabled and tenant_id`.

### Default config = diarization OFF; one non-default pipeline turns it on (but with a model TODO)

- `PIPELINE_CONFIGS.production` — used by the **`isDefault: true`** pipeline `production-whisper-large-v3` ([`seed/06-stt.ts:1089-1141, 1650-1659`](../../../packages/database/src/prisma/db_main/seed/06-stt.ts)) — has **no `diarization:` block at all** → defaults apply → **OFF** (its `enabled: true` lines are punctuation + dual-capture, not diarization).
- `PIPELINE_CONFIGS.faster_whisper_turbo_int8` **sets `diarization: enabled: true, max_speakers: 2`** (`06-stt.ts:1192-1194`), but its pipeline `production-faster-whisper-turbo-int8` is **`isDefault: false`** (`:1731`) and still carries a `MODEL_REPO_PLACEHOLDER` TODO (`:1145-1147`) — not yet a real converted model.
- Voice-profile playground demos seed `diarization: { enabled: true, autoEnroll: true }` (`seed/91-user.ts:987, 1070`) — a demo surface, not the clinical default.

### The surfacing seam is inconsistent → clinician sees NO labels by default

- The NestJS caption gateway [`apps/api/src/modules/streaming/stt-ws.gateway.ts`](../../../apps/api/src/modules/streaming/stt-ws.gateway.ts) has **zero** `speaker` references — it never forwards speaker data on the WS caption egress.
- But the applications-layer bridge [`streamingAudioBridge.service.ts:627-680`](../../../packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts) **does** parse `data.speaker_id`/`speaker_confidence` → emits `speakerId`/`speakerConfidence`; [`transcriptionRealtime.service.ts:273-292`](../../../packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts) forwards `speaker`/`speakerId`/`speakerLabel`/`speakerConfidence`; the SDK `stt-v2.ts` types carry them; and the admin-console playground **renders `speakerLabel`** ([`streaming-tab.tsx:218`](../../../apps/admin-console/src/features/playground-live-transcription/components/streaming-tab.tsx), [`consultation-demo-screen.tsx:757`](../../../apps/admin-console/src/features/playground-consultation/components/consultation-demo-screen.tsx), `use-live-stt-session.ts:193`).
- **The field-name gap**: the backend emits `speaker_id` (a raw id / preseeded display name), but the UI renders **`speaker_label`** — which the backend never populates on the streaming path. So even a diarization-enabled pipeline would not paint the human-readable label the UI expects without a mapping.
- **Net**: two live readers disagree (gateway drops, bridge carries); the default pipeline is off; even when on, it's finals-only, lost on recovery, and label-field-mismatched → **the clinician-facing live transcript shows no speaker labels today**, matching TASK-448's headline for the wrong-seeming reason (dormant + inconsistent, not absent).

### Existing test coverage (what B1 leans on; what's unassessed)

Present ([`tests/unit/diarization/`](../../../apps/stt-v2/tests/unit/diarization/) + [`tests/unit/streaming/test_inference_embedding_separation.py`](../../../apps/stt-v2/tests/unit/streaming/test_inference_embedding_separation.py)): config defaults, no-Qdrant guard, preseed (7 cases), tracker register/normalize/capacity, identifier high/low/ambiguous/capacity decision-tree, segmentation single/two/short, streaming pipeline-order + **partials-skip-diarization** + extract-embedding gating. **Unassessed** (the review's job, and TASK-475's TDD seed): speaker-attribution **accuracy** on real 2-speaker clinical audio (DER/JER/confusion), the finals-only clinical adequacy, the surfacing contract end-to-end, and recovery-loses-state.

## Implementation Plan (the review campaign — mirrors TASK-448, scoped to Theme B)

> Context pack for the reviewing agent: this README (esp. §Current State — the verified inventory is the *starting map*, to be confirmed/refined, not trusted blindly) · [TASK-448 README](../TASK-448-Harness-Loop-Quality-Review/README.md) (method + evidence-gate + verifier posture to mirror) · [TASK-470 README](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (the scorecard B2 must extend with a diarization metric) · [SOTA-Track §Theme B](../SOTA-Track/README.md) · `.claude/rules/06-python-services.md`.

1. **Deep-read with the TASK-448 evidence gate** — reviewer A: `diarization/*` (correctness of the tracker scoring, the identifier decision tree, threshold/capacity edges, embedding quality on short clips, segmentation refinement); reviewer B: the wiring + surfacing seam (`inference.py` finals-only + recovery-loses-state, `session_manager.py` gating/preseed, `batch_service.py` inline vs post-hoc, and the gateway-vs-bridge + `speaker_id`/`speaker_label` contract). Every finding needs a verbatim `file:line` quote; drop anything unsubstantiated.
2. **SOTA researcher** — Streaming Sortformer (arXiv:2507.18446) vs embedding-clustering for 2-speaker streaming; latency/accuracy targets; self-hosted (NeMo) footprint; peer ambient-scribe practice. All claims dated 2024–2026 + cited.
3. **Adversarial verifier** — re-read every Critical/High finding against the code (the TASK-448 skeptic pass), especially any "it's broken" claim about attribution accuracy or the surfacing contract.
4. **Synthesize the findings register** — TASK-448-style table (ID · area · category · severity · confidence · `file:line` · verdict · one-line), plus a per-question verdict (attribution correctness · streaming adequacy · surfacing seam · test gaps).
5. **Write the §B2 Build Brief** (below) — the Definition-of-Ready hand-off to TASK-475.

### Findings register (to be filled by the review — TASK-448 schema)

| ID | Area | Category | Sev | Conf | Location | Verdict | One-line |
|---|---|---|---|---|---|---|---|
| _B-01_ | _diarization/…_ | _(review)_ | _—_ | _—_ | _`file:line`_ | _—_ | _to be filled_ |

### B2 Build Brief (AC-7 — the deliverable that gates TASK-475's DoR)

To be completed by the review; the frame TASK-475 consumes:

1. **Replace vs augment (streaming path)** — does Sortformer *replace* the embedding-clustering identifier on the live loop, or run *alongside* it (Sortformer for frame-level clinician/patient turns, embedding-preseed for naming the clinician)? Recommendation + rationale.
2. **Coexistence plan** — what stays: `preseed_speaker` (doctor naming), the batch path, the voice-profile enrollment. What the streaming loop swaps. Whether `DiarizationConfig` grows a `backend: sortformer|embedding` selector.
3. **The diarization accuracy metric TASK-470 must add** — TASK-470 lists diarization scoring as its own Non-goal, so B2 must extend the scorecard: recommend the metric (DER / JER / speaker-confusion / 2-speaker attribution accuracy) + a de-identified 2-speaker clinical fixture with speaker-turn ground truth. This is the B2 acceptance number.
4. **Surfacing-contract fixes** — the exact edits B2 must ship so a label reaches the clinician: make the gateway forward speaker data (or confirm the bridge is the live path), resolve `speaker_id` → `speaker_label` mapping, and define the clinician/patient label semantics.
5. **Hot-path + recovery** — per-utterance vs frame-level cadence, the partials question, and fixing recovery-loses-speaker-state (`session_manager.py:2713`).
6. **Seed/config rollout** — which pipeline(s) enable it and how (given the default pipeline currently omits diarization and the one that enables it is non-default with a model TODO).

## File-ownership manifest (review-only — binding)

| Path | Contents |
|---|---|
| `docs/implementation/TASK-474-Diarization-Internals-Review/README.md` (this doc) | The findings register + per-question verdicts + §B2 Build Brief. **The only file this ticket writes.** |

**Read-only (deep-read, do NOT modify)**: `apps/stt-v2/src/stt_v2/diarization/*.py`, `apps/stt-v2/src/stt_v2/streaming/{inference,session_manager,schemas}.py`, `apps/stt-v2/src/stt_v2/transcription/batch_service.py`, `apps/stt-v2/src/stt_v2/pipeline/dto.py`, `apps/stt-v2/src/stt_v2/core/config/settings.py`, `packages/database/src/prisma/db_main/seed/06-stt.ts`, `apps/api/src/modules/streaming/stt-ws.gateway.ts`, `packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts`, `packages/applications/src/services/stt/realtime/transcriptionRealtime.service.ts`, the admin-console playground live-transcription/consultation features, and `apps/stt-v2/tests/unit/diarization/*` + `tests/unit/streaming/test_inference_embedding_separation.py`.

**Scope proof (Definition of Done)**: `git status` shows only this ticket folder added — **zero** source files touched (TASK-448 posture).

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Ticket scaffolded from the [SOTA-Track](../SOTA-Track/README.md) plan (Theme B1) to close the TASK-448 §Risk-register item ("diarization internals outside the reviewed set → speaker-attribution correctness unassessed"). Current State **code-verified** against `fix/2605-review` @ 87199e33: a full **embedding-clustering** diarization subsystem exists (`diarization/*`, 8 files, pyannote/wespeaker 256-d → session-scoped `SpeakerTracker` `max_speakers=2` → threshold `SpeakerIdentifier` + pyannote/segmentation-3.0 refinement + doctor voice-profile `preseed`), wired into **both** batch (`batch_service.py`) and streaming (`inference.py` finals-only, `session_manager.py` gated) but **`DiarizationConfig.enabled` defaults False**; the `isDefault: true` `production-whisper-large-v3` pipeline omits the diarization block (OFF), while the non-default `faster_whisper_turbo_int8` sets `enabled: true` (with a model-repo TODO); the NestJS caption gateway drops speaker data while the applications bridge parses it, and the backend emits `speaker_id` while the UI renders `speaker_label` (field gap) — so **the clinician-facing live transcript shows no speaker labels today** (TASK-448's headline confirmed, with the real nuance). Defined the review scope (8 diarization files + `inference.py` + batch + surfacing seam), review-completeness ACs, the TASK-448-mirroring campaign method, and the §B2 Build Brief that is TASK-475's Definition-of-Ready. No dependency. Review-only — no code changed. |
