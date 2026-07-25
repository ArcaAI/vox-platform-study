# TASK-479 — Live Output + Groundedness Moderation Gate (Theme D2 · SOTA S2-06/07)

- **Status**: Review (fail-closed gate wiring + hermetic tests implemented 2026-07-11; **MiniCheck GGUF scorer IMPLEMENTED + LIVE-CALIBRATED on-host 2026-07-12** per owner directive — llama.cpp backend, **calibration-gated**, default-OFF. Calibration self-check PASSES on this host (supported **0.9827** ≥ 0.60, unsupported **0.0063** ≤ 0.40 — near the published 0.981/0.007) and **AC-2 throughput MET** (**523 docs/min** on Apple-Silicon CPU, > 500 target). Remaining before production enablement: AC-6 real-model precision/recall over a labelled clinical corpus (no corpus on-host) + a long-transcript chunker + turbo.json globalEnv entries — see §Implementation Summary → MiniCheck GGUF scorer + enablement checklist)
- **Type**: feature (live-surface clinical-safety — output moderation + NLI groundedness before the clinician reads the draft)
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **D2** (Live-surface guardrails — the output side)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA **S2** guardrail table — the live-summary **output → clinician** row (SOTA: output-side + streaming/sentence-level moderation; HOPE: **none**) and the live-summary **groundedness** row (SOTA: NLI gate — MiniCheck Flan-T5-Large, >500 docs/min; HOPE: **none**) + verdict (c) "the live surface needs the output + groundedness moderation it currently lacks"
- **Completes the story started by**: [TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md) (D1 — SMR **input** fail-closed). D1 = input side; D2 = **output** side. Together an unmoderated PHI prompt cannot *enter* AND an ungrounded summary segment cannot *reach the clinician unmarked*.
- **Complements (do not subsume)**: [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md) (C2 — re-points the live **NER** at the transcript so entity hallucinations are not laundered). C2 grounds **entities**; D2 grounds the **summary prose**. Two independent live-surface safety layers.
- **Theme**: D2 · **Size**: L · **Value**: High · **Risk**: Med (adds an inline step to the live loop — must stay responsive and degrade-safe, never brick or freeze the live feed)
- **Depends on**: [TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md) (D1 — completes the fail-closed guardrail posture this builds on). **Measure-first note**: TASK-470's ASR scorecard is **orthogonal** to D2 (D2 runs *downstream of the transcript*, on the SMR-generated note — it does not touch the ASR path), so D2 carries its **own** groundedness-gate metric (see AC-6) rather than gating on TASK-470's medical-WER/latency numbers.
- **Suggested agent**: security-auditor (mirrors TASK-465 / TASK-478 — a clinical-safety + fail-closed lens) spanning `apps/guardrail` Python + `packages/applications` TS; run the Python and TS gates separately.
- **Hard guardrail (track-level)**: **self-hosted models only — no cloud PHI.** The NLI groundedness model (MiniCheck / Flan-T5-Large / HHEM-class) was chosen because it runs on-prem at the >500 docs/min throughput the live loop needs. Do NOT introduce a cloud moderation/NLI vendor that receives clinical summary text or transcripts.

## File-ownership manifest (best-effort exclusive — binding)

The gate is a new self-hosted NLI verifier in the guardrail service + a single inline call in the live-documentation flush, between the note being built and the note being published.

| File | Change | Layer |
|---|---|---|
| `apps/guardrail/src/guardrail/services/groundedness_nli.py` (new) | The self-hosted **NLI groundedness verifier** (MiniCheck / Flan-T5-Large / HHEM-class): sentence/claim-vs-source entailment over `(summary_segment, transcript)`; batched for the >500 docs/min target; deterministic; unit-testable offline (a stubbed/tiny model in tests). Returns per-segment grounded verdicts + flagged spans. | guardrail |
| `apps/guardrail/src/guardrail/api/endpoints/guardrails.py` (extend) **or** `apps/guardrail/src/guardrail/api/endpoints/groundedness.py` (new) | A `POST /guardrail/ground` (output-moderation + groundedness) route: `{ summary, transcript }` → `{ segments: [{ text, grounded, flaggedSpans }], throughputDocsPerMin }`. Behind the `X-Service-Token` middleware exactly like the existing `/guardrail/analyze` + `/medical/validate` routes. Optionally fold the existing content-safety `analyze` pass in for the output-moderation half. | guardrail |
| `apps/guardrail/src/guardrail/core/config.py` | A `GroundednessConfig` (`env_prefix="GUARDRAIL_V2_"` to match the existing family): NLI model id, entailment threshold, batch size, `enabled` toggle (dev/CI empty-bypass vs clinical enforce, mirroring TASK-478's `enabled` posture), fail-closed knobs. | guardrail |
| `apps/guardrail/**/tests/**` | RED-first: the NLI verifier marks a transcript-supported claim **grounded** and a hallucinated claim (absent from the transcript) **ungrounded**; the endpoint contract; a degrade path (model unavailable → `unverified`, never silently grounded). | guardrail |
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | Insert the groundedness/output-moderation call **between** `runningSummary` build (`:558-561`) and `safePublish` (`:597`): mark ungrounded segments **before** the payload is published over SSE. Degrade-safe — a transient blip is absorbed (bounded retry), a sustained outage marks segments `unverified` (the live feed stays responsive; ungrounded text is **never** presented as verified). Resolve the guardrail URL via `IConfigService.getConfigValue('GUARDRAIL_URL')` (no direct `process.env`). | applications |
| `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` | Add an **additive** per-section (and/or per-segment) `grounded` / `unverified` flag + optional `flaggedSpans` so the SSE `LiveSummaryEventDto` carries the verdict for the panel to render the mark. Back-compatible (optional fields). | applications |
| `packages/applications/src/services/consultation/live-documentation/__tests__/**` | RED-first: current flush publishes with **no** groundedness verdict → after the change, ungrounded segments carry the flag before publish; degrade-safe path asserted (unavailable gate → `unverified`, feed still publishes). | applications |
| `apps/api` internal proxy (only if a new internal route is required) | Reach the guardrail groundedness endpoint through the gateway with `X-Service-Token` injection (`SecretsService`), the same posture as the SMR/NLP proxies. No new browser-facing route. | api |
| `turbo.json` · `.env.example` | Register the new `GUARDRAIL_V2_GROUNDEDNESS_*` knobs (per `.claude/rules/00`/`06`/`13`). | infra |

**Read-only reference (do NOT modify)**: `apps/guardrail/src/guardrail/api/endpoints/medical.py` (`/medical/validate` — the input-side route TASK-478's SMR client calls; the `X-Service-Token` + shape reference), `apps/guardrail/src/guardrail/api/endpoints/guardrails.py` (`/guardrail/analyze` — the content-safety reference), `apps/harness/src/harness/sensors/inferential/groundedness.py` (the **durable** post-draft groundedness sensor — at-par, stays; D2 is its **live-surface** counterpart, NOT a change to it), `apps/smr/src/smr/services/external_guardrail.py` (TASK-478's input path — the fail-closed posture to mirror on the output side).

**Manifest-growth guard (STOP-and-report)**: this ticket is **output-side, live-surface** only. Do NOT touch the **input** moderation (D1 [TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md) — done), the **harness post-draft** groundedness sensor (`sensors/inferential/groundedness.py` — at-par per TASK-448 S2 row 4; leave it), the **live NER** source/grounding (C2 [TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md)), the **durable authority** (the harness stays the system of record — the live gate marks, it does not sign), or the eval harness (TASK-470's owned files). Anything outside the manifest → STOP.

## Requirement Analysis

The live-documentation loop generates a running SOAP note from SMR and publishes it — verbatim — to the clinician's live panel over SSE, with **no output-side moderation and no groundedness check**. Because the LLM summary carries a material hallucination base rate (~40–50%, S2-04), an invented finding/medication/dose can be read by the clinician as fact before any safety pass. D2 adds two live-surface layers between "note generated" and "note published":

1. **Output moderation** — a content-safety pass on the generated summary text (the guardrail service already does this on the input side via `/guardrail/analyze`).
2. **NLI groundedness gate** — a **self-hosted** entailment check of each summary segment against the source transcript (MiniCheck / Flan-T5-Large-class, >500 docs/min) so **ungrounded segments are marked** before the clinician reads them.

This **completes** TASK-478's fail-closed guardrail story: D1 closed the input side (an outage cannot ship an unmoderated PHI prompt); D2 closes the output side (an ungrounded/unsafe summary segment cannot reach the clinician unmarked). The durable harness already has an at-par post-draft groundedness sensor — D2 fills the **live-surface** gap only, and must never become the system of record.

### Current-state framing (verified — the premise holds, with two refinements)

1. **The live surface genuinely has no output/groundedness check.** The SMR note is built and published in the same flush with nothing between them (verified below). The SMR `system_prompt` says "never fabricate findings" (`live-documentation.service.ts:1010`) — a *prompt-time hope*, not a *verification*. This is the real gap.
2. **The harness NLI machinery is judge-based and durable-only.** The at-par groundedness the review credits (`sensors/inferential/groundedness.py`) is an **LLM-JudgeClient** per-claim entailment on the **durable** Temporal path — far too slow (long-prefill judge calls) for the live loop's cadence, and never wired to the live surface. D2 therefore needs a **fast self-hosted NLI** (not the judge), which is why the model choice (MiniCheck-class, >500 docs/min) is load-bearing.
3. **Degrade-safe, not fail-loud.** Unlike the SMR input gate (which can hard-reject a request), the live gate sits on a best-effort ephemeral feed that must stay responsive. The fail-closed posture here is **"mark `unverified`, never mark `grounded` on error"** — a bounded retry absorbs a blip, a sustained outage degrades to `unverified` (the clinician sees the note but knows it is unchecked), and ungrounded text is never *presented as verified*. This mirrors TASK-478's degrade-safe→fail-closed asymmetry, adapted to a streaming surface.

### Acceptance criteria

- [ ] **AC-1 (NLI verifier — hermetic RED→GREEN)** — `groundedness_nli.py` marks a transcript-supported claim **grounded** and a claim absent from the transcript **ungrounded**, deterministically, with a **self-hosted** model (a tiny/stub NLI in tests — no network, no cloud). RED: verifier absent.
- [ ] **AC-2 (throughput target)** — the batched verifier sustains the **>500 docs/min** live target on the reference host (documented; asserted as a batching/latency property, not a flaky wall-clock test) — the reason a MiniCheck-class NLI is chosen over the durable JudgeClient sensor.
- [ ] **AC-3 (live-doc wiring — RED→GREEN)** — a test asserts the current flush publishes the payload with **no** groundedness verdict; after the change the call runs **between** `runningSummary` build and `safePublish`, and ungrounded segments carry the flag **before** publish. The SMR/NLP timing and payload shape are otherwise unchanged.
- [ ] **AC-4 (degrade-safe / fail-closed — pairs with D1)** — an unavailable/errored gate marks affected segments `unverified` and **never** marks them `grounded`; a transient blip is absorbed by a bounded retry (the segment is verified after a clean re-check); a sustained outage degrades to `unverified` without freezing or dropping the live feed. Assert no path yields `grounded: true` from the error branch.
- [ ] **AC-5 (SSE contract — additive)** — `LiveSummaryEventDto` carries the per-segment `grounded`/`unverified` flag (+ optional `flaggedSpans`); the field is optional/back-compatible; the panel can render the mark. Offsets (where used) index the rendered surface, consistent with the existing entity-offset contract.
- [ ] **AC-6 (measure-first — D2-owned metric; TASK-470 orthogonal)** — introduce D2's own **groundedness-gate metric**: NLI precision/recall on a small **self-hosted, de-identified** labelled grounded/ungrounded sample + the measured throughput. Record it in §Implementation Summary. TASK-470's ASR scorecard is orthogonal (D2 is downstream of the transcript and does not touch the ASR path); if the shared live pipeline is measurably perturbed, additionally re-run TASK-470 to confirm **no ASR-guardrail regression** — otherwise it does not apply.
- [ ] **AC-7 (pairs with TASK-478 — combined posture)** — §Implementation Summary states the combined guardrail posture: D1 (TASK-478) = SMR **input** degrade-safe→fail-closed; D2 = live **output** moderation + NLI groundedness gate (degrade-safe→`unverified`). Together, an unmoderated PHI prompt cannot enter and an ungrounded summary segment cannot reach the clinician unmarked.
- [ ] **AC-gate** — `pnpm py:guardrail:test` (+ `:cov`), `pnpm py:guardrail:lint`, `pnpm py:guardrail:typecheck` green; `pnpm --filter @arcaai/applications build test lint` green; `pnpm build:api` green (if a proxy/DTO change lands); new `GUARDRAIL_V2_GROUNDEDNESS_*` knobs in `turbo.json#globalEnv` + `.env.example`; self-hosted (no cloud egress); output pasted.

### Non-goals

- **Input-side moderation** (SMR prompt validation) — that is D1 ([TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md)); D2 is output-side only.
- **Changing the harness post-draft groundedness sensor** (`sensors/inferential/groundedness.py`) — at-par (S2 row 4); the durable path is untouched. D2 is the live-surface counterpart.
- **Re-pointing / grounding the live NER** — that is C2 ([TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md)); D2 grounds the summary **prose**, not the entities. Complementary, not overlapping.
- **Making the live gate authoritative** — the durable harness stays the system of record; the live mark is ephemeral UX (the clinician never signs the live note).
- **A cloud moderation / NLI vendor** — self-hosted only (track guardrail).
- **Blocking or hard-failing the live feed on an ungrounded segment** — D2 **marks**, it does not censor; the clinician still sees the (flagged) text. Hard-reject semantics belong to the input gate (D1), not a best-effort ephemeral feed.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `87199e33`)

**The live summary reaches the clinician with no output/groundedness check** — verified end to end in `live-documentation.service.ts::flush()`:
- `:555` — `const smrText = await this.callSmr(promptText, session.tenantId, signal);` — SMR generates the SOAP note.
- `:558-561` — `parseSoapJson(smrText) ?? parseSoapSections(smrText)` → `runningSummary = buildRunningSummary(parsed)` — `runningSummary` **is** the generated note.
- `:587-594` — builds `LiveSummaryEventDto { runningSummary, sections, entities, … }`.
- `:596` — `session.lastPayload = payload;` → `:597` — `await this.safePublish(consultationId, payload);` → Redis pub/sub → SSE to the clinician's panel. **Nothing runs between the note being built and the note being published** — no output moderation, no groundedness check.
- `callSmr` (`:993-1023`) sends a `system_prompt` "…never fabricate findings" (`:1010`) — a prompt-time instruction, **not** a post-hoc verification of the returned note.

**The SMR service moderates the input only** — `apps/smr/src/smr/api/endpoints/generate.py` runs the TASK-478 input gate (`verdict.get("allowed", False)` fail-closed at `:170`/`:193`); there is **no** output-side moderation of the generated note.

**The durable harness has an at-par groundedness sensor, but it is judge-based and never on the live surface** — `apps/harness/src/harness/sensors/inferential/groundedness.py` (`GroundednessSensor.arun`, `:161-185`) does per-claim entailment via the **LLM `JudgeClient`** (`_verdicts_per_claim`, `:187-243`) against the transcript ∪ evidence, threshold-gated. It runs inside the Temporal workflow's inferential pass (`workflows.py:505`), not on the live-documentation flush. Its long-prefill judge calls are unsuited to the live cadence — D2 needs a fast self-hosted NLI instead.

**The guardrail service is the natural home** — `apps/guardrail` (port 8863, "content safety / PII / medical validation") already exposes `POST /guardrail/analyze` (`endpoints/guardrails.py:57`, content-safety) and `POST /medical/validate` (`endpoints/medical.py:55`, the input path SMR calls), both behind the `X-Service-Token` middleware. A self-hosted output-moderation + groundedness-NLI route sits alongside these.

**The SSE DTO has no groundedness field today** — `live-summary.dto.ts:52` `LiveSummaryEventDto` carries `runningSummary` (`:57`), `sections` (`:60`), `entities` (`:63`) — no `grounded`/`unverified` marker. D2 adds one (additive).

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-478 README (the D1 input fail-closed / degrade-safe posture to mirror on the output side) · TASK-448 §SOTA S2 (the output/groundedness gap + the MiniCheck-class model choice + >500 docs/min) · TASK-449 §Architecture preamble (live surface is best-effort/ephemeral; harness authoritative) · `.claude/rules/06-python-services.md` (guardrail service — FastAPI, `X-Service-Token`, pydantic-settings `env_prefix`, ruff/mypy, hermetic CI, `uv lock`) · `.claude/rules/04`/`05` (live-documentation service, SSE, `IConfigService` downstream URLs, no `process.env` in modules).

1. **NLI verifier (RED→GREEN, hermetic)** — write `groundedness_nli.py` with a deterministic entailment scorer over `(segment, transcript)`; unit-test a grounded vs a hallucinated claim first (RED = verifier absent). Keep the model injectable so tests use a tiny/stub NLI (offline); document the production MiniCheck-class model + batching for the >500 docs/min target.
2. **Endpoint + config (RED→GREEN)** — add `POST /guardrail/ground` behind `X-Service-Token`; `GroundednessConfig` (`enabled` dev/CI bypass vs enforce, threshold, model id, batch size, fail-closed knobs). Assert the endpoint returns per-segment verdicts + flagged spans.
3. **Live-doc wiring (RED→GREEN)** — RED: a flush test asserts the payload is published with no groundedness verdict today. GREEN: insert the call between `runningSummary` build and `safePublish`; mark ungrounded segments in the payload; resolve `GUARDRAIL_URL` via `IConfigService`.
4. **Degrade-safe path** — bounded retry absorbs a blip; a sustained outage marks `unverified` (never `grounded`); the feed still publishes. Assert no error path yields `grounded: true`.
5. **DTO + SSE contract** — add the additive `grounded`/`unverified` (+ `flaggedSpans`) field to `LiveSummaryEventDto`; assert the panel-facing payload carries it.
6. **Measure (D2-owned)** — record NLI precision/recall on a self-hosted de-identified labelled sample + throughput; note TASK-470 is orthogonal (§AC-6).

### Verification gate (paste output into §Implementation Summary)

```bash
# guardrail (NLI verifier + endpoint)
pnpm py:guardrail:test && pnpm py:guardrail:lint && pnpm py:guardrail:typecheck
# live-doc wiring + DTO
pnpm --filter @arcaai/applications build test lint
pnpm build:api          # if a proxy/DTO change lands
```

Adversarial review focus (reviewer agent): (a) can ANY error path mark a segment `grounded` (grep the degrade branch — it must only ever mark `unverified`)? (b) does a transient blip get absorbed while a sustained outage degrades to `unverified` **without freezing/dropping the live feed** — proven by a test, not asserted? (c) is the NLI verifier deterministic + self-hosted (no hidden network, no cloud vendor)? (d) is the >500 docs/min target a real batching property, not a flaky wall-clock assertion? (e) is the DTO change additive/back-compatible (optional field, no break to existing SSE consumers)? (f) is the guardrail route behind `X-Service-Token` and the live-doc call resolving `GUARDRAIL_URL` via `IConfigService` (no `process.env`)? (g) zero diff outside the manifest — no input gate (D1), no harness sensor, no live NER (C2).

## Implementation Summary (2026-07-11)

Implemented via strict TDD (RED → GREEN) on the `fix/2605-review` base. Everything that does **not** require the live NLI model is built and green: the guardrail groundedness endpoint + verifier (fail-closed, behind `X-Service-Token`), the live-documentation wiring (verdict attached **between** note build and `safePublish`), the additive SSE DTO, the config knobs, and hermetic tests with the model **stubbed**. The one blocked piece is the production NLI scorer itself — the MiniCheck-class model is not staged in the offline HF cache (track guardrail: self-hosted only, no cloud PHI), so `load_default_scorer` deliberately raises `NliModelUnavailableError` and the whole chain degrades honestly to `unverified` (never `grounded`).

### What was built vs what is blocked

| Piece | State |
|---|---|
| `GroundednessNliVerifier` — deterministic segmentation (exact offsets), batched scoring, threshold verdicts, flagged spans, fail-closed degrade (`disabled` / `model unavailable` / `scorer error` / malformed scorer output → all `unverified`) | **Built + tested** (injectable `NliScorer` protocol; tests use a tiny deterministic keyword-overlap stub — no network, no model) |
| `POST /guardrail/ground` — `{summary, transcript}` → per-segment `{text, verdict, grounded, score, start, end}` + `flagged_spans` + `checked/reason/model_id/throughput_docs_per_min`; behind the TASK-465 `X-Service-Token` middleware; endpoint-level fail-closed backstop (verifier crash → 200 all-`unverified`, the deliberate inverse of the legacy fail-open `analyze`/`validate` error branches) | **Built + tested** |
| `GroundednessConfig` (`GUARDRAIL_V2_GROUNDEDNESS_*`): `enabled` dev/CI bypass vs clinical enforce (mirrors TASK-478), `model_id`, `entailment_threshold`, `batch_size`, `max_segments` | **Built** |
| Live-doc wiring — `checkGroundedness` runs **between** `runningSummary` build and `safePublish`; source = transcript ∪ clinician notes (mirrors the durable sensor); bounded retry absorbs a blip; sustained outage → `unverified`, feed still publishes; strict wire→DTO mapper (only the literal `grounded` verdict from an honest `checked: true` response can mark grounded); `GUARDRAIL_URL` via ConfigService (same pattern as the file's `SMR_URL`/`NLP_URL`, no `process.env`); `X-Service-Token` via the @Global `SecretsService` (`GUARDRAIL_SERVICE_TOKEN`), the harness-gateway pattern | **Built + tested** |
| `LiveSummaryEventDto.groundedness?` — additive/optional: worst-state rollup verdict + per-segment verdicts + `flaggedSpans` (offsets index `runningSummary`, same contract as entity highlights) | **Built + tested** |
| Env knobs in `turbo.json#globalEnv` + root `.env.example` + `apps/guardrail/.env.example` | **Built** |
| **Production NLI scorer** (real MiniCheck inference) | **Built 2026-07-11 (owner directive)** — GGUF/llama.cpp, calibration-gated, default-OFF. Live AC-2 throughput + AC-6 precision/recall numbers still pending an on-host staging run (below). |

### MiniCheck GGUF scorer (implemented 2026-07-11 · owner directive) + enablement checklist

Owner directive 2026-07-11 pinned the **quantised** MiniCheck and waived the license gate (MiniCheck is MIT / Flan-T5 Apache-2.0 — permissive; "GGUF everywhere"). Implemented against the `NliScorer` seam — endpoint, verifier, DTO, wiring unchanged:

- **Model**: `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF`, file `minicheck-flan-t5-large-q6_k.gguf` (~650 MB Q6, CPU-friendly) — a GGUF conversion of `lytang/MiniCheck-Flan-T5-Large`. Run under **llama.cpp** (`llama-cpp-python`).
- **New module** `services/groundedness_scorer_minicheck.py` — `LlamaCppMiniCheckScorer`: MiniCheck flan-t5 template `'predict: ' + doc + '</s>' + claim`, reads a 2-way softmax over the decoder's **no/yes** label tokens (HF vocab ids **3 / 209**, preserved by the GGUF conversion) → `P(yes)`. The llama.cpp first-step logit read is isolated in `_make_llama_logit_fn` (injectable → hermetic tests need no runtime).
- **Safety — the calibration gate**: because this path can't be numerically validated on CI (no GPU/weights) and Q6 + a hand-rolled T5 logit read can perturb the score, `load_minicheck_scorer` runs `verify_calibration()` against MiniCheck's **published reference pair** at load: a supported example must score ≥ 0.60 and an unsupported one ≤ 0.40, else it raises `NliModelUnavailableError` → the gate degrades to `unverified`. A mis-wired template/logit read (≈0.5 / inverted) or a too-lossy quant therefore **refuses to enable** rather than silently mis-passing ungrounded clinical text. Direction+margin, not exact value, so a correct-but-quantised scorer still passes. **MINOR-1 applied** (the review's deferred fix): the verifier's factory `except` now catches *any* construction/calibration error (not only `NliModelUnavailableError`) → fail-closed at the verifier level, not just the endpoint backstop.
- **Fail-closed + no network**: requires an explicit local `model_path` (a clinical gate never auto-downloads); missing llama-cpp-python, an unloadable model, or a failed calibration all → `unverified`. 34 hermetic tests green (math, template, order, calibration pass/collapse/invert, no-path fail-closed, factory-error fail-closed, verifier grounded/ungrounded/unverified). ruff + mypy clean.

**Enablement checklist (on a staging host):**
1. Stage the `.gguf` locally; set `GUARDRAIL_V2_GROUNDEDNESS_MODEL_PATH=/…/minicheck-flan-t5-large-q6_k.gguf`.
2. `uv sync --extra groundedness` (installs `llama-cpp-python`). **`uv lock` deferred** here (heavy build dep + the root lock was mid-edit by the concurrent TTS session) — same posture as TASK-483's boto3; the extra is declared in `apps/guardrail/pyproject.toml`.
3. **Add 5 env vars to `turbo.json#globalEnv` + `.env.example`** — `GUARDRAIL_V2_GROUNDEDNESS_{MODEL_FILE,MODEL_PATH,N_CTX,N_THREADS,N_GPU_LAYERS}`. **Deferred here** to avoid clobbering the concurrent TTS session's uncommitted `turbo.json`/`.env.example`; add at enablement. (The Python service reads process env directly, so this is Turbo-graph hygiene, not a runtime blocker.)
4. Set `GUARDRAIL_V2_GROUNDEDNESS_ENABLED=true`. The load-time calibration self-check validates the template/logit read. **✓ Validated on-host 2026-07-12** (supported 0.9827, unsupported 0.0063) — see the §Live calibration evidence block below. If it ever fails on a new host, re-validate the flan-t5 template + token ids (3/209).
5. Capture AC-2 throughput + AC-6 precision/recall. **AC-2 ✓ MET on-host**: **523 docs/min** single-pair sequential on Apple-Silicon CPU (n_gpu_layers=0) — above the >500 target even before GPU/batching. AC-6 real-model precision/recall still needs a **labelled clinical corpus** (none on-host; the 4-probe discrimination check below is directional, not a formal metric). **Long-transcript note (remaining)**: the source passes through at `n_ctx=512`, so long transcripts truncate — MiniCheck's design windows long docs (~512-token chunks, max-aggregate); add a transcript chunker before scoring long sources in production.

**Live calibration evidence (on-host 2026-07-12, `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF`, CPU, through the real `LlamaCppMiniCheckScorer` path):**

```
=== calibration reference pair ===
SUPPORTED   'The students are preparing for an examination.'  -> P(support)=0.9827   (>= 0.60 ✓)
UNSUPPORTED 'The students are on vacation.'                   -> P(support)=0.0063   (<= 0.40 ✓)
RESULT: verify_calibration() PASSED — scorer wiring valid on this host.
=== clinical discrimination probes ===
  [support   ] P(support)=0.9202  'The patient takes metformin 500mg twice daily.'
  [contradict] P(support)=0.0137  'The patient was prescribed insulin injections.'
  [support   ] P(support)=0.8137  'Lisinopril 10mg daily was initiated.'
  [contradict] P(support)=0.0051  'The patient underwent an appendectomy.'
=== throughput (AC-2) ===
scored 60 pairs in 6.89s  ->  8.7 docs/s  =  523 docs/min  (n_gpu=0, single-pair sequential)
```

Scores match the published model card (≈0.981/0.007) near-losslessly under Q6 — proving the encode→decode T5 wiring (below) is correct, not just internally consistent.

### Files changed

| File | Change |
|---|---|
| `apps/guardrail/src/guardrail/services/groundedness_nli.py` (new) | Verifier core: `split_segments` (offset-exact), `NliScorer` protocol, `GroundednessNliVerifier.verify` (batched, deterministic, fail-closed), `load_default_scorer` (raises `NliModelUnavailableError` until the model is staged). PHI-safe logs (counts/reasons only). |
| `apps/guardrail/src/guardrail/api/endpoints/groundedness.py` (new) | `POST /guardrail/ground` route + request/response models; app-state-cached verifier (tests pre-seed a stub); `asyncio.to_thread` for the CPU-bound scorer; fail-closed crash backstop. |
| `apps/guardrail/src/guardrail/core/config.py` | `GroundednessConfig` (`env_prefix="GUARDRAIL_V2_GROUNDEDNESS_"`), registered on `Settings.groundedness`. |
| `apps/guardrail/src/guardrail/main.py` | **Forced 2-line change** (router import + `include_router`) — the manifest's new-endpoint-file option requires registration; mirrors TASK-478's forced `main.py` precedent. `/guardrail/analyze` and all other routes byte-identical. |
| `apps/guardrail/src/guardrail/tests/test_groundedness_nli.py` (new) | 15 RED→GREEN verifier tests (AC-1 grounded-vs-hallucinated, determinism, offsets, flagged spans, AC-2 batching property, cap, all four fail-closed degrade paths, staging-boundary lock, segmentation, AC-6 metric harness). |
| `apps/guardrail/src/guardrail/tests/test_groundedness_endpoint.py` (new) | 6 RED→GREEN endpoint tests (contract + offsets + flagged spans, empty summary, `X-Service-Token` 401/200, model-unavailable degrade, disabled degrade, verifier-crash fail-closed). |
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | Gate wiring in `flush()` between build and publish; `checkGroundedness` (bounded retry → `unverified`) + strict `mapGroundednessResponse`; config knobs; optional `SecretsService` injection (appended param — all existing construction sites unchanged); PHI-safe flush-log fields (`groundednessVerdict`, `groundednessLatencyMs`). |
| `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` | Additive `LiveSummaryGroundednessDto` / `...SegmentDto` / `LiveSummaryFlaggedSpanDto` + optional `LiveSummaryEventDto.groundedness`. |
| `packages/applications/src/services/consultation/live-documentation/__tests__/live-documentation.groundedness.test.ts` (new) | 9 tests: disabled-default back-compat (no verdict, no call), marks-before-publish, URL/token/`{summary, transcript}` contract, payload-shape invariance, transient-blip retry, sustained-outage degrade (+ bounded attempts + PHI-safe logs), malformed/unknown-verdict fail-closed, `checked:false` distrust, stale-generation drop during the gate call. |
| `turbo.json` · `.env.example` · `apps/guardrail/.env.example` | Registered `GUARDRAIL_V2_GROUNDEDNESS_{ENABLED,MODEL_ID,ENTAILMENT_THRESHOLD,BATCH_SIZE,MAX_SEGMENTS}` + `LIVE_DOC_GROUNDEDNESS_{ENABLED,TIMEOUT_MS,MAX_RETRIES,RETRY_BACKOFF_MS}` with the fail-closed posture documented. |

No `apps/api` change was needed: the live-doc service calls the guardrail directly (the same posture as its SMR/NLP calls) and the SSE relay forwards the enriched payload verbatim; `pnpm build:api` re-verified.

### Acceptance criteria

- **AC-1 (NLI verifier — hermetic RED→GREEN)** — grounded vs hallucinated claim verdicts, deterministic, offline stub NLI; RED was `ImportError` (verifier absent), then 21 Python tests GREEN. ✓
- **AC-2 (throughput)** — asserted as a **batching property** (`ceil(N/batch_size)` scorer calls, each ≤ batch) + a reported `throughput_docs_per_min` field; the >500 docs/min **reference-host measurement is blocked on the un-staged model** (recorded in the staging ask). ◐
- **AC-3 (live-doc wiring — RED→GREEN)** — disabled default publishes **no** verdict (locked by test); enabled, the call runs between build and `safePublish` and the published SSE payload carries the flags; SMR/NLP timing + payload shape asserted unchanged. ✓
- **AC-4 (degrade-safe / fail-closed)** — transient blip absorbed (exactly 2 attempts, verdict from the clean re-check); sustained outage → `unverified` with the feed still publishing; asserted that **no** error/malformed/`checked:false` path yields `grounded` on either side of the wire. ✓
- **AC-5 (SSE contract — additive)** — optional `groundedness` field; per-segment verdicts + `flaggedSpans` with offsets indexing `runningSummary` (the entity-offset contract); full existing suite green (back-compatible). ✓
- **AC-6 (D2-owned metric)** — the precision/recall harness over a small synthetic (de-identified) labelled sample is locked by test (stub scorer: precision 1.0 / recall 1.0 — machinery proof, not a model claim); **real-model numbers blocked on staging**. TASK-470 is orthogonal and untouched: the gate is default-off and, when on, adds one bounded call downstream of the transcript — no ASR-path perturbation. ◐
- **AC-7 (combined posture)** — D1 (TASK-478): SMR **input** degrade-safe→fail-closed (a guardrail outage can never ship an unmoderated PHI prompt to the LLM). D2 (this ticket): live **output** NLI groundedness gate, degrade-safe→`unverified` (an ungrounded summary segment can never reach the clinician *marked as verified*, and an unavailable gate can never silently bless text). Together the live loop is closed at both ends. ✓
- **AC-gate** — see verification output below. ✓ (for everything built)

### RED → GREEN evidence

RED (before implementation):

```
# Python — both new test modules fail collection on the absent verifier:
E   ImportError: cannot import name 'GroundednessConfig' from 'guardrail.core.config' (…worktree…/apps/guardrail/src/guardrail/core/config.py)
ERROR apps/guardrail/src/guardrail/tests/test_groundedness_nli.py
ERROR apps/guardrail/src/guardrail/tests/test_groundedness_endpoint.py

# TS — 7 gate-behavior tests fail (no wiring), 2 back-compat locks pass:
Test Files  1 failed (1) · Tests  7 failed | 2 passed (9)
  e.g. AssertionError: expected undefined to be defined   (payload.groundedness)
       AssertionError: expected [ 'STALE first', 'FRESH second' ] to not include 'STALE first'
```

GREEN — verification gate (actual output):

```
PYTHONPATH=<worktree>/apps/guardrail/src pnpm py:guardrail:test
  → 75 passed in 3.44s            (54 existing + 21 new; cov via addopts)
pnpm py:guardrail:lint            → All checks passed!
pnpm py:guardrail:typecheck       → Success: no issues found in 26 source files

pnpm --filter @arcaai/applications test   → Test Files 274 passed | 1 skipped · Tests 5948 passed | 4 skipped
pnpm --filter @arcaai/applications build  → exit 0 (tsc)
pnpm --filter @arcaai/applications lint   → 0 errors; live-documentation folder warnings identical to baseline (6 = 6, all pre-existing prettier)
pnpm build:api                            → Tasks: 8 successful, 8 total
```

(Runner note, same as TASK-478: the shared `arcaenv` imports `guardrail` from the main checkout, so the guardrail gate must pin `PYTHONPATH=<worktree>/apps/guardrail/src` to run against the worktree source.)

### Deviations / notes

- **`main.py` touched (2 lines, forced)** — the manifest offered "new `groundedness.py`" but a new endpoints file must be registered; chose this over extending `guardrails.py` because that file is ALSO on the read-only list. Mirrors TASK-478's forced-`main.py` precedent; every other route is byte-identical.
- **Content-safety fold-in deferred** — the manifest marked folding `/guardrail/analyze` into the output pass as *optional*; it needs the live GLiNER/LLM providers (also model-dependent) and is additive later. The endpoint/DTO shapes accommodate it without breakage.
- **No speculative model code** — `load_default_scorer` raises with a precise staging message instead of shipping untested transformers inference in a clinical safety gate; the injectable-scorer seam is where the staged-model follow-up plugs in.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **D2** into an execution-ready ticket. Current state code-verified against `fix/2605-review` @ `87199e33`: the live summary is built (`live-documentation.service.ts:558-561`) and published over SSE (`:596-597`) with **nothing** between — no output moderation, no groundedness check (the SMR `system_prompt` "never fabricate findings" `:1010` is prompt-time, not verification); SMR moderates **input** only (TASK-478, `generate.py:170/193`); the at-par harness groundedness sensor (`sensors/inferential/groundedness.py:161-185`) is **LLM-JudgeClient** based and **durable-only** (too slow for the live cadence); the guardrail service (port 8863) already hosts `/guardrail/analyze` + `/medical/validate` behind `X-Service-Token` (the natural home for a self-hosted output-moderation + NLI-groundedness route); `LiveSummaryEventDto` (`live-summary.dto.ts:52`) has no grounded flag. D2 adds a **self-hosted MiniCheck-class NLI** groundedness gate + output moderation, wired inline before publish, **degrade-safe→`unverified`** (never silently grounded), completing TASK-478's fail-closed guardrail story on the output side; complementary to TASK-477 (which grounds entities). TASK-470's ASR scorecard is orthogonal (D2 is downstream of the transcript) so D2 carries its own groundedness-gate metric. No implementation; documentation only. |
| 2026-07-11 | **Implemented (status → Review).** Guardrail: `GroundednessConfig`, `groundedness_nli.py` verifier (deterministic, batched, fail-closed), `POST /guardrail/ground` behind `X-Service-Token`, forced 2-line `main.py` registration; 21 hermetic tests (stub NLI). Applications: `checkGroundedness` wired between `runningSummary` build and `safePublish` (bounded retry → `unverified`, strict mapper, stale-drop safe), additive `LiveSummaryEventDto.groundedness`, `SecretsService` token injection; 9 tests. Env knobs registered (`turbo.json`, root + app `.env.example`). Gates: guardrail 75 passed / ruff clean / mypy clean; applications 5948 passed / build green / no new lint warnings; `build:api` green. **BLOCKED remainder**: the live MiniCheck scorer + real-model AC-2/AC-6 numbers await staging of `lytang/MiniCheck-Flan-T5-Large` (~3.1 GB) into the offline HF cache — see §Implementation Summary. Not merged — orchestrator reviews. |
| 2026-07-11 | **Adversarially reviewed (APPROVE-WITH-FIXES) + merged.** Review CONFIRMED the two merge-gating properties: fail-closed is inviolable at the rollup level (three independent degrade layers — verifier `degrade`, endpoint 200-all-`unverified` backstop, TS catch→bounded-retry→`unverified`; `grounded` requires all-segments-literal-`grounded` AND `checked===true` AND ≥1 segment; NaN score → `UNGROUNDED`), and the live-doc publish path is NOT regressed (feed always publishes with `unverified` on outage/timeout/malformed; stale-drop + supersession-abort preserved; 65-test live-doc folder re-run green). **Applied IMPORTANT-1** (the one should-fix): the per-segment map now coerces ALL segment verdicts to `unverified` when `checked !== true` (previously only the rollup distrusted, so a compromised/buggy guardrail sending `checked:false` + `grounded` segments could show verified per-segment marks) + extended the `checked:false` test to assert `segments.every(v==='unverified')`. **Applied MINOR-2**: bounded `entailment_threshold` to `Field(0.5, ge=0, le=1)` so a fat-fingered value fails fast at startup rather than fail-open. Re-verified in the main tree: guardrail **75 passed** + ruff clean; applications **5968 passed**. **Deferred to the model-staging follow-up** (all Minor, none fail-open today — the model is unstaged so `verify()` never reaches them): MINOR-1 (widen `verify()` factory `except`→`Exception` + move verdict-mapping inside the scoring `try` — WILL be hit once the real MiniCheck loader lands), MINOR-3 (clamp wire offsets / drop NaN / render span text from `runningSummary` not `segment.text`), MINOR-4 (endpoint tests restore the `get_settings()` singleton in a fixture), MINOR-5 (consider a shorter timeout / `MAX_RETRIES=0` / breaker for the ≤~10.2s hanging-guardrail worst case before clinical enablement). Landing default-OFF + model-unstaged is safe — no configuration of this diff can produce `grounded` until a real scorer exists. Follow-up: stage `lytang/MiniCheck-Flan-T5-Large` (~3.1 GB), implement `load_default_scorer`, fold in MINOR-1/2-bounds before flipping `ENABLED`, capture AC-2 throughput + AC-6 precision/recall. Status → Review. |
| 2026-07-12 | **Live on-host calibration — encode→decode T5 wiring bug found by the gate, fixed, and validated (status stays Review).** Staged the `.gguf` and ran the fail-closed `verify_calibration()` through the real `LlamaCppMiniCheckScorer` path. It **caught a real defect** in the CALIBRATION-PENDING `_make_llama_logit_fn`: Flan-T5 is an **encoder-decoder**, but the read used the decode-only high-level `Llama.eval`, which aborts with `GGML_ASSERT(... llama_encode must be called first)` (SIGABRT) on a T5 graph — exactly the "UNVALIDATED, gated" wiring the calibration self-check exists to trap. **Fix**: drive the low-level path llama-cpp-python omits for encoder-decoder models — tokenize (`add_bos=False, special=True`; T5 has no BOS), `ctx.encode(enc_batch)` to populate cross-attention, `ctx.decode([decoder_start_token])` one step, read `ctx.get_logits()` at label ids 3/209; KV cleared per pair via `llama_memory_clear`. Model facts confirmed on this GGUF: `has_encoder=True`, `decoder_start_token=0`, `n_vocab=32128`, `bos=-1`, `n_ctx_train=512`. Also lowered `GroundednessConfig.n_ctx` 4096→**512** (matches Flan-T5 train ctx; silences the `n_ctx_seq > n_ctx_train` warning). **Result — validated on-host**: calibration PASSES (supported **0.9827**, unsupported **0.0063** — vs published 0.981/0.007, near-lossless under Q6), clinical probes strongly separated (0.92/0.81 support vs 0.014/0.005 contradict), and **AC-2 throughput MET** (**523 docs/min** on CPU, single-pair sequential, n_gpu=0 — above the >500 target). 34 hermetic tests still green (injected fake logit_fn, unaffected). The identical fix was applied to the TASK-481 harness entailer (its own copy of the same code/bug) and validated the same way. **Remaining (non-wiring)**: AC-6 real-model precision/recall over a labelled clinical corpus (none on-host), the long-transcript chunker (source truncates at n_ctx=512), and the 5 `turbo.json#globalEnv` entries. Not merged — orchestrator owns the merge. |
| 2026-07-11 | **MiniCheck GGUF scorer implemented (owner directive — "GGUF everywhere").** Pinned `nvhf/MiniCheck-Flan-T5-Large-Q6_K-GGUF` (file `minicheck-flan-t5-large-q6_k.gguf`; MiniCheck MIT / Flan-T5 Apache-2.0 — permissive, license gate waived). New `services/groundedness_scorer_minicheck.py` — `LlamaCppMiniCheckScorer` (template `'predict: '+doc+'</s>'+claim`; 2-way softmax over label tokens 3/209 → `P(yes)`; llama.cpp first-step logit read isolated in `_make_llama_logit_fn`, injectable). **Safety calibration gate**: `verify_calibration()` scores MiniCheck's published reference pair at load (supported ≥ 0.60, unsupported ≤ 0.40 — direction+margin, quant-tolerant) and raises `NliModelUnavailableError` (→ `unverified`) if the template/logit read is mis-wired or the quant too lossy, so a miscalibrated scorer **refuses to enable** rather than mis-passing clinical text. **Applied the deferred MINOR-1**: the verifier factory `except` now catches *any* construction/calibration error → fail-closed at the verifier level. Fail-closed + no-network loader (explicit local `model_path` required). `llama-cpp-python` declared as the optional `groundedness` extra in `apps/guardrail/pyproject.toml` (**`uv lock` deferred** — heavy build dep + concurrent-session lock contention; TASK-483 boto3 precedent). **Deferred** (concurrent TTS session owns the uncommitted `turbo.json`/`.env.example`): the 5 new `GUARDRAIL_V2_GROUNDEDNESS_{MODEL_FILE,MODEL_PATH,N_CTX,N_THREADS,N_GPU_LAYERS}` globalEnv entries — see the §Enablement checklist. 34 hermetic tests green (13 new), ruff + mypy clean; the pre-existing `config.py` pydantic `default_factory` mypy note is unchanged (present at HEAD, not this diff). Remaining: on-host live calibration + AC-2/AC-6 numbers + a long-transcript chunker. Status stays Review. |
