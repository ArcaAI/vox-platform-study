# TASK-829 — Realtime consultation guardrail plane

| | |
|---|---|
| **Status** | In Progress — Phase 1 decision plane merged; wiring outstanding |
| **Type** | feature |
| **Branch** | `dev-2.2` |
| **Spans** | `apps/stt` · `apps/guardrail` · `apps/harness` · `apps/nlp` · `apps/text` · `apps/admin-console` |
| **Related** | **TASK-818 §3B** (guardrail policy, tiering, fail posture, caching) — this is its realtime-consultation instance |

## 1. Requirement Analysis

**Owner statement (2026-08-29), confirmed.** In a realtime consultation: pre-summarization validates
both the agent instructions and the context content; summarization is incremental, managed by the
agentic loop, so the check is on the **partial transcript**; grammar/spelling consume the same
partial transcript. **Generalised: a partial transcript is validated once before any downstream task
uses it** — partial summarization, NER, grammar/spelling, and future tasks. **If content is marked
harmful, an alert is fired to the end user.**

**Owner-confirmed rulings:** two verdict axes not one; fail-closed gates AI derivations and never
the clinical record; validation at the producer boundary with consumers reading the verdict;
verdict validity asserted against the window the consumer will actually feed the model.

## 2. ⚠️ Research verdict: the design is sound ONLY under five conditions

**Qualified yes.** Validate-once-then-fan-out is a legitimate boundary pattern, but as first drafted
it inherits the *weak* form — "classify once, declare clean" — which 2026 research shows is
bypassable **82–100% against exactly this streaming-segment shape**.

| # | Condition | Consequence if dropped |
|---|---|---|
| C-1 | **Three verdict axes, not one** (§3) — a cacheable task-agnostic *content-harm* verdict, a *non-cacheable* injection-risk verdict scoped to (assembly × capability), and a *clinical* signal that never gates | Verdict reuse across differing assemblies is unsound |
| C-2 | **The validated unit at a consumption point is the CUMULATIVE transcript, never the isolated delta** | **Unsafe — do not ship.** This is the Prompt Overflow vulnerability |
| C-3 | **No downstream consumer holds a capability the validation policy did not model.** Today's four tasks are read-only text→text. The moment one calls a tool, retrieves, or writes to a chart, its verdict is **recomputed, not inherited** | Silent privilege escalation through an inherited verdict |
| C-4 | **Output-side checks are mandatory and independent of the input verdict** (§7) | Input validation covers **zero** output risk |
| C-5 | **Fail-closed applies to downstream USE, never to capture or clinician display** (§6) | A guardrail that blanks a live transcript is itself a patient-safety event |

Under these, the design is **materially better** than per-task validation, which costs N× and
produces N inconsistent verdicts on the same text.

### 2.1 The two numbers that drive everything

**Split payloads defeat per-segment guardrails almost completely.** *Prompt Overflow*
(arXiv:2605.23196, 2026-05-22) describes the exact mechanism — the guard scores fixed windows
independently while the LLM reconstructs intent across the whole thing. Bypass rates with malicious
tokens separated by natural prose: **Prompt Guard 2 86M — 100%. Granite Guardian HAP-125M — 100%.
Prompt Guard 2 22M — 82–100%. DeBERTa-v3 injection detector — 92.3%.** Detector confidence collapses
0.99 → 0.03 as malicious density per window falls.

**A general harm taxonomy is disqualifying on clinical text.** At 90% recall, false positives on
**safe** clinical turns: **Llama Guard 3 1B — 71.3%.** gpt-oss-safeguard 120B — 8.4%. MindGuard 8B
(clinical, clinician-annotated) — **3.1%**. A general classifier flags roughly three-quarters of
safe clinical conversation.

### 2.2 ⚠️ Correction: overlap is NOT the fix for split injection

An earlier draft of this ticket recommended a trailing overlap window as the boundary mitigation.
**That was wrong.** Prompt Overflow tested overlapping sliding-window inspection directly and found
**only marginal improvement**: overlap addresses *contiguous* evidence straddling a boundary and
does nothing about *dispersed* evidence, which is the actual attack.

Keep a modest overlap for contiguity — but **do not present it as the split-injection defence.** The
defence is §5.

## 3. The verdict artifact — three axes, two cache scopes

```jsonc
TranscriptSegmentVerdict {
  "segmentId": "uuid7", "contentHash": "sha256:…",
  "policyVersion": 7, "taxonomyVersion": "clinical-v3",
  "thresholdSet": "default", "tenantId": "uuid",

  // AXIS 1 — property of the TEXT. Task-agnostic. Cacheable, fan-out safe.
  "contentHarm": { "categories": [], "confidence": 0.0,
                   "classifierVersion": "…" },

  // AXIS 2 — property of (content × prompt assembly × downstream capability).
  // NOT cacheable across tasks whose assembly or capability set differs.
  "injectionRisk": { "decision": "PASS|NEUTRALIZE|BLOCK",
                     "assemblyTemplateId": "summarize.partial@3",
                     "capabilitySetId": "readonly-text",
                     "confidence": 0.0 },

  // AXIS 3 — clinical signal. NEVER gates anything, ever.
  "clinical": { "signals": [ { "category": "self_harm", "confidence": 0.0,
                               "span": [12, 48] } ] },

  // C-2 made checkable: is this verdict valid for what the consumer will send?
  "window": { "inspectedChars": 0, "consumerWindowChars": 0, "complete": true },

  "createdAt": "…", "validatorId": "…"
}
```

**Why axis 1 and 2 split.** Prompt position materially changes attack success — a distractor at the
end of a prompt causes a 60.4% accuracy drop, middle 52.5%, start 48.7% (arXiv:2510.16259). A verdict
computed against one assembly **does not transfer** to another. Content-harm is a property of the
text and fans out freely; injection risk is not.

**Cache key** = `contentHash | policyVersion | classifierVersion | taxonomyVersion | thresholdSet |
tenantId` **plus, for axis 2 only,** `assemblyTemplateId | capabilitySetId`.

**Re-check axis 2 whenever:** the *set* of content joined into one context changes (concatenating a
validated transcript with a validated document creates an **unvalidated composite**); the content's
position relative to instructions changes; the downstream capability set changes; or output leaves
the trust boundary.

## 4. Flow

```
STT utterance FINALIZED                    ← never interim hypotheses: they churn word-by-word
                                             and produce verdicts on text that will change
  → streaming tier (§5.1), ≤100 ms
  → persist verdict, attach validationRef, emit segment.validated
        ↓
   consumers read the verdict — they never call guardrail directly

BEFORE ANY DOWNSTREAM TASK READS THE TRANSCRIPT  ← the gate that actually matters
  → consumption tier (§5.2): validate the CUMULATIVE artifact, not the delta
  → assert window.complete over the accumulated window
```

## 5. Boundary mitigation — three tiers on two clocks

### 5.1 Streaming tier — every finalized segment, ≤100 ms

- **Deterministic rules as a persistent-state NFA over the whole stream**, not per-chunk regex. This
  buys *chunking invariance*: the same content is blocked at the same boundary under every finite
  chunking (arXiv:2608.10279 — 30.2 ms vs 96.6 ms median at 16K chars). Deterministic tier only; no
  semantic coverage.
- **Small classifier on a sliding window of ~1,024 tokens with ~25% overlap, at sentence/utterance
  boundaries** (SentGuard, arXiv:2606.02041). The overlap is for contiguous straddle **only** (§2.2).
- **Per-session running state — this is the actual defence:**
  `excess_risk += max(0, window_score − θ)` and `consecutive_windows_above_θ`.
  Fire on `excess_risk > Θ_session` **or** `consecutive ≥ 2`.
  This is Prompt Overflow's stateful global aggregation, the only mitigation shown to recover a
  bypass (aggregate 0.32 benign → 0.628 flagged). **Calibrate θ and Θ per tenant on clinical text,
  never on a general corpus.**

### 5.2 Consumption tier — before any downstream read

- Validate the **full cumulative transcript as one artifact.** Not the delta. Not the window.
- **Bounding the O(n²)** — three mechanisms together:
  1. Validation runs on **consumption checkpoints, not deltas.** Incremental summarization every
     2–5 minutes over a 30–60 minute encounter is ~10–20 cumulative passes at ≤30K tokens — tens of
     milliseconds at 8–15 ms/window, off the interactive path.
  2. **Prefix-hash caching**: unchanged prefixes reuse their per-window scores, making each
     cumulative pass O(delta) in classifier work and O(n) only in aggregation.
  3. **Hard cumulative ceiling**: last ~30K tokens verbatim plus a rolling summary of the earlier
     prefix — where that summary is **itself a validated artifact**. The deterministic NFA state
     remains whole-stream regardless.

### 5.3 LLM-judge tier

Unchanged from TASK-818 §3B: ambiguity only, hard token and wall-clock cap, **on the cumulative
artifact, never on the delta**.

## 6. Fail posture, and the invariant that outranks it

TASK-818 §3B.7 rules fail-closed including on timeout. **In a live consultation, fail-closed applies
to downstream USE — never to capture or display.**

| On failure/timeout | Behaviour |
|---|---|
| Transcript segment | **Retained verbatim and shown to the clinician.** It is the clinical record |
| AI derivations | Do not run until it validates |
| Consultation | Continues |
| Clinician sees | "AI summarization paused — recording and transcription continue normally" |

> ### 🔒 Hard invariant — encode it as a test
> **No guardrail decision, at any tier, may remove, redact or withhold text from the clinician's own
> view of the transcript.** Guardrails constrain what the *agentic loop* consumes and emits. **They
> do not edit the clinical record.**

## 7. Output-side checking — mandatory, per task (C-4)

Input validation covers none of this. Layered input + output is the OWASP-aligned minimum.

| Task | Check |
|---|---|
| **NER** (extractive) | **Span provenance** — every entity must map to a character offset in the source transcript; drop unmappable entities |
| **Grammar/spelling** (transformative) | Edit-distance + clinical-term preservation diff. **A "correction" that changes a drug, dose, negation or laterality is a safety event, not a style change** |
| **Summarization** (generative) | Sentence-level groundedness against the transcript + unsupported-clinical-claim check + no-new-entities check |

**Groundedness tooling, with the honest calibration:** MiniCheck-FT5 (770M) reaches GPT-4-level
balanced accuracy on LLM-AggreFact at ~**400× lower cost** ($0.24 vs $107 on a 13K test set) — but
is reported at only **~70–74% balanced accuracy** on abstractive-summarization faithfulness.
**Treat it as a screening signal, not a gate.** Azure Content Safety groundedness has a **Medical
domain** with reasoning and auto-correction. Clinical-specific: hallucination-detection-guided
self-refinement cut hallucinations **24%**, and **48%** with preference learning
(arXiv:2605.28910). For PHI, purpose-built clinical de-id beats general LLMs — 96% F1 vs GPT-4o 79%.

**Sobering context:** "The Mirage of LLM Guardrails" (arXiv:2607.24859, 2026-07-26) found medical-note
manipulation refusal rates of **0.0% for Gemini 2.5 across 2,100 attempts**, 94.7% field-substitution
accuracy, and humans accepting forged notes 64.1% of the time. Do not treat a model's own refusal
behaviour as a control.

**Governance backstop:** NHS England ambient-scribing guidance puts the **clinician as author with
no auto-accept**, plus audio-vs-signed-note audits.

## 8. Clinical vs attack — two classifiers, two outcomes

- **Security classifier** — *"is there an instruction addressed to the system in this text?"*
  Imperative constructions targeting the assistant, delimiter/role-marker injection, encoded
  payloads, instruction-like content in dictated or pasted material. On positive: **quarantine and
  neutralise** — the segment stays verbatim in the transcript and visible to the clinician, and is
  passed downstream only as inert data, never in instruction position. **Never a clinical alert.**
- **Clinical-risk classifier** — a purpose-built, clinician-annotated taxonomy: Safe /
  Self-Harm Risk / Harm-to-Others Risk, judged on intent, planning, means, escalation, and
  conversational context (history vs current, metaphor vs literal, patient vs third party,
  clinician screening question vs patient statement). On positive: **clinical escalation, never a
  block.** MindGuard's model, taxonomy, dataset and red-team framework are open source and
  clinician-annotated — a viable starting point (vendor-published 3.1% FP; replicate before relying).
- **Do not use a general harm taxonomy anywhere on consultation transcripts** (§2.1).
- **A "clinical context" flag or allowlist is the wrong architecture** — a single boolean gating a
  taxonomy never built for the domain still fires on negation, hypotheticals and third-party
  mentions, which are the documented FP drivers.
- **Explicit: self-harm disclosure routes to clinical escalation, not to a block.** In deployed
  systems the documented failure is the *absence* of escalation, not over-blocking.

## 9. Alert spec — passive by default

CDS override rates run **49–96%**; one study found 73.3% of medication alerts overridden, 40% of
those inappropriately. Replacing interruptive alerts with **passive** CDS is a published, effective
anti-fatigue intervention. Design against the Five Rights of CDS.

| Category | Surface | Copy | Actions |
|---|---|---|---|
| **Clinical risk** | Interruptive, **once per encounter** | "Possible risk disclosure detected at 12:41 — patient statement about self-harm. Review the transcript excerpt." **Quote the patient's own words with timestamp. Never paraphrase, never editorialise, never assert a diagnosis** | Jump to transcript · Acknowledge · **Not a risk disclosure** (feeds the FP corpus) · local crisis-protocol link |
| **Suspected injection** | **Passive** badge on the segment + one status-footer line | "This segment contains text that looks like an instruction to the AI assistant. It was excluded from AI processing. Your transcript is unchanged." **Never render the payload as actionable text; never say "attack" or "malicious"** — dictation artefacts and quoted emails land here | Show segment · **This is normal clinical content — include it** (logged override) |
| **Ungrounded claim in summary** | Inline, at the claim | "Not supported by the transcript." Highlight the sentence; show the transcript span it should have come from, or "no supporting span found" | Remove · Edit · Keep — I verified |
| **PHI in an outbound artifact** | Blocking **on the outbound action only** | "This draft contains identifiers not permitted in this destination." | Redact · Cancel |
| **Guardrail unavailable** | Passive banner | "AI summarization paused — safety checks unavailable. Recording and transcription continue normally." | Retry |

**Across all categories:** one alert per distinct finding per encounter, deduped by content hash;
never re-fire a category on re-validated cumulative text; every alert carries a one-click dispute
logged with content hash, tenant, policy version and clinician id, feeding per-tenant threshold
recalibration. **Measure and publish override rate per category — sustained above ~50% is a design
defect, not a compliance problem.**

## 10. Agentic-loop obligations (C-3)

Per OWASP Top 10 for Agentic Applications 2026, these are checked **per iteration, not once at
entry**: the assembled context (not the delta), every tool-call argument set, the tool-call
**sequence**, the loop/step budget, and any content promoted into persistent memory. Memory
poisoning executes days later on innocuous triggers, and "decision drift" is gradual corruption
where no single step trips an alarm. LlamaFirewall (arXiv:2505.03574) is the open reference stack.

## 11. Phasing

| Phase | Scope |
|---|---|
| **1 — the contract** (days) | The three-axis verdict artifact, one guardrail endpoint, the cache with both key scopes, `validationRef` on segments, consumers reading it. **T0 (NFA) + T1 (classifier) only — no LLM judge.** Clinical signals recorded, surfaced passively |
| **2 — coverage** | Per-session stateful aggregation (§5.1), cumulative consumption-tier validation with prefix-hash caching and the ceiling (§5.2), `window.complete` enforced |
| **3 — output side** | Span provenance for NER, clinical-term preservation for grammar, groundedness for the summary (§7) |
| **4 — clinical classifier** | Replace/augment the interim taxonomy with a clinician-annotated one; calibrate θ/Θ per tenant on real clinical text; stand up the FP corpus from dispute events |

## 12. Verification Criteria

- [ ] A segment carries one verdict; **no consumer calls guardrail directly**
- [ ] Guardrail invoked **exactly once** per finalized segment under a fan-out of 3+ consumers (call-count assertion)
- [ ] `contentHarm: none` **with** a clinical self-harm signal processes end-to-end — **the disclosure appears in the summary**
- [ ] A clinical signal never gates any task under any configuration
- [ ] **Adversarial: a payload dispersed across ≥4 segments is caught by session aggregation** (not by overlap — §2.2)
- [ ] Axis-2 verdict is **not** reused across differing `assemblyTemplateId` or `capabilitySetId`
- [ ] Concatenating two validated artifacts forces revalidation of the composite
- [ ] `window.complete = false` forces a cumulative re-check before the model sees the window
- [ ] **Hard invariant: no guardrail path can remove, redact or withhold transcript text from the clinician's view** (§6)
- [ ] Validation timeout retains and displays the transcript; only derivations pause
- [ ] Cache key includes `tenantId`; cross-tenant hit impossible
- [ ] Policy/classifier/taxonomy version change invalidates every affected verdict
- [ ] Grammar pass that alters a drug, dose, negation or laterality is flagged as a safety event
- [ ] Every NER entity maps to a source span; unmappable entities dropped
- [ ] Alert copy contains no moderation vocabulary; override rate instrumented per category; axe clean, both themes

## 12A. Implementation Summary — Phase 1 decision plane (`apps/guardrail`)

**What shipped.** The whole of §3, §5.1, §5.2's correctness rules, §7's deterministic
half, and the §6 invariant, as a self-contained plane in `apps/guardrail`. 3,717 lines
across 18 files, all under `apps/guardrail/` — nothing else in the monorepo is touched.

| Module | Condition it carries |
|---|---|
| `realtime/verdict.py` | C-1 (three axes, two cache scopes), C-5 structurally |
| `realtime/deterministic.py` | T0 — Aho-Corasick with persistent state; chunking invariance |
| `realtime/session_state.py` | §5.1 aggregation |
| `realtime/consumption.py` | **C-2**, C-3 |
| `realtime/output_checks.py` | C-4 |
| `realtime/service.py`, `store.py` | composition, cross-replica session state |
| `api/endpoints/realtime.py` | 4 routes on `/api/v1/guardrail/realtime/*` |
| `core/policy.py`, `core/dependencies.py` | 9 governed tuning keys; fail-closed taxonomy resolution |

**~~94~~ 93 new tests; 397 pass in the guardrail suite; realtime modules 97-100% covered.**
*(Re-counted 2026-08-31 by `grep -cE "def test_"` across the six files the two Phase-1 commits
created — consumption_gate 18, output_checks 16, streaming_tier 14, verdict_axes 12,
realtime_service 16, realtime_routes 17 = **93**. Off by one; corrected rather than left to be
re-discovered. The suite total and coverage figures are UNVERIFIED here — confirming them needs a
run, which is out of scope for a documentation pass.)*
The one failure in that suite is pre-existing — see the Defect note below.

### The per-delta regression test (C-2)

`test_clean_segment_verdicts_never_compose_into_a_cumulative_pass` hands the gate a
COMPLETE set of PASS segment verdicts that concatenate to exactly the cumulative
window, and requires refusal anyway. The module has no compose/merge/fold helper and
a second test asserts that absence, so the cheaper wrong answer is not reachable.
`test_the_same_payload_is_caught_when_the_cumulative_artifact_is_validated` shows the
consequence end to end: five utterances each PASS individually; the identical text
validated as one artifact BLOCKs.

### Three corrections to this ticket, all load-bearing

1. **§5.1's aggregation cannot catch what it was introduced for.** With
   `excess_risk += max(0, score - θ)`, evidence dispersed BELOW θ contributes exactly
   zero from every window — and dispersal below the per-window threshold IS the attack
   (§2.1: confidence collapsing 0.99 → 0.03). The evidence §5.1 itself cites, "0.32
   benign → 0.628 flagged", is a length-invariant MEAN, not a sum of excesses. A third
   signal — the session mean, gated behind a minimum window count — is tracked
   alongside the two §5.1 specifies.
2. **The two tiers must not share an accumulator, or the plane over-blocks.** The
   consumption tier re-reads the whole transcript at every checkpoint, so folding its
   windows into the persistent session state counts the prefix once per checkpoint:
   `excess_risk` grows with the square of the encounter and a 60-minute benign
   consultation eventually trips the session alarm on its own length. Over-blocking a
   clinician is a patient-safety failure (§3B.2), so the streaming tier owns the
   persistent accumulation and the consumption tier scores its artifact afresh.
   Pinned by a 20-checkpoint benign-session test and an idempotence test.
3. **§2.2's correction needed one more step.** Overlap is not the split-injection
   defence, and neither is a per-replica automaton. Chunking invariance that holds only
   inside one process holds only by luck of routing, so the automaton's state-bearing
   suffix is persisted and replayed on resume.

### ✅ RESOLVED — the session aggregation can now be graded (TASK-830)

**The limit as recorded on 2026-08-30:** §5.1's arithmetic wants a graded per-window
score, and the platform could not produce one. `apps/nlp`'s guard-classify route
returned `results: dict[str, str | list[str]]` — LABELS, with no per-label confidence
(`apps/nlp/src/nlp/api/v1/rest/guard.py:318-326`; `external_nlp_client.classify` passed
them through unchanged). So the computable score was categorical, the session mean was a
**flag RATE** rather than the confidence mean whose separation §2.1 measures, and every
verdict carried `scoreCalibration: "categorical"`.

**What TASK-830 found and fixed.** The confidences were never missing — `gliner2`
computes them (`_extract_classification_result` softmaxes/sigmoids the classifier logits
into `(label, confidence)` tuples) and `_format_results` DISCARDS them unless the caller
passes `include_confidence=True`. `apps/nlp` asked on its entity path and did not ask on
the classify path. `/guard/classify` was also the only unscored classification surface in
the service: `/classify/text`, `/classify/text/multi-label`, `/classify/tokens`,
`/guard/pii` and `/guard/entailment` have all always returned numbers.

The fix is ADDITIVE — `results` keeps its exact shape, because three guardrail call sites
parse it as `str | list[str]` — and the confidences arrive in a sibling
`scores: dict[str, dict[str, float]]`. Guardrail's realtime plane consumes them through
`SafetyAnalyzer.classify_tasks_scored` and derives a per-window risk (a non-benign label
contributes its confidence; a benign one contributes `1 - confidence`, the mass the model
did not put on "clean").

**`scoreCalibration` is now computed, not asserted.** It reads `graded` only when EVERY
window folded into the aggregate carried a real confidence, and `categorical` otherwise —
a peer that reports no scores still gets a correct categorical verdict, and a partially
scored session understates itself rather than handing Phase 4 calibration data that is
silently part flag rate. `gradedWindows` sits alongside `windows` in the aggregate so the
mix is auditable.

**Phase 4 is unblocked**, with one condition: calibrate θ/Θ only against aggregates whose
`scoreCalibration` reads `graded`. See
`docs/implementation/TASK-830-Nlp-Guard-Classify-Confidences/README.md` — including the
noted limit that `1 - P(benign)` is exact for a single-label softmax task and an estimate
for a multi-label sigmoid one.

### Measured latency — T0 only

Apple arm64, Python 3.11.15, 40 declared phrases, synthetic clinical prose:

| Artifact | T0 whole-artifact median | T0 per-utterance p95 |
|---|---|---|
| 2,000 chars | 0.40 ms | 0.026 ms |
| 16,000 chars | 3.11 ms | 0.025 ms |
| 120,000 chars | 24.09 ms | 0.025 ms |

Per-utterance T0 is ~0.03 ms, comfortably inside the ~1 ms budget, and the
whole-artifact pass at the 120K ceiling is 24 ms — consistent with §5.1's cited NFA
figures. **T1 was NOT measured and no claim is made about it**: it requires a live
`apps/nlp` with a resolved model, and infrastructure commands were out of scope for
this lane. **The §3B budget of `T0+T1 p95 ≤ 120 ms` is therefore UNVERIFIED.**

### Configuration this plane requires before it can serve a request

All fail-closed — an unresolved declaration raises rather than substituting a default.
On `AiModel._metadata.labelTaxonomy.realtime` of the `guardrail.safety` selection:

| Key | Why fail-closed |
|---|---|
| `axes` (`contentHarm` / `injectionRisk` / `clinical` task lists) | Which signals GATE and which merely inform is the C-1 decision |
| `deterministicPatterns` | An empty automaton reports every stream clean |
| `capabilitySets` | C-3 cannot be checked against an undeclared capability model |
| `protectedLexicons` | *Not* fail-closed — absence makes its output check `skipped`, never `pass` |

Plus nine bounded tuning keys on `_metadata.policy` (`realtimeNoiseFloor`,
`realtimeExcessRiskThreshold`, `realtimeConsecutiveLimit`, `realtimeMeanScoreThreshold`,
`realtimeMinWindowsForMean`, `realtimeWindowChars`, `realtimeWindowOverlapChars`,
`realtimeCumulativeCeilingChars`, `realtimeVerdictTtlSeconds`). **No seed row was
written in this lane** — seeding is a `packages/database` change and is listed below.

### Not done, and why

| Outstanding | Blocker |
|---|---|
| Persisting the verdict + `validationRef` on `TranscriptSegment` | Needs a Prisma model/column and therefore a migration. Authoring one requires a throwaway shadow DB (`02-database-prisma.md`), and DB/infra commands were out of scope. `TranscriptSegment` already carries `_metadata` JSONB, but stashing a safety artifact in an unmodelled JSON blob is not the right answer for an EU AI Act Article 12 record |
| Durable audit record (Art. 12, 6-month retention) | Same blocker. The Redis store here is a CACHE and explicitly does not satisfy it |
| STT hook at segment finalization | `apps/stt` publishes per-utterance to Redis Streams inside `process_utterance` and persists only at `_finalize_session`; there is no per-segment persistence to attach a `validationRef` to. Attaching one means extending `SegmentResult` before its publish — a real change to the streaming contract, not a hook |
| Harness/applications adopting the consumption gate | `apps/harness` calls `GuardrailClient.analyze()` DIRECTLY today (`temporal/interpreter/nodes/guardrail_check.py`, `temporal/activities.py:583`), which §4's "consumers never call guardrail directly" already contradicts. Migrating it is a behaviour change to a Temporal activity with replay-compatibility implications |
| Admin-console alert surfaces (§9) | Console work; the plane emits machine NOTICE CODES, never prose, so the copy rules stay testable where the copy lives |
| T2 LLM judge | Phase 1 is explicitly T0+T1 only |

### Defect found in the base branch (not introduced here) — ✅ RESOLVED 2026-08-30, stale test name below

**Superseded.** This item named a test, `test_the_prod_reference_that_described_the_phantom_plane_is_gone`,
that does not exist in `apps/guardrail/src/guardrail/tests/test_task799_config_plane.py` — no
match anywhere in the repo. The actual test at that location is
`test_the_prod_reference_exists_and_does_not_resurrect_the_phantom_plane`, and it asserts the
**opposite** of what this item's name implies: that `.env.prod` **exists** and is honest, not
that it is gone. The contradiction this item recorded was real (TASK-799 deleted the file and
pinned the deletion; a later commit re-added it), but it was reconciled in `d8f21ef01
fix(guardrail): pin the prod reference's honesty, not its absence` — the test now pins honesty
of content rather than absence, `.env.prod` is a deliberately-tracked operator-facing template
(`.gitignore:102`, `.gitleaks.toml:149`, `scripts/env-sync.mts` `READER_CHECKED_FILES` all
sanction it), and the guardrail suite is green on this point. `d8f21ef01` is confirmed an
ancestor of `dev-2.2`.

Original text, kept for history rather than deleted:

> `apps/guardrail/src/guardrail/tests/test_task799_config_plane.py::test_the_prod_reference_that_described_the_phantom_plane_is_gone`
> **fails on `dev-2.2` itself.** TASK-799 (`a40158536`) deleted `apps/guardrail/.env.prod`
> and locked the deletion with that test; a later commit,
> `2a1bfcc97 docs(env): give text and guardrail the .env.prod every other service has`,
> re-added the file. The file is tracked and present at the `dev-2.2` tip. Two commits
> disagree about whether it should exist. **Not touched here** — the assertion should not
> be edited to match, because that hides the contradiction rather than resolving it.

## 13. Change History

| Date | Change |
|---|---|
| 2026-08-29 | Created from the owner's realtime-consultation requirement; two-axis verdict and "gate derivations never the record" confirmed by the owner. |
| 2026-08-30 | **Phase 4 unblocked by TASK-830** (§12A). `apps/nlp`'s `/guard/classify` now returns per-label confidences (they were computed by `gliner2` all along and dropped for want of `include_confidence=True`), so the session aggregate is a graded mean where the executor scores it. `scoreCalibration` is computed per aggregate — `graded` only when every window carried a confidence — rather than hardcoded `categorical`. |
| 2026-08-30 | **Phase 1 decision plane implemented in `apps/guardrail`** (§12A). Three corrections to this ticket: §5.1's excess-above-θ sum is blind to sub-θ dispersal and needed the length-invariant mean the cited evidence actually describes; the streaming and consumption tiers must not share an accumulator or a benign encounter over-blocks on its own length; automaton state must survive a replica change or chunking invariance holds only by luck of routing. One honest limit recorded: `apps/nlp` returns labels without confidences, so the session aggregate is a flag rate, not a graded mean, and Phase 4 calibration is blocked on that. |
| 2026-08-29 | **Rewritten after streaming-guardrail research.** Corrections: overlap is NOT the split-injection defence (§2.2) — replaced by per-session stateful aggregation; verdict split into **three** axes with two cache scopes (§3), since injection risk is not task-agnostic; five safe-trust conditions added (§2); output-side checks made mandatory per task (§7); general harm taxonomies ruled out on clinical text (§2.1); hard no-redaction invariant added (§6). |
| 2026-08-30 | **§12's "a policy change invalidates every affected verdict" was not true on the fan-out read path.** The consumer handle `gr:rt:seg:<tenant>:<segment>` is keyed by tenant and segment id and by nothing else, so `read_segment_verdict` served verdicts computed under a superseded policy for the whole `realtimeVerdictTtlSeconds` window. The config-invalidation channel was already correct and is not the gap — it drops the CONFIG cache, so the next request resolves the new policy; nothing dropped the VERDICTS the old policy had produced. Worst case is the one that matters most: an operator TIGHTENING a threshold mid-incident kept getting the pre-change PASS verdicts. Fixed by stamping each stored verdict with `RealtimePolicy.stamp` and treating a mismatch as a MISS on read (recompute, never serve stale). The stamp is a **property derived from the resolved policy**, not a constructor argument, so no construction site can forget it or pass one that disagrees; it covers the four declared versions **plus** the behavioural inputs that decide a verdict but carry no version of their own — the axis map, the deterministic phrases, the capability sets, the session thresholds, window geometry, benign labels, lexicons and policy provenance. `ttl_s` is deliberately excluded (how long a verdict may be reused is not part of what it says). `DeterministicRuleSet` gained a `declaration_digest` because rule ids are stable by design, so a phrase edited under an existing id changed every verdict while leaving `rule_ids` identical. 14 tests added (`test_task829_verdict_invalidation.py`), including the negative control that an UNCHANGED policy still hits — over-invalidating would silently restore the N-classifications-per-segment cost this design exists to remove. |
| 2026-08-30 | **Correction to §12A's "Not done" table: harness is NOT a §4 violation.** Both `GuardrailClient.analyze()` call sites in `apps/harness` (`temporal/interpreter/nodes/guardrail_check.py`, `temporal/activities.py:583` `_safety_screen_client`) screen **generated/bound text**, not a transcript the realtime plane produced a verdict for — `guardrail_check` explicitly degrades with `no_bound_text` when no *generated* text is bound. §4's "consumers read the verdict, never call guardrail directly" governs the transcript fan-out (partial summarization, NER, grammar reading a partial transcript); text a model has just produced has no pre-existing segment verdict to read, and checking it is §7 output-side work (Phase 3). Migrating those call sites to `read_segment_verdict` would hand an output-side check an input-side verdict about different text, and was therefore NOT done. The genuine consumer wiring remains blocked on the `TranscriptSegment.validationRef` column (Prisma migration) and the `apps/stt` segment-finalization hook, as already recorded. |
| 2026-08-30 | **Corrected: §12A's "Defect found in the base branch" named a test that does not exist.** It cited `test_the_prod_reference_that_described_the_phantom_plane_is_gone`; no such test is in `test_task799_config_plane.py` or anywhere in the repo. The actual test, `test_the_prod_reference_exists_and_does_not_resurrect_the_phantom_plane`, asserts the opposite of the cited name — that `.env.prod` exists — and the underlying contradiction it recorded (TASK-799 deleted the file and pinned the deletion; a later commit re-added it) was reconciled in `d8f21ef01 fix(guardrail): pin the prod reference's honesty, not its absence`, confirmed an ancestor of `dev-2.2`. Marked resolved; original text kept for history rather than deleted. |
| 2026-08-31 | **Re-verified against the `dev-2.2` tip. The ticket holds; the two named blockers are unchanged; one count corrected.** Confirmed present at the stated paths: `verdict.py`, `deterministic.py`, `session_state.py`, `consumption.py`, `output_checks.py`, `service.py`, `store.py` and `api/endpoints/realtime.py`; the four `/api/v1/guardrail/realtime/*` routes; all nine governed tuning keys in `core/policy.py`; `RealtimePolicy.stamp` as a derived `@property` (not a constructor argument, which is what stops a construction site forgetting it) with 14 tests in `test_task829_verdict_invalidation.py` — matching the claim exactly; `DeterministicRuleSet.declaration_digest`; and the `resume_tail` cross-replica path. `consumption.py` does not import `session_state`, which supports the "the two tiers must not share an accumulator" claim structurally. **Corrected:** §12A's "94 new tests" is **93** — re-counted across the six files the Phase-1 commits created (18+16+14+12+16+17). **Both remaining blockers re-confirmed as genuinely open:** `validationRef` appears **nowhere** in `packages/database/src/prisma/**` (`TranscriptSegment` is at `consultation.prisma:650` and has no such column, so the Prisma migration is unwritten), and `apps/stt/src` contains **no** reference to `read_segment_verdict` or the realtime segment endpoint, so the segment-finalization hook does not exist. **Phase 4's unblock is real:** TASK-830 is merged into `dev-2.2` via `c16cef1cb`, and `realtime/service.py:414-420` computes `scoreCalibration` from `graded_windows == windows` rather than hardcoding `categorical`. Status unchanged — `In Progress`, wiring outstanding. |
