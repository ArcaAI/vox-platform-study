# TASK-825 — Realtime consultation guardrail plane

| | |
|---|---|
| **Status** | Pending |
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

## 13. Change History

| Date | Change |
|---|---|
| 2026-08-29 | Created from the owner's realtime-consultation requirement; two-axis verdict and "gate derivations never the record" confirmed by the owner. |
| 2026-08-29 | **Rewritten after streaming-guardrail research.** Corrections: overlap is NOT the split-injection defence (§2.2) — replaced by per-session stateful aggregation; verdict split into **three** axes with two cache scopes (§3), since injection risk is not task-agnostic; five safe-trust conditions added (§2); output-side checks made mandatory per task (§7); general harm taxonomies ruled out on clinical text (§2.1); hard no-redaction invariant added (§6). |
