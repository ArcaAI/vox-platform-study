# TASK-479 — Live Output + Groundedness Moderation Gate (Theme D2 · SOTA S2-06/07)

- **Status**: Pending
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

**Read-only reference (do NOT modify)**: `apps/guardrail/src/guardrail/api/endpoints/medical.py` (`/medical/validate` — the input-side route TASK-478's SMR client calls; the `X-Service-Token` + shape reference), `apps/guardrail/src/guardrail/api/endpoints/guardrails.py` (`/guardrail/analyze` — the content-safety reference), `apps/harness/src/harness/sensors/inferential/groundedness.py` (the **durable** post-draft groundedness sensor — at-par, stays; D2 is its **live-surface** counterpart, NOT a change to it), `apps/smr/src/smr_v2/services/external_guardrail.py` (TASK-478's input path — the fail-closed posture to mirror on the output side).

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

**The SMR service moderates the input only** — `apps/smr/src/smr_v2/api/endpoints/generate.py` runs the TASK-478 input gate (`verdict.get("allowed", False)` fail-closed at `:170`/`:193`); there is **no** output-side moderation of the generated note.

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

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **D2** into an execution-ready ticket. Current state code-verified against `fix/2605-review` @ `87199e33`: the live summary is built (`live-documentation.service.ts:558-561`) and published over SSE (`:596-597`) with **nothing** between — no output moderation, no groundedness check (the SMR `system_prompt` "never fabricate findings" `:1010` is prompt-time, not verification); SMR moderates **input** only (TASK-478, `generate.py:170/193`); the at-par harness groundedness sensor (`sensors/inferential/groundedness.py:161-185`) is **LLM-JudgeClient** based and **durable-only** (too slow for the live cadence); the guardrail service (port 8863) already hosts `/guardrail/analyze` + `/medical/validate` behind `X-Service-Token` (the natural home for a self-hosted output-moderation + NLI-groundedness route); `LiveSummaryEventDto` (`live-summary.dto.ts:52`) has no grounded flag. D2 adds a **self-hosted MiniCheck-class NLI** groundedness gate + output moderation, wired inline before publish, **degrade-safe→`unverified`** (never silently grounded), completing TASK-478's fail-closed guardrail story on the output side; complementary to TASK-477 (which grounds entities). TASK-470's ASR scorecard is orthogonal (D2 is downstream of the transcript) so D2 carries its own groundedness-gate metric. No implementation; documentation only. |
