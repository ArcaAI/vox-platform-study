# SOTA Enhancement Track — Harness-Loop Modernization (strategic, post-remediation)

- **Status**: Pending (planning track — no ticket executed here; each theme spawns its own `TASK-XXX` when scheduled)
- **Type**: infrastructure (program planning) — child tickets are `feature` / `refactor`
- **Program**: [TASK-449 — Harness-Loop Remediation Program](../TASK-449-Harness-Loop-Remediation-Program/README.md) · the strategic track that follows Wave 3
- **Source**: the SOTA research + gap analysis in [TASK-448 §SOTA Research & Gap Analysis](../TASK-448-Harness-Loop-Quality-Review/README.md#sota-research--gap-analysis) (S1 streaming ASR · S2 clinical NER/guardrails · S3 summarization/orchestration/eval — every claim carries a dated 2024–2026 citation there)
- **Owner surfaces**: planning only — this doc owns NO source files. Every code change belongs to a child ticket with its own exclusive file-ownership manifest.

## Framing

The remediation waves (TASK-450…469) fix the **seams and edges** — the defects. This track closes the **capability gaps** where TASK-448 judged HOPE "behind" or "significantly behind" the 2024–2026 field:

| Capability (TASK-448 one-line gap summary) | Verdict | Theme |
|---|---|---|
| Streaming ASR commit latency (2023 LocalAgreement-2; ~5–7× slower) | significantly behind | **A** |
| Semantic endpointing / streaming diarization | behind (absent) | **A3 · B** |
| Clinical NER + ontology linking (generic models, no linker) | significantly behind | **C** |
| Live-surface output/groundedness guardrails | behind (absent) | **D** |
| Guardrail fail-posture (fail-open) | behind | **D1** |
| Harness eval (already ahead: PDSQI-9 + calibration + judge-parity) | ahead of most — deepen | **E3** |
| Draft-then-finalize dual-tier (at-par; unify lineage) | at-par — unify | **E1** |
| Temporal versioning / replay safety (at-par; add claim-check) | at-par — harden | **E4** |
| (no streaming eval harness to measure any of the above) | missing | **F — the gate** |

**Governing principle — measure first.** The single biggest realtime lever is the ASR commit policy, and the consumer-groups migration was deliberately gated on the eval harness (TASK-455). Every ASR/NER quality change in this track is likewise **measurement-gated**: Theme **F** (the streaming quality eval) lands FIRST and defines the acceptance numbers, exactly as TASK-455 gated TASK-457. No latency/quality claim ships as an assertion.

**Hard guardrails for every child ticket** (from the review's clinical-safety posture):
- **Self-hosted models only — no cloud PHI.** The ASR/NER/NLI candidates below (Kyutai STT, Parakeet-TDT, Clinical ModernBERT, MedCAT, MiniCheck-class NLI) were chosen because they run on-prem; do not introduce a cloud ASR/LLM vendor that receives clinical audio/text.
- **The durable HARNESS stays the clinical authority.** Live-surface upgrades (A/B/C2/D) improve the ephemeral clinician-facing loop; they must not silently become the system of record (TASK-449 §Architecture preamble).
- **Dynamic-by-default admin console** and **replay-safe Temporal** disciplines continue to apply.

## Candidate ticket allocation (suggested next-free numbers — confirm at open time per CLAUDE.md ticket workflow)

TASK-469 (SMR idempotency) is the last allocated number; the highest existing ticket doc is TASK-468. These are **suggested** 470+ allocations:

**Scaffold status**: the near-term actionable tranche (F gate + A1 quick win + D1 safety win) plus **Theme C (clinical NER — C1/C2)** are **detail-scaffolded** into execution-ready ticket READMEs; the XL/gated/months-out research tickets stay at plan level here until scheduled (over-scaffolding speculative research is premature).

| # | Theme | Candidate ticket | Size | Value | Risk | Depends on | Scaffold |
|---|---|---|---|---|---|---|---|
| **TASK-470** | F | Streaming quality eval-harness extension | M | High (unblocks all of A/C) | Low | TASK-455 (extends it) | [detail-scaffolded](../TASK-470-Streaming-Quality-Eval-Harness/README.md) |
| **TASK-471** | A1 | Tentative-tail render (drop 1 s partial cadence) | S | High (free latency win) | Low | TASK-470 | [detail-scaffolded](../TASK-471-Tentative-Tail-Render/README.md) |
| **TASK-472** | A2 | Streaming-native transducer pilot (Kyutai / Parakeet-TDT) | XL | Very high (5–8× stable latency) | High | TASK-470, TASK-471 | plan-level |
| **TASK-473** | A3 | Semantic endpointing (replace fixed Silero offset) | M | Med–High | Med | TASK-470 | plan-level |
| **TASK-474** | B1 | Diarization internals review (`stt_v2/diarization/*`) | S | Med (unassessed-risk closure) | Low | — | plan-level |
| **TASK-475** | B2 | 2-speaker clinician/patient (Streaming Sortformer) | L | High (capability absent today) | Med–High | TASK-470, TASK-474 | plan-level |
| **TASK-476** | C1 | Server-side clinical encoder + ontology linker (**writes `NamedEntity` codes**) | L | Very high (real close of C5-03) | Med | TASK-470 | [detail-scaffolded](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md) |
| **TASK-477** | C2 | Re-point live NER at the transcript + source-grounding | M | High (stops hallucination-laundering) | Med | TASK-476 (shared NER path) | [detail-scaffolded](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md) |
| **TASK-478** | D1 | SMR input fail-open → fail-closed | S | High (PHI safety) | Med (outage behavior) | — | [detail-scaffolded](../TASK-478-SMR-Input-Fail-Closed/README.md) |
| **TASK-479** | D2 | Live output + groundedness moderation gate (MiniCheck-class) | L | High | Med | TASK-478 | plan-level |
| **TASK-480** | E1 | Harness warm-start from live note + reuse `NamedEntity` priors | L | High (kills cold-regen redundancy) | Med | **TASK-476** (codes must be populated) | plan-level |
| **TASK-481** | E2 | Reference-free atomic-fact verifier + optimistic-delivery retraction contract | M | High (safety gate) | Med | — | plan-level |
| **TASK-482** | E3 | MEDCON concept-F1 + harm-weighted error rate + clinician edit-burden telemetry | M | High (the real quality proxy) | Low | TASK-476 (concept-F1 needs codes) | plan-level |
| **TASK-483** | E4 | Claim-check payloads for the Temporal history budget | M | Med (scale hardening) | Low | — | plan-level |

## Theme F — Streaming quality eval harness (the measurement gate — FIRST)

**TASK-470 · size M · value High · risk Low.** [TASK-455](../TASK-455-Streaming-E2E-Eval-Harness/README.md) already built the streaming e2e + **loss/latency** eval harness (captured the plain-XREAD baseline: gap_count 0, coverage 0.996). This theme **extends** it with the *quality* metrics the ASR/NER work needs to be judged against: **medical WER** (and clinical keyterm/keyphrase recall), **partial-revision rate** (how often a "stable" word later changes), and **commit-latency P50/P99** (audio→visible-stable-word). Output is a repeatable scorecard + regression thresholds. **Dependency**: extends TASK-455's harness (do not fork it). **Why first**: it is the acceptance gate for A1/A2/A3 and the scorer for C — none of those ship without a before/after number from this harness, mirroring how TASK-455 gated the TASK-457 consumer-groups migration.

## Theme A — Streaming ASR modernization

**TASK-471 · A1 tentative-tail render · size S · value High · risk Low.** LocalAgreement-2 is a correct 2023 baseline but commits ~1–2 s behind and renders partials only every 1.0 s over an 8 s tail. The quick win: drop the 1 s partial cadence and render a **tentative (visually-distinct, non-committed) tail** so the clinician sees words forming in near-real-time while the commit policy stays conservative. No model change; pure render/emit policy. **Gate**: TASK-470 shows the partial-latency improvement without a partial-revision-rate regression.

**TASK-472 · A2 streaming-native transducer pilot · size XL · value Very high · risk High.** Pilot a self-hostable streaming-native transducer to replace faster-whisper's chunked commit — **Kyutai STT** (open-weights, ~500 ms) or **NVIDIA Parakeet-TDT** (via Riva/NeMo) — for a ~5–8× stable-latency cut **without shipping PHI to a cloud vendor**. This is a pilot/spike → phased adoption behind a flag, scored on TASK-470's medical-WER + commit-latency. **Risk**: GPU footprint, model-ops, accuracy parity on clinical audio; it touches the hot inference path. **Depends on** TASK-470 (scoring) + TASK-471 (render policy in place).

**TASK-473 · A3 semantic endpointing · size M · value Med–High · risk Med.** Replace the fixed Silero VAD silence offset with **semantic endpointing** (turn/utterance boundary from content, ~160–500 ms targets) so finals cut at meaning, not a fixed silence timer — improving both latency and the tail-utterance capture that C2-05 hardened defensively. **Depends on** TASK-470; independent of A2 (can run on either ASR backend).

## Theme B — Streaming diarization

**TASK-474 · B1 diarization internals review · size S · value Med · risk Low.** TASK-448's risk register explicitly flagged `stt_v2/diarization/*` + `inference.py` as **outside the reviewed file set → speaker-attribution correctness unassessed**, and the live loop currently attaches **no** speaker labels. This is the scoped follow-up review (mirrors the TASK-448 method) that closes that unassessed-risk item and produces the brief for B2. **No dependency** — can run any time.

**TASK-475 · B2 2-speaker clinician/patient · size L · value High · risk Med–High.** Add streaming 2-speaker diarization (**Streaming Sortformer**) emitting clinician/patient labels on the live transcript — a capability every comparable ambient scribe has and HOPE lacks. Feeds both the live note and the NER/summary lineage. **Depends on** TASK-474 (informed by the internals review) + TASK-470 (scoring); touches the hot path, so measurement-gated.

## Theme C — Clinical NER + ontology linking

**TASK-476 · C1 server-side clinical encoder + linker · size L · value Very high · risk Med.** Replace the generic browser/`classify-tokens` NER with a **server-side clinical encoder** (Clinical/BioClinical ModernBERT or GatorTron) + a **MedCAT / Spark-NLP linker** that **populates the `NamedEntity` ontology columns** (umls/snomed/rxnorm/icd/loinc). **This is the real close of C5-03** — TASK-462 only annotated the columns + added a groundedness guard; this ticket makes the NLP service the authoritative producer of coded entities, demoting browser NER to a display hint. **Depends on** TASK-470 (score entity F1). Unblocks E1/E3 (which consume the codes).

**TASK-477 · C2 re-point live NER at the transcript + source-grounding · size M · value High · risk Med.** Today live NER runs over the **generated SOAP note**, laundering summary hallucinations (~40–50% base rate) into first-class clinical entities (S2-04). Re-point the live NER at the **raw transcript delta** and ground note-level entities back to source spans. **Depends on** TASK-476 (shares the clinical NER path; do them adjacent to avoid a double rewrite of the NER wiring).

## Theme D — Live-surface guardrails

**TASK-478 · D1 SMR input fail-open → fail-closed · size S · value High · risk Med.** SMR input validation defaults **fail-open** — an outage ships unmoderated PHI prompts. Flip to fail-closed / degraded-safe for PHI-bearing prompts. **Risk**: changes outage behavior (must not brick generation on a transient guardrail blip — degrade-safe, not hard-fail). Pairs with the fail-closed service-token posture ([TASK-465](../TASK-465-NLP-Guardrail-Service-Token-Enforcement/README.md)).

**TASK-479 · D2 live output + groundedness moderation gate · size L · value High · risk Med.** The live summary reaches the clinician with **no** output-side or groundedness check. Add a streaming/sentence-level output moderation + an **NLI groundedness gate** (MiniCheck-class, >500 docs/min) so ungrounded segments are marked before the clinician reads them. **Depends on** TASK-478 (completes the fail-closed guardrail story); the harness post-draft Granite Guardian sensor stays (it is at-par) — this fills the **live-surface** gap only.

## Theme E — Harness lineage unification + eval depth

**TASK-480 · E1 warm-start from the live note + reuse NER priors · size L · value High · risk Med.** The dual-path architecture is SOTA-aligned but **partly redundant** — the harness regenerates cold, discarding the live-doc's incremental note. Warm-start the harness from the live-doc's **last incremental note** (two-stage scratchpad→final) and reuse persisted `NamedEntity` rows as **NER priors** instead of re-extracting. **Depends on TASK-476** (the priors are only worth reusing once the codes are actually populated) → **E1 lands after C**.

**TASK-481 · E2 reference-free atomic-fact verifier + retraction contract · size M · value High · risk Med.** The verify-then-deliver loop is genuinely SOTA-aligned (mirrors AgenticSum/SCRPO/VTG); harden it with a **reference-free atomic-fact verifier** (MiniCheck/AlignScore-class, deterministic gate) and an explicit **optimistic-delivery retraction contract** so a provisionally-delivered draft that later fails assurance is cleanly retracted (the C1-01 window is accepted-as-is per TASK-453, so an explicit retraction contract is the safety net). Independent.

**TASK-482 · E3 MEDCON concept-F1 + harm-weighted error rate + edit-burden telemetry · size M · value High · risk Low.** Deepen the already-strong harness eval: add **MEDCON / UMLS concept-F1** (deterministic, over the persisted `NamedEntity` codes — an omission catcher), a **clinical-significance-weighted error rate** (the npj finding: a 1.47% hallucination rate hides 44% *major* errors — raw rate isn't the safety metric), and **clinician edit-distance / deferral / time-to-sign** telemetry (the top real-world quality proxy; the gate already emits approve/edit signals into the WORM audit — wire them). **Concept-F1 depends on TASK-476** (needs populated codes); the edit-burden + harm-weight parts are independent.

**TASK-483 · E4 claim-check payloads · size M · value Med · risk Low.** Protect the Temporal 50 MB history-size budget by passing **MinIO/S3 refs (claim-check pattern)** instead of inline transcript/RAG/note blobs. Note: `continue_as_new` is explicitly **not** needed (~7 years to the event cap) and the **terminal-abandon** timer already landed in [TASK-458](../TASK-458-Harness-Idempotency-Escalation/README.md) (C1-02); this ticket is the remaining size-budget hardening only. Independent.

## Sequencing

```
Wave 3 close-out (TASK-461, TASK-462, TASK-469 merged)
        │
        ▼
  Theme F  ── TASK-470 (streaming quality eval harness)          [the gate — first]
        │
        ├─────────────┬───────────────┬──────────────────┐
        ▼             ▼               ▼                  ▼
   A1 TASK-471    C1 TASK-476     D1 TASK-478        B1 TASK-474
 (quick win)    (clinical NER    (fail-closed)     (diar review —
        │        + linker)            │             no gate needed)
        │             │               ▼                  │
        ▼             ▼          D2 TASK-479              ▼
  A2 TASK-472    C2 TASK-477                         B2 TASK-475
  A3 TASK-473   (adjacent to C1)                   (gated on F + B1)
 (gated on F,
  + A1 render)
        │             │
        └──────┬──────┘
               ▼
   Theme E (harness depth) — E1 TASK-480 AFTER C lands (needs populated codes);
   E2 TASK-481 / E3 TASK-482 (concept-F1 part after C) / E4 TASK-483 parallelize
```

Plain-English order: **close Wave 3 → Theme F (measurement gate) → parallel A1 / C / D (and B1 anytime) → gated A2·A3 and B2 → Theme E, with E1 after C lands.** Rationale: F defines the numbers everything else is judged on; A1/C/D are independent, high-value, and can run concurrently on disjoint surfaces (ASR render policy · NLP service · guardrail); the heavy ASR pilot (A2) and diarization (B2) are gated on measured baselines; E depends on C because warm-start priors and concept-F1 are only meaningful once `NamedEntity` codes are actually populated.

## Non-goals (track-level)

- Cloud ASR/LLM/NLI vendors that receive clinical audio or text (self-hosted only).
- `continue_as_new` for the harness workflow (explicitly not needed — S3).
- Turning any live-surface upgrade into the system of record (the durable harness stays authoritative).
- Executing anything here — each theme opens its own ticket with a code-verified Current State Evaluation and an exclusive file-ownership manifest before implementation, per the orchestration contract.

## Change History

| Date | Change |
|---|---|
| 2026-07-10 | Track scaffolded from TASK-448 §SOTA Research & Gap Analysis (S1/S2/S3). Six themes (F/A/B/C/D/E) mapped to 14 candidate tickets with suggested numbers TASK-470…483, per-theme scope/size/value/risk/deps, and a measurement-first sequencing (F gates A/C; E1 after C). No implementation; numbers are suggestions to confirm at open time. |
| 2026-07-10 | Detail-scaffolded the near-term actionable tranche into execution-ready ticket READMEs — **[TASK-470](../TASK-470-Streaming-Quality-Eval-Harness/README.md)** (F, the measurement gate — full scaffold: medical-WER + keyterm/keyphrase recall + partial-revision + commit-latency P50/P99 scorecard, extending TASK-455's loss harness with pass/fail thresholds), **[TASK-471](../TASK-471-Tentative-Tail-Render/README.md)** (A1 quick win — configurable/lowered partial cadence + LA-2-on to activate the already-built tentative render; gated on TASK-470), **[TASK-478](../TASK-478-SMR-Input-Fail-Closed/README.md)** (D1 — remove the SMR guardrail fail-open branch, degrade-safe→fail-closed, close the default-allow bypasses; pairs with TASK-465). Candidate table marks these three `detail-scaffolded`; the XL/gated/months-out research tickets (A2/A3, B, C, D2, E*) stay `plan-level` deliberately. Current state for each was code-verified against `fix/2605-review` @ 87b33f57. Documentation only — no code changed. |
| 2026-07-10 | Detail-scaffolded **Theme C (Clinical NER + Ontology Linking)** into execution-ready READMEs — **[TASK-476](../TASK-476-Clinical-Encoder-Ontology-Linker/README.md)** (C1, size L — server-side clinical encoder + MedCAT/Spark-NLP linker that **populates the `NamedEntity` ontology columns**; the real close of C5-03, superseding TASK-462's interim guard/annotation; makes the NLP service the authoritative producer of coded entities and demotes browser NER to a display hint) and **[TASK-477](../TASK-477-Live-NER-Transcript-Repoint-Grounding/README.md)** (C2, size M — re-point the live-documentation NER off the generated SOAP note onto the raw transcript delta + source-ground note entities, stopping S2-04 hallucination-laundering; shares C1's NER path, land adjacent). Both gated on TASK-470 (measure-first). Current state code-verified against `fix/2605-review` @ 59827bb5: the NLP producer emits entity types but no ontology codes and has no linker; all three durable `NamedEntity` writers persist `null` codes; the three read sites run on empty codes; live NER runs over the generated note (`live-documentation.service.ts:577`), not the transcript. Candidate table marks C1/C2 `detail-scaffolded`; the remaining plan-level tickets (A2/A3, B, D2, E*) stay deliberately un-scaffolded. Documentation only — no code changed. |
