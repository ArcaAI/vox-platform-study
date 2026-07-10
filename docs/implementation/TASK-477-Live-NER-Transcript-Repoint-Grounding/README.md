# TASK-477 — Live NER Transcript Re-point + Source-Grounding (Theme C2 · SOTA S2-04)

- **Status**: Pending
- **Type**: bugfix / refactor (correctness + patient-safety on the live surface) — stops the live loop laundering summary hallucinations into first-class clinical entities
- **Track**: [SOTA Enhancement Track](../SOTA-Track/README.md) · Theme **C2** (re-point live NER at the transcript + source-grounding)
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · strategic SOTA track (post-Wave-3)
- **Source finding**: [TASK-448](../TASK-448-Harness-Loop-Quality-Review/README.md) §SOTA **S2** row 3 / **S2-04** (NER over the generated SOAP note laundering ~40–50% summary hallucination into clinical entities) + per-subsystem **C** ("it extracts over the generated note not the transcript")
- **Theme**: C2 · **Size**: M · **Value**: High (stops hallucination-laundering) · **Risk**: Med
- **Depends on**: [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) (C1 — **shares the clinical NER path**; do them **adjacent** to avoid a double rewrite of the NER wiring) · [TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md) (measure-first — scored on its keyterm/keyphrase recall)
- **Suggested agent**: general-purpose (TS `packages/applications` live-documentation + the shared clinical NER path; a correctness/patient-safety lens)
- **Hard guardrail (track-level)**: the **durable HARNESS stays the clinical authority.** This upgrades the ephemeral clinician-facing live surface only — it must NOT become the system of record (live entities stay ephemeral UX; the signed artifact is the harness-gated draft).

## File-ownership manifest (exclusive — binding)

| File | Change |
|---|---|
| `packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts` | Re-point the entity-extraction call from the generated note (`runningSummary`) to the **raw transcript delta** (`:577`); add a **source-grounding** step so entities surfaced against the note carry a transcript span and note-only (unsupported) mentions are flagged/dropped; keep the SSE payload shape and highlight-offset consistency. |
| `packages/applications/src/services/consultation/live-documentation/dto/live-summary.dto.ts` | Only if a grounding field (source span / grounded flag) must ride the SSE `LiveSummaryEventDto` for the panel to render highlights against the right surface. |
| `packages/applications/src/services/consultation/live-documentation/__tests__/**` | RED-first: assert current code runs NER over `runningSummary` (the note) → change to the transcript delta; assert note-only entities with no transcript support are flagged/dropped; assert highlight offsets index the rendered surface. |

**STOP-and-report before touching**: the **server-side clinical encoder + linker + `NamedEntity` code population** (that is [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md)/C1 — this ticket **consumes** the shared NER path, it does not build it), the **browser** NER (`KnowledgePipeline.ts` already reads the transcript — see below), any **`NamedEntity` persistence** (live entities stay ephemeral — do not add DB writes here), the live-doc **owner lock / truncation / debounce** logic (unrelated findings C5-04/C5-06), or the **SMR prompt** assembly (`buildSmrUserPrompt` — the summary still generates from the transcript delta as today). Anything outside the manifest → STOP.

## Requirement Analysis

Re-point the live-surface NER from the **generated SOAP note** to the **raw transcript delta**, and **ground** note-level entities back to source transcript spans — so a summary hallucination can no longer be promoted into a first-class, clinician-facing clinical entity.

### The verified gap (S2-04)

In the realtime loop, the live-documentation service generates a running SOAP note from SMR, then runs NLP NER **over that generated note** and publishes the entities to the clinician's live panel over SSE. Because the LLM summary carries a material hallucination base rate (~40–50%, S2-04), any invented finding/medication/dose in the note becomes a **highlighted clinical entity** the clinician sees as extracted fact — the live loop **launders** summary hallucinations into entities. The correct SOTA pattern (extract-from-source + entity-ground, SPEER) is to run NER on the **source transcript** and ground note-level mentions to the exact transcript spans that support them; anything with no transcript support is not surfaced as an entity.

This is a **live-surface** correctness/safety fix. It does not change the durable authority (the harness already extracts entities over the transcript, `activities.py:229`), and it does not persist anything — live entities remain ephemeral UX per the TASK-449 architecture posture. It shares the clinical NER path with TASK-476 (the server NLP classify/tokens the live loop calls), so it lands **adjacent** to C1 to avoid rewriting the `callNlp` wiring twice.

### Acceptance criteria

- [ ] **AC-1 (re-point, RED first)** — a test asserts the current code passes the **generated note** (`runningSummary`) to the NER call; then the extraction is re-pointed to the **raw transcript delta** (the same text that feeds SMR). RED proves the note-source today.
- [ ] **AC-2 (source-grounding)** — note-level entities carry a **source transcript span**; an entity present in the note but with **no supporting transcript span** is flagged/omitted (not surfaced as an extracted clinical entity). A test drives a hallucinated note token absent from the transcript and asserts it is not published as a grounded entity.
- [ ] **AC-3 (highlight-offset consistency)** — the entity offsets in the SSE payload index the surface the panel actually highlights (transcript vs note), with the offset contract documented; no offset points into a different string than the one rendered (today `start`/`end` index into `runningSummary`, per `:545-546`).
- [ ] **AC-4 (ephemeral posture preserved)** — no `NamedEntity` rows are written by the live path (it still publishes over SSE + caches `session.lastPayload`; the durable snapshot still persists only `runningSummary` as a `PRE_SUMMARY` ContextItem). The harness remains the coded-entity authority.
- [ ] **AC-5 (scored on TASK-470)** — re-run TASK-470's scorecard; **keyterm/keyphrase recall** must not regress (the source re-point must not drop real clinical terms), ASR guardrails hold. Record in §Implementation Summary.
- [ ] **AC-6 (gates)** — `pnpm --filter @arcaai/applications build test lint` green; both themes' behavior unaffected elsewhere. Output pasted.

### Non-goals

- **The server-side clinical encoder + ontology linker + `NamedEntity` code population** — [TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) (C1). This ticket re-points and grounds the **live** NER; C1 owns the coded durable producer.
- **Persisting live entities as `NamedEntity`** — they stay ephemeral UX (durable harness authority is unchanged).
- **Live output / groundedness moderation gate (MiniCheck-class NLI over the summary text)** — [TASK-479](../SOTA-Track/README.md) (D2). This ticket fixes **NER source correctness** (entities from the transcript, grounded), not summary-output moderation — the two are complementary live-surface safety layers.
- **Browser NER changes** — it already runs over the transcript (`KnowledgePipeline.ts:276`); untouched here.
- **The live-doc owner-lock / delta-truncation / debounce findings** (C5-06 / C5-04) and the SMR prompt path — out of scope.

## Current State Evaluation (code-verified 2026-07-10 against `fix/2605-review` @ `59827bb5`)

**Live NER runs over the generated note, not the transcript** — the anomaly, verified end to end in `live-documentation.service.ts`:
- `:543` — `const promptText = this.buildSmrUserPrompt(priorNote, delta || transcript, notes);` — the **transcript delta** feeds SMR (summary generation).
- `:555-561` — SMR returns text → `parseSoapJson`/`parseSoapSections` → `runningSummary = buildRunningSummary(parsed)` — i.e. `runningSummary` **is the generated SOAP note**.
- `:577` — `entities = runningSummary ? await this.callNlp(runningSummary, signal) : [];` — **NER runs over the generated note**, not the transcript. The load-bearing comment at `:545-546` confirms the design ("SMR first … then NER over the resulting `runningSummary`").
- `callNlp` (`:1025-1045`) posts `{ text: runningSummary }` to `/api/v1/classify/tokens` and reads the correct contract (`entity_type`/`text`/`position`, C5-01 already fixed); the returned entity `start`/`end` therefore **index into the note**.

**The live entities are ephemeral (no durable write)** — published into `LiveSummaryEventDto` (`:591`), cached to `session.lastPayload` (`:596`) and `safePublish` → Redis pub/sub → SSE (`:597`); the durable snapshot (`persistDurableSnapshot`) writes **only** `runningSummary` as a `PRE_SUMMARY` ContextItem — **entities are never persisted as `NamedEntity`.** So this fix is contained to the live surface.

**The grounding target already exists** — `NamedEntity` carries `transcriptContextItemId`/`transcriptStartOffset`/`transcriptEndOffset` (`consultation.prisma:332-335`) and the harness path already sets them from transcript offsets (`api_client._entity_payload` comment "NLP ran on the transcript"). The live re-point aligns the live surface with the durable path's already-transcript-sourced posture.

**Browser NER is already transcript-sourced** (not the bug) — `useArcaAudio.ts:185-194` auto-triggers on final transcriptions → `KnowledgePipeline.ts:276` `executeNER(input.text)` over the transcript text; dedup is a stable content hash (`stableEntityId`, `:475` — C5-05 already fixed). So the **server live-documentation NER is the sole note-sourced path** this ticket corrects.

**Shared-path coupling with TASK-476** — the live loop's `callNlp` hits the same `/classify/tokens` endpoint that TASK-476 upgrades (clinical encoder + linker). Re-pointing the source here and upgrading the producer there both touch the live NER wiring; doing them **adjacent** avoids rewriting the extraction call twice.

## Implementation Plan (TDD — strict order)

> Context pack for the implementing agent: this README · TASK-448 §SOTA S2 (extract-from-source + entity-ground / SPEER; the ~40–50% hallucination base rate) · TASK-449 §Architecture preamble (live surface is best-effort/ephemeral; harness is authoritative) · TASK-476 (the shared clinical NER path — coordinate/land adjacent) · `.claude/rules/04-application-services.md` (live-documentation service, DTOs, SSE) · TASK-470 (the scorecard to re-run).

1. **RED — prove the note source** — a unit test on the live-documentation extraction step asserts the NER call receives `runningSummary` (the generated note) on current code.
2. **GREEN — re-point to the transcript delta** — pass the raw transcript delta (the same `delta || transcript` that feeds SMR) into the NER call instead of `runningSummary`.
3. **Ground note→source** — add the grounding step: for each entity, attach the supporting transcript span; drop/flag note-only mentions with no transcript support (a hallucinated note token absent from the transcript must not surface as a grounded entity). Decide + document the highlight-offset contract (which surface the panel renders against) so offsets never index the wrong string.
4. **Preserve ephemeral posture** — assert no `NamedEntity` write is introduced; the SSE DTO shape and durable-snapshot (`PRE_SUMMARY` only) behavior are unchanged apart from any additive grounding field.
5. **Score + gate** — re-run TASK-470's scorecard; record keyterm/keyphrase recall (no regression) in §Implementation Summary.

### Verification gate (paste output into §Implementation Summary)

```bash
pnpm --filter @arcaai/applications build test lint
# score (measure-first) — same fixtures/pipeline as TASK-470
pnpm py:stt-v2:test:integration   # test_streaming_quality_scorecard
```

Adversarial review focus: (a) is NER genuinely re-pointed to the **transcript delta** (not still the note) — proven by a RED that failed on the old source? (b) are note-only/unsupported entities actually flagged/dropped (no hallucination-laundering), and are real transcript-supported entities retained (no recall loss)? (c) do highlight offsets index the surface the panel renders — no cross-string offset bug? (d) is the ephemeral posture intact (zero new `NamedEntity` writes, durable authority unchanged)? (e) keyterm/keyphrase recall held vs TASK-470? (f) coordinated with TASK-476 on the shared NER wiring — no double rewrite; zero diff outside the manifest.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Detail-scaffolded from [SOTA-Track](../SOTA-Track/README.md) Theme **C2** into an execution-ready ticket. Current state code-verified against `fix/2605-review` @ `59827bb5`: live NER runs over the **generated SOAP note** — `live-documentation.service.ts:577` calls `callNlp(runningSummary)` where `runningSummary` is the SMR-generated note (`:555-561`), while the transcript delta only feeds the SMR prompt (`:543`); entity offsets index the note (`:545-546`); live entities are SSE/Redis + in-memory only and are **not** persisted as `NamedEntity` (durable snapshot persists only `runningSummary` as `PRE_SUMMARY`). The `NamedEntity` transcript-span grounding columns already exist (`consultation.prisma:332-335`); the browser NER already reads the transcript (`KnowledgePipeline.ts:276`, C5-05 fixed) so the server live-doc path is the sole note-sourced NER. Re-point at the raw transcript delta + ground note entities to source spans (SPEER); shares the clinical NER path with TASK-476 (land adjacent). No implementation; documentation only. |
