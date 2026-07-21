# External SOTA Report Gap Review — Harness, Agentic Loops & Human Feedback (2026-07-18)

- **Status**: Review deliverable (assessment only — no code changed)
- **Type**: review / planning input to the SOTA Enhancement Track
- **Source under review**: external research report *"SOTA Architectures for Real-Time Clinical Consultation AI: Harness Layers, Agentic Loops, and Evaluation (2024–2026)"* (compass artifact, provided by owner 2026-07-18)
- **Baseline compared against**: `fix/2605-review` as of 2026-07-18 (post TASK-470–483 SOTA-track execution, post TASK-505 ASR rebuild, post TASK-506 model-registry consolidation)
- **Method**: four parallel code-mapping passes (harness Temporal internals · SMR LLM layer · guardrail+NLP · end-to-end flow+eval) with file:line evidence, reconciled against `docs/archive/TASK-448-Harness-Loop-Quality-Review` (the July 9 internal SOTA review) and `docs/implementation/SOTA-Track/README.md`
- **Also answers**: owner's three deployment scenarios — (A) 64 vCPU / 128 GB / 1×RTX 5090 32 GB or 2×RTX A2000 Ada 16 GB, (B) 128 vCPU / 256 GB / RTX PRO 6000-class, (C) cloud

---

## 1. Executive verdict

**HOPE's architecture is the one the report recommends.** The report's central thesis — "build a durable, workflow-first harness with narrowly-scoped agentic steps, not an autonomous agent swarm" — is precisely what TASK-330 built and cited (the founding HLD quotes the same Anthropic "Building Effective Agents" source the report does). On the harness fundamentals HOPE is **at par or ahead** of the report's recommendations: Temporal durable execution with replay-compat regression tests, an evaluator-optimizer loop with a 9-sensor battery, a signal-driven clinician gate with SLA escalation and terminal abandon, WORM hash-chained attestation, optimistic delivery **with a retraction contract**, PHI egress guarding, per-tenant policy, and a PDSQI-9 LLM-judge eval with ICC/Gwet calibration and dual-judge parity gates (a rubric the report itself recommends; TASK-448 judged this lane "ahead of most").

The real gaps fall into four buckets:

1. **Built but dormant** — a large fraction of the July SOTA track shipped default-OFF pending model staging / GPU / a flag flip (groundedness gate, atomic-fact verifier, Sortformer diarization, warm-start, NER priors, retrieval, optimistic delivery, claim-check S3, Parakeet streaming). *The owner's hardware decision (this document's §7) is the actual unblocking event for most of these.*
2. **Genuinely missing vs the report** — prompt/prefix caching (completely absent; the live-doc prompt is actively cache-hostile), token-aware context management (no tokenizer anywhere), critique-informed regeneration (regen re-runs the *identical* prompt), negation/assertion detection, per-sentence evidence links with timestamps (word timestamps are silently dropped at ingest), a real clinician golden set (SME owner explicitly unassigned), complexity-based model routing, and a clinical-guideline RAG corpus.
3. **Deployment/ops defects found during this review** — the production harness Docker image installs none of the `rag`/`guardrails`/`atomic-fact` extras while `qdrant_client` is imported unconditionally at module top level; eval CI gates aren't wired into GitLab; edit-burden telemetry has no HTTP route; OTel is off by default; no harness Prometheus/Grafana surface.
4. **Regulatory hygiene** — the NLP diagnosis-suggestion endpoint is a bare classifier with no CDS framing; under the FDA's 2026 CDS final guidance (and CDSCO equivalents) it must stay out of the clinical flow (it currently is out — playground only) or be gated, cited, and framed for independent review.

**Bottom line**: the highest-leverage work is *not* new architecture. It is (a) staging models and flipping the flags the hardware allows, (b) closing the four "missing vs report" accuracy levers (critique-fed regen, negation, evidence links, golden set), and (c) the prompt-caching + two-tier-routing performance program, which the workstation scenario makes possible.

---

## 2. Scorecard — report recommendation vs HOPE state

Legend: ✅ at par or ahead · 🟡 partial / built-but-dormant · ❌ absent.

| # | Report recommendation | HOPE state | Verdict |
|---|---|---|---|
| 1 | Durable, workflow-first harness (Temporal/LangGraph-class), code-owned control flow, HITL interrupt | `HarnessDocWorkflow` (`apps/harness/src/harness/temporal/workflows.py:140-1082`): fixed guides→generate→sensors→gate pipeline, all I/O in activities, `wait_condition` approval gate + SLA escalation + terminal abandon, 7 `workflow.patched` eras, 9 replay-compat fixture tests, claim-check for the 50 MB history budget (TASK-483) | ✅ ahead |
| 2 | Evaluator-optimizer (generate→critique→regenerate) | Bounded regen loop over 5 computational + 4 inferential sensors — but regen **re-runs the identical prompt** (`workflows.py:536-538,599-601`); sensor findings are never fed into the retry prompt | 🟡 structure ahead, feedback half missing |
| 3 | Streaming/incremental note loop (sliding window, progressive note-taking) | `LiveDocumentationService` (`packages/applications/.../live-documentation.service.ts`): delta-only flushes (12 k-char cap, carry-forward), refine-in-place prompt, superseded-flush abort, NER over the raw transcript delta (not the note — TASK-477), durable snapshots, SSE | ✅ (trigger is segment-count+idle timer, not the report's relevance classifier — minor) |
| 4 | Prompt chaining / SOAP-aware generation | Two-stage pre-summary→final chaining; ~40 DB-resident templates (department × visit-type), SOAP JSON schema, prompt-tier resolution (preferred→department→default), DNA style | ✅ |
| 5 | Sectioning (parallel per-SOAP-section) + voting where accuracy justifies | Absent — every note revision is one `/generate` call; runtime voting absent (self-consistency exists only in the offline judge) | ❌ (deliberate simplicity; revisit only with evidence) |
| 6 | Routing (easy→small model, complex→large) | Absent — per-tenant static `HarnessPolicy.smrProvider/smrModel`; `AiTaskDefault` (TASK-506) does not yet cover `smr.*` keys | ❌ |
| 7 | Prompt caching (static prefix / dynamic suffix; up to 90 % cost / 85 % latency on cache reads) | **Completely absent** in SMR/harness/applications; live-doc prompt puts the *mutating* prior note *before* the new delta (`live-documentation.service.ts:1031-1048`) — actively cache-hostile for vLLM/LM Studio prefix caching | ❌ |
| 8 | Context management: compaction ~70 % budget, token counting, context-rot awareness | No tokenizer anywhere (word-count heuristic + char caps only: 200 k prompt / 50 k system / 12 k delta); transcript threaded whole through every regen; no compaction path for multi-visit chain summaries | ❌ |
| 9 | Evidence linking — every sentence traces to transcript segments (report: "single most important trust feature") | Partial: StrictCitations for RAG chunks (hallucinated ids cannot survive — `guides/retrieval/prompt.py`), `NamedEntity` char-offset spans into the transcript. But the transcript persists as **one flattened blob** (`sttInternal.service.ts:68-183`); word timestamps/confidence in the DTO are **silently dropped** (`internal.request.ts:28-33`); no per-sentence→segment/audio links, no speaker attribution reaches the clinician | 🟡 |
| 10 | Confabulation detection (dedicated model, not off-the-shelf LLM) | Functionally present under other names: `entity_faithfulness`, `numeric_dose`, `atomic_fact` (MiniCheck GGUF, live-calibrated 0.9827/0.0063, 523 docs/min CPU), groundedness NLI gate in guardrail-v2. **All dormant**: atomic-fact default OFF (falls back to a weak overlap entailer), live gate double-flag OFF, real-corpus P/R (AC-6) unmet | 🟡 built, dormant, unvalidated on real corpus |
| 11 | Terminology grounding (SNOMED/ICD-10/RxNorm/LOINC validation; FHIR/MCP terminology service) | Ontology linker shipped (TASK-476): ~30-concept curated in-process dict, 100 % link precision / 82 % coverage on n=28; codes persist to `NamedEntity`. No real terminology service, no code validation against releases, no negation/assertion detection anywhere (`nlp/schemas/common.py` has no polarity field) | 🟡 |
| 12 | RAG over guidelines for grounding (Kresevic 43→99 %; Ferber 57→84 %) | Hybrid dense(bge-m3)+sparse(bm25) RRF + TEI bge-reranker-v2-m3, tenant-filtered, degrade-safe, StrictCitations, citation-verify sensor, RAG-triad score — **default OFF**, institutional-knowledge only; no clinical-guideline corpus ingested (licensing research done in TASK-330 §2.6: PubMed/PMC-OA/CDC/ICD-11 usable) | 🟡 |
| 13 | Layered eval: public benchmarks + MEDCON + factuality + LLM-judge validated against physicians + PDQI/PDSQI-9 + hallucination/omission taxonomy | PDSQI-9 vendored (Epic/JAMIA 2025) with ICC 0.821 + Gwet 0.963 + judge-parity gate; MEDCON concept-F1 + harm-weighted error + edit-burden implemented (TASK-482); taxonomy in calibration cases. **But**: golden sets synthetic, `clinical_v1_spec.md` owner "unassigned", repo itself says results "MUST NOT gate clinical claims" until replaced; no ACI-Bench/MTS-Dialog/PriMock57 anchoring; eval gates not in CI | 🟡 infrastructure ahead, validation blocked |
| 14 | Streaming medical ASR, diarization, sub-second posture | Medical WER 0.033–0.066 and keyterm recall ≥ 0.83 measured (TASK-470) — already better than the report's vendor-quoted medical WERs; commit-latency p50 4.6–5.8 s with tentative-tail render masking; PARAKEET_CPP streaming engine landed (TASK-505) with conditional-GO pilot (TASK-472, English-only); Sortformer 2-speaker diarization implemented but **blocked on model staging**; no speaker labels reach the clinician today | 🟡 quality ✅ / latency+diarization dormant |
| 15 | Guardrails as separate screening instances; PHI de-id; fail-closed | GLiNER-guard ONNX (input classes), Granite Guardian 7-dim safety sensor, SMR input gate fail-closed (TASK-478), PHI egress guard fail-closed with cloud-provider blocklist, Presidio redactor in `harness/guards/phi/` | ✅ (but see §6 defect D1 — extras not in the prod image) |
| 16 | Human sign-off before EHR; FDA CDS 2026 posture | Sign-off: ✅ ahead (WORM `ATTEST`, attestation hash, safety-override recorded, `SIGNED_BEFORE_ASSURANCE` annotation, retraction). EHR: **no FHIR/HL7 export exists at all** (SMR `json_schema` support built-but-unused for it). Diagnosis suggester (`nlp/services/medical_suggester.py`) is a bare 41-class classifier, playground-only, `min_confidence=0.1`, zero CDS framing | 🟡 |
| 17 | Prompt injection / MCP security | No MCP surface (in-process tools only) — the report's MCP attack section is N/A by construction; GLiNER adversarial labels cover prompt-injection classes on inputs | ✅ by architecture choice |
| 18 | Token/cost budgets, trajectory observability | Iteration caps yes (max_regen/escalations/edit-reruns); **no token or $ budget**, no cost metric anywhere; SMR has TTFT/tokens Prometheus + Grafana; harness has **no** metrics endpoint/dashboard; OTel off by default | 🟡 |

---

## 3. What the report validates about HOPE (keep, don't churn)

- **Workflows-beat-agents**: the fixed pipeline with zero dynamic tool selection is the report's own recommendation for clinical documentation. Do **not** add orchestrator-workers/multi-agent (report: 15× token multiplier, compounding error) — the current shape is correct.
- **Two-phase optimistic delivery + retraction** (TASK-355/481) is ahead of anything the report describes — it cites draft-then-verify as desirable; HOPE has it with an explicit retraction contract and WORM trail.
- **Dual-path design** (ephemeral live loop + durable authoritative harness) matches the report's incremental-loop + verification-gate guidance; TASK-480 warm-start (Review) closes the acknowledged redundancy.
- **Self-hosted PHI posture** is stricter than the report's baseline (BAA-first): PHI egress guard fail-closed, self-hosted embeddings ("the query can contain PHI"), no cloud ASR/LLM/NLI in the clinical path.
- **Eval philosophy**: skipping ROUGE/BERTScore in favor of PDSQI-9 + concept-F1 + entailment metrics is consistent with the report's own caveat that surface metrics correlate weakly with clinical correctness.
- **Multi-tenancy, WORM audit, replay-safety** — territory the report doesn't even cover; HOPE's Qdrant tenant filters, hash-chained audit, and replay-compat fixtures are differentiators.

---

## 4. Gap register

Ranked within each theme by value-for-effort. Each gap lists: why (report evidence) → current state (code evidence) → recommendation.

### 4.A Accuracy

**G1 — Real clinician golden set (the gate for every other accuracy claim).**
Report §6: anchor safety on physician review; LLM-judge must be validated against physician raters. Current: both eval tracks run on synthetic/rubric-derived fixtures; `apps/harness/src/harness/eval/golden/clinical_v1_spec.md` defines the real program (N≥132, ≥8 specialties, ≥3 blinded raters, human ICC≥0.75) with **"Owner (clinical content): unassigned"**; `eval/golden/sources.py` says the fixture "MUST [be] replace[d] before any eval result is used to gate a clinical claim"; MiniCheck AC-6 (real-corpus P/R) and the retrieval golden set (~132 pairs) are blocked on the same missing asset. **Recommendation: assign the clinical SME owner and run the spec — this is a process unblock, not an engineering task, and it gates G2, G5, TASK-479 enablement, and any external quality claim.** Size S (eng) + SME program.

**G2 — Turn on what is built (staged-enablement program).**
Report Stage-2 hardening is largely *implemented* here and OFF: groundedness live gate (`GUARDRAIL_V2_GROUNDEDNESS_ENABLED=false` **and** `LIVE_DOC_GROUNDEDNESS_ENABLED` default `'false'`), atomic-fact sensor (`HARNESS_ATOMIC_FACT_ENABLED` off; default entailer is the weak `DeterministicOverlapEntailer` until a MiniCheck GGUF path is set), warm-start + NER priors (`HARNESS_WARM_START_ENABLED` off / absent from `turbo.json#globalEnv`; `HARNESS_NER_PRIORS_ENABLED` off), optimistic delivery (`HARNESS_OPTIMISTIC_DELIVERY_ENABLED` off), retrieval (`HARNESS_RETRIEVAL_ENABLED=false`), claim-check S3 (`HARNESS_CLAIM_CHECK_STORE=memory`), Sortformer diarization (weights unstaged; surfacing contract TASK-489 done), Parakeet streaming engine (staged binding pending), semantic endpointing neural model (unstaged → heuristic-only). **Recommendation: a per-tier enablement matrix (§7) with a measurement gate per flip (TASK-470 scorecard / harness eval) — the hardware decision is the prerequisite.** Size S per flip.

**G3 — Critique-informed regeneration (complete the evaluator-optimizer).**
Report §2: evaluator-optimizer works when "iterative refinement provides measurable value" — the critique must reach the optimizer. Current: on REGEN the harness re-executes the same prompt verbatim (`workflows.py:536-538,599-601`); sensor verdicts (which claim failed, which dose mismatched, which citation missing) are discarded. The regen budget (default 2) is therefore spent on dice re-rolls. **Recommendation: thread the failed-sensor findings into a corrective suffix on the regen prompt (the `CORRECTIVE_RETRY` template already exists in the seed, unwired) — deterministic, replay-safe (new activity input), cheap, and directly raises regen success rate.** Size S–M.

**G4 — Negation / assertion detection.**
Report §3 step 3 names negation detection as part of extraction. Current: **absent everywhere** — `Entity` (`apps/nlp/src/nlp/schemas/common.py:18-37`) has no polarity/certainty field; `blaze999/Medical-NER` labels carry none; "no chest pain" today yields a positive `SIGN_SYMPTOM` entity that flows into NER priors, entity-faithfulness scoring, and concept-F1. This silently corrupts both notes and eval. **Recommendation: add assertion classification (NegEx/ConText-style rules as a floor, or a small clinical assertion model) in `apps/nlp`, carry polarity through `NamedEntity` (additive column) and into the sensors.** Size M.

**G5 — Guideline corpus + enable retrieval.**
Report's strongest independent evidence: RAG grounding 43→99 % (Kresevic, npj 2024), 57→84 % (Ferber, NEJM AI 2024). Current: the full hybrid-RAG + StrictCitations + citation-verify machinery exists and is OFF with an empty corpus; TASK-330 §2.6 already resolved licensing (PubMed/MEDLINE, PMC-OA, CDC, ICD-11 usable; UpToDate/StatPearls not). **Recommendation: ingest a licensed self-hosted guideline corpus (per specialty of the pilot departments), enable `HARNESS_RETRIEVAL_ENABLED` on the workstation tier, and build the retrieval golden set alongside G1.** Size M.

**G6 — Segment-level transcript + per-sentence evidence links.**
Report §3: evidence linking is "non-negotiable"; HealthScribe attaches EvidenceLinks per sentence; Abridge click-to-hear. Current: STT emits utterances with timestamps, but ingest flattens to one text blob and drops the DTO's `metadata` (word timestamps, confidence) on the floor (`packages/applications/src/services/stt/internal/{sttInternal.service.ts,dto/internal.request.ts}`); `NamedEntity` char-offsets are the only span link; no speaker labels surface. **Recommendation: persist utterance-level segments (id, t0/t1, speaker, text) alongside the blob; have generation cite segment ids (same StrictCitations trick already proven for RAG chunks — hallucinated ids can't survive); render click-to-source in the console. This also gives the atomic-fact and groundedness sensors aligned spans for free.** Size L (schema + ingest + prompt + UI).

**G7 — Terminology linking beyond the 30-concept dict.**
Current linker is precision-first by design (100 % precision, 82 % eligible coverage) but will not scale coverage. **Recommendation: keep the deterministic dict as tier-1, add a self-hosted MedCAT (UMLS license permitting) or SciSpacy+UMLS tier-2 behind the same `link()` contract (the docstring already frames this), gated on G1's labelled sample for precision regression.** Size M–L.

**G8 — Grammar-constrained decoding + JSON auto-repair.**
Report §1: validate structured output between steps. Current: `response_format` is passed through to the engine (suppressed entirely for Ollama → regex parser); no `outlines`/`guided_json`/GBNF anywhere; no detect-and-retry on parse failure (live-doc silently carries the prior note forward, `live-documentation.service.ts:580-593`). **Recommendation: on vLLM (see §7) use `guided_json` for SOAP/judge calls; add one bounded corrective retry wired to the already-seeded `CORRECTIVE_RETRY` template.** Size S–M.

**G9 — ASR second-pass correction (conditional).**
Report §5: LLM second-pass correction ≈ 28 % additional WER cut on noisy domain audio. Current measured WER (0.033–0.066 on clean fixtures) leaves little headroom, but real clinic audio will be noisier. **Recommendation: defer until TASK-470's scorecard is re-run on real-clinic captures; if medical WER > ~0.08 there, add a batch-path LLM correction pass (cheap on the finalize tier).** Size M, evidence-gated.

### 4.B Performance

**P1 — Prompt/prefix caching (the largest untouched lever).**
Report §4: up to 90 % cost / 85 % latency on cached reads; static prefix (system, templates, few-shot, guidelines) + dynamic suffix (transcript). Current: nothing, anywhere; and the live-doc user prompt is ordered *[mutating note] + [new delta]* — every flush invalidates the whole prefix. **Recommendation: (a) reorder live-doc prompting to *[static system] + [append-only transcript-so-far] + [note-so-far] + [delta instruction]* so the growing transcript becomes a stable KV prefix; (b) serve the local models on an engine with automatic prefix caching (vLLM) and verify hit-rate in metrics; (c) the same restructure applies to the harness regen loop (identical transcript+RAG block re-sent per iteration — currently re-prefilled every time).** Size M, no accuracy risk, benefits every tier including CPU-bound LM Studio dev.

**P2 — Commit latency: stage the streaming transducer.**
Current committed-text p50 4.6–5.8 s (TASK-470/487 scorecard; tentative-tail render already masks it visually). TASK-472 verdict: conditional GO on Parakeet cache-aware streaming (English, opt-in); TASK-505 already shipped the `PARAKEET_CPP` engine (nemotron-3.5-asr-streaming). **Recommendation: stage the ggml binding + weights on the GPU tier, run the TASK-470 gate, target sub-1.5 s commit p50 on English pipelines; keep faster-whisper default for Malayalam (no streaming-native transducer covers it — TASK-472 NO-GO).** Size M (staging + measurement, code exists).

**P3 — Two-tier model routing (live small / finalize large).**
Report §2 routing + §2 model-tiering. Current: one static model for both live flushes and harness finalization per tenant. The workstation tier (§7.B) fits both a fast live model and a heavyweight finalize model. **Recommendation: extend `AiTaskDefault` with `smr.live` / `smr.finalize` task keys (finishing the documented HarnessPolicy→AiTaskDefault migration), point live-doc at the small model and the harness generate at the large one. Optional later: complexity-based routing (encounter length/specialty) — only with G1 measurement.** Size M.

**P4 — Enable optimistic delivery (perceived latency).**
Implemented, replay-tested, retraction-hardened (TASK-355/458/481) — default OFF. Flipping it moves clinician-visible draft delivery from after-the-inferential-pass (up to 900 s budget) to after-generate, with assurance backfill. **Recommendation: enable on the pilot tenant once the gate telemetry (edit-burden route, §6 D3) is observable.** Size S.

**P5 — Token accounting + budget caps.**
No tokenizer, no per-run token/cost budget (report §1: budget caps prevent runaway loops; needed for any cloud posture). **Recommendation: add tiktoken/HF-tokenizer counting at the SMR boundary, per-workflow token accumulator + cap, and a $-cost metric (price table per model) — prerequisite for scenario C.** Size S–M.

**P6 — Sectioned generation (conditional).**
Report: sectioning cuts latency and improved per-section quality in ACI-Bench baselines, *"only where accuracy justifies latency/cost."* Current single-shot is simpler and cache-friendlier. **Recommendation: hold until P1–P3 land; then A/B per-section fan-out (4 parallel SMR calls in the harness generate activity) on the finalize path only, judged by the harness eval.** Size M, evidence-gated.

### 4.C Evaluation & observability

**E1 — Wire the eval gates into CI** — `harness.eval.ci` (PDSQI/faithfulness/ICC) and the promptfoo output-contract check are documented as release-blocking but exist only as manual commands (grep of `.gitlab/` confirms). Size S.
**E2 — Expose edit-burden telemetry** — implemented (TASK-482) with DTOs, never routed (`harness-admin.controller.ts` calls only `listAuditEvents`/`listEvalRuns`/`getEvalRun`/`gateQueue`); the report calls clinician-edit burden the top real-world proxy. Add the route + a Grafana panel; feed `deferralRate`/`editDistanceRatio`/`timeToSign` into the weekly quality review. Size S.
**E3 — Harness observability** — no Prometheus metrics/dashboard for the harness (SMR has both); OTel off by default. Add stage-latency histograms (per activity), regen-rate, gate-decision counters, sensor-score distributions. Size S–M.
**E4 — Public-benchmark anchoring** — run the existing eval stack over ACI-Bench/PriMock57 (PHI-free) once, for external validity of MEDCON/PDSQI numbers; not a substitute for G1. Size S–M.
**E5 — Clinician-edit learning loop (beyond telemetry)** — report §2 cites the agent-edits learning loop (arXiv 2510.06677); HOPE's DNA style processor learns *style* only, and gate edits are "persisted into the WORM audit but unread" (S3-F7). Mine approved-vs-delivered diffs into (a) a growing regression corpus for the eval harness and (b) retrieved few-shot exemplars per department. Explicitly *not* fine-tuning. Size M.

### 4.D Regulatory

**R1 — CDS posture for diagnosis suggestions.** `POST /diagnosis/suggestions` (playground-only today) returns bare label+confidence (`min_confidence=0.1`), no intended-use framing, no disclaimer, no accept/override audit. Under FDA CDS 2026 final guidance (report §7) a real-time DDx surface likely constitutes a device; CDSCO's non-device line (TASK-330 §2.8) is similarly fact-specific. **Recommendation: keep it out of the consultation flow (status quo) and add a code-level guard + intended-use doc; if it is ever surfaced clinically, it needs citations, independent-review framing, and its own regulatory ticket.** Size S now.
**R2 — EHR/FHIR export** — no FHIR/HL7 anywhere; SMR `json_schema` support is built-but-unused for it (research doc 04's headline). Not urgent until an EHR integration is on the roadmap; when it is, the report's MCP/FHIR terminology-server ecosystem becomes relevant. Size L, deferred.

---

## 5. What NOT to do (report-aligned non-goals)

- No multi-agent swarm / orchestrator-workers / A2A — the report's token-multiplier and traceability arguments; current fixed pipeline is the recommended shape.
- No MCP integration for its own sake — in-process tools keep the PHI surface minimal; revisit only with EHR export (R2).
- No ROUGE/BERTScore adoption — deliberate, correct omission.
- No `continue_as_new` — confirmed unnecessary (~7 years to event cap).
- No cloud ASR migration for accuracy — measured self-hosted medical WER (0.033–0.066) already beats the report's vendor-quoted medical WERs; cloud ASR would trade the PHI posture for nothing.

---

## 6. Defects found during this review (fix regardless of roadmap)

| # | Defect | Evidence | Size |
|---|---|---|---|
| D1 | **Prod harness image ships without `rag`/`guardrails`/`atomic-fact` extras while `qdrant_client` is imported unconditionally at module top level** (`guides/retrieval/{qdrant_store.py:30,retriever.py:25,sparse.py:20}` → `knowledge.py`/`activities.py` → app/worker construction). The shipped `Dockerfile` (`uv sync --frozen --package harness --no-dev`, no `--extra`) therefore either crashes at import or silently lacks Presidio PHI redaction + MiniCheck in prod. CI's own comment confirms the collection-time dependency. | harness map §4/§Notable Absences | S — add extras to the Dockerfile (or lazy-import behind the flags) + an import-smoke test of the prod image |
| D2 | Orphaned `context_items` Qdrant collection (1536-dim, OpenAI-sized) + `ContextItem.qdrantSynced` columns with **no reader or writer** anywhere | E2E map §B | S — decide: delete provisioning or implement semantic search |
| D3 | Edit-burden service unreachable (no route) | `harness-admin.controller.ts:60` vs zero `getEditBurden` call sites | S (=E2) |
| D4 | Eval CI gates not in `.gitlab/` despite "release-blocking" docs | harness map §Notable Absences | S (=E1) |
| D5 | `apps/harness/README.md` says "Phase-0 scaffold" — seven shipped eras later | README vs code | S |
| D6 | Dead config: `AzureOpenAIConfig.deployment_name`, `CircuitBreakerConfig.{half_open_max_calls,reset_timeout_s,count_rate_limits}` (SMR); dead `use_gpu` fields in all three NLP services; Granite BYOC content-safety path implemented+tested but unreachable in guardrail | SMR map §1/§10; NLP map §B7/§A1 | S |
| D7 | Browser `med-ner` default preset is the **generic** `Xenova/bert-base-NER`, not a medical model; `KnowledgePipeline` carries a stale "no backend NER" comment (gateway `/ai/nlp/entities` now exists) | NLP map §M | S |
| D8 | `CreateTranscriptRequest.metadata` (word timestamps) accepted and silently dropped | `internal.request.ts:28-33` | folds into G6 |

---

## 7. Deployment scenarios — model placement & enablement matrix

Model footprints (approximate, quantized where noted): whisper-large-v3 CT2 int8 ~2.5–3 GB · large-v3-turbo ~1.5–2 GB · Parakeet/nemotron streaming ggml ~1–2 GB · Sortformer streaming ~0.5 GB · pyannote seg-3.0 + ECAPA/wespeaker < 0.5 GB · bge-m3 ~1.2 GB · bge-reranker-v2-m3 (TEI) ~1.2 GB · Granite Guardian 4.1-8B q4 ~5–6 GB · MiniCheck-Flan-T5-L Q6 ~0.7 GB (CPU-proven, 523 docs/min) · gemma-4-e4b ~4 GB · Qwen3-8B AWQ ~6 GB · Qwen3-14B AWQ ~10 GB · GPT-OSS-20B MXFP4 ~13 GB · MedGemma-27B AWQ ~16–17 GB / FP8 ~28 GB · Qwen3-32B AWQ ~19 GB · Llama-3.3-70B AWQ ~40 GB · GPT-OSS-120B MXFP4 ~63 GB. GLiNER-guard (ONNX), bm25, Medical-NER, symps-bert, SymSpell, Kokoro TTS: CPU-fine.

**Common to every tier**: replace ad-hoc LM Studio serving with **vLLM** (or llama.cpp-server where noted) for production — continuous batching, automatic prefix caching (P1), `guided_json` (G8), FP8 KV cache. Keep MiniCheck + GLiNER + NER + bm25 on CPU (they are designed for it; 64–128 vCPU is ample). Enable claim-check S3 (MinIO present in every deployment).

### 7.A Edge server — 64 vCPU / 128 GB / 1× RTX 5090 32 GB (alt: 2× A2000 Ada 16 GB)

| GPU budget (5090, 32 GB) | Allocation |
|---|---|
| Speech | turbo CT2 int8 (~2 GB) **+** Parakeet streaming (~2 GB, English pipelines) + Sortformer (~0.5 GB) + endpointer (~0.3 GB) ≈ **5 GB** |
| Safety | Granite Guardian 8B q4 ≈ **5.5 GB** |
| RAG | bge-m3 + reranker ≈ **2.5 GB** |
| Generation + judge (shared) | **~18 GB free** → *quality-first*: MedGemma-27B AWQ (~16.5 GB, FP8 KV, 8–16 k ctx, 1–2 concurrent) · *throughput-first*: Qwen3-14B AWQ or GPT-OSS-20B (~10–13 GB, 3–4 concurrent, roomier KV) |

- Realistic load: **2–4 concurrent live consultations** + 1–2 harness finalizations queued (the harness gate is asynchronous by design — queueing finalize work is acceptable).
- Enable: Parakeet (P2), Sortformer + TASK-489 labels, groundedness gate (CPU MiniCheck), atomic-fact w/ MiniCheck entailer, warm-start, NER priors, optimistic delivery, retrieval (small corpus), prefix caching (P1).
- **2× A2000 Ada 16 GB variant**: GPU0 = speech + RAG (~7.5 GB) + Granite q4 (~5.5 GB); GPU1 = generation 8–9B q4 (Qwen3-8B AWQ / MedGemma-4B-it) with generous KV. Accept the smaller-model quality tier and lean harder on the sensor gate + critique-fed regen (G3) to recover accuracy; judge shares GPU1's model. This variant is serviceable but the 5090 is the better buy — a single 27B-class finalize model is the biggest single accuracy differentiator between the two.

### 7.B Workstation — 128 vCPU / 256 GB / RTX PRO 6000-class

Assuming RTX PRO 6000 Blackwell **96 GB** (if the card is a 48 GB RTX 6000 Ada, use tier-A's single-model plan with MedGemma-27B AWQ and skip the second tier):

| GPU budget (96 GB) | Allocation |
|---|---|
| Speech + safety + RAG stack (as tier A) | ≈ **13 GB** |
| **Live tier** model (every flush) | gemma-4-e4b / Qwen3-8B AWQ ≈ **6 GB** |
| **Finalize tier** model (harness generate + judges) | MedGemma-27B FP8 (~28 GB) **or** GPT-OSS-120B MXFP4 (~63 GB) for max reasoning · Llama-3.3-70B AWQ (~40 GB) as the middle option |
| KV + prefix cache headroom | remainder (≥ 15 GB) → **8–16 concurrent sessions** with prefix caching |

- This tier is what makes **P3 two-tier routing** real: live flushes on the small model (sub-second TTFT with cached prefix), harness finalization + groundedness/citation judges on the large model.
- Also enable: GPU MiniCheck batching, speculative decoding on the finalize model (draft = the live model), full eval-harness runs (PDSQI self-consistency K=3 becomes affordable), Sortformer live-validation (the AC-1/AC-5 captures TASK-475 is blocked on), TASK-473's neural endpointer.
- 128 vCPU / 256 GB comfortably hosts everything CPU-side plus Postgres/Redis/Qdrant/MinIO/Temporal for a single-box pilot deployment.

### 7.C Cloud

Three postures, in order of consistency with the platform's own guardrails (SOTA-Track hard rule: *"no cloud PHI"*; `PhiConfig.cloud_egress_providers=[azure,bedrock]` fail-closed):

1. **Cloud GPUs, self-hosted stack (recommended default)** — rent L40S 48 GB (≈ tier-A+) or A100/H100 80 GB (≈ tier-B) in a VPC; identical images, identical posture, elastic concurrency. India deployments: DPDP/ABDM data-residency favors in-region GPU instances. This is "cloud" without a policy change.
2. **Hybrid BAA/DPDP** — ASR + PHI redaction on-prem (Presidio must actually ship: D1), redacted/de-identified text to cloud LLMs via the **already-implemented** Azure OpenAI (`gpt-5-mini` default) / Bedrock providers. Requires an explicit governance decision to relax the PHI egress guard per provider + BAA/DPA; add token-cost accounting first (P5). Highest accuracy ceiling (frontier models, provider-side prompt caching) at the cost of the strict posture.
3. **Fully managed** (HealthScribe-style ASR + cloud LLM) — fastest to stand up, weakest data posture, and the measured evidence says cloud ASR gains ≈ nothing over the current stack (§5). Not recommended given the existing self-hosted quality.

---

## 8. Suggested ticket allocation (SUPERSEDED 2026-07-19)

> **This table is superseded by the [TASK-508 Agentic SOTA Program](../TASK-508-Agentic-SOTA-Program/README.md)** (opened as TASK-507, renumbered when that number was already claimed), which folds these gaps into phases 0–7 (child tickets TASK-508–522) and adds the owner's three new requirement areas (generation metrics, ordered session trajectory, global-admin agentic control plane) plus the dev/prod engine split (LM Studio/Ollama dev · vLLM/llama.cpp prod). The gap IDs (G/P/E/R/D) referenced by the program remain defined by this document. Execution audit: [AUDIT-2026-07-19.md](../TASK-508-Agentic-SOTA-Program/AUDIT-2026-07-19.md). Original table kept for traceability:

| # | Title | Gap | Size | Gate |
|---|---|---|---|---|
| TASK-507 | Prod-image extras + import-smoke test (D1) + dead-config sweep (D6) | D1/D6 | S | CI green on prod-image import |
| TASK-508 | Prefix-cache program: cache-friendly prompt reorder (live-doc + harness) + vLLM serving + hit-rate metric | P1 | M | TTFT p50 before/after on tier hardware |
| TASK-509 | Critique-informed regen (sensor findings → corrective regen prompt) | G3 | S–M | regen-success rate on harness eval |
| TASK-510 | Clinical golden set program kickoff (assign SME owner, run `clinical_v1_spec`) | G1 | S eng + program | spec §11 exit criteria |
| TASK-511 | Negation/assertion detection in `apps/nlp` + polarity through `NamedEntity`/sensors | G4 | M | labelled-sample precision; concept-F1 unchanged-or-up |
| TASK-512 | Segment-level transcript persistence + per-sentence evidence links + click-to-source | G6/D8 | L | evidence-link coverage metric |
| TASK-513 | Two-tier routing: `smr.live`/`smr.finalize` AiTaskDefault keys (+ HarnessPolicy migration) | P3 | M | tier-B hardware |
| TASK-514 | Guideline corpus ingestion + retrieval enablement + retrieval golden set | G5 | M | recall@k on curated set |
| TASK-515 | Eval/observability wiring: CI gates, edit-burden route, harness Prometheus/Grafana, OTel-on | E1–E3/D3–D4 | M | dashboards live |
| TASK-516 | Token accounting + per-run budget caps + $-cost metric | P5 | S–M | precedes any cloud posture |
| TASK-517 | Hardware enablement matrix execution (per §7 tier chosen) — model staging + flag flips + scorecard re-runs | G2/P2/P4 | M | TASK-470 scorecard + harness eval per flip |
| TASK-518 | Grammar-constrained decoding + bounded JSON auto-repair | G8 | S–M | parse-failure rate → ~0 |
| later | MedCAT/SciSpacy linker tier-2 (G7) · sectioned finalize A/B (P6) · ASR second-pass (G9) · edit-learning loop (E5) · public-benchmark anchor (E4) · CDS framing guard (R1) · FHIR export (R2) | — | — | evidence-gated |

Sequencing: **507 (defect) → 508+509+511 in parallel (independent surfaces) → 510 kicked off immediately (long-pole program) → 517 as soon as the hardware tier is chosen → 512/513/514 on the tier → the rest evidence-gated.**

---

## 9. Caveats

- Model footprint numbers in §7 are planning approximations (quantization, KV, context length move them ±20 %); validate with the actual serving engine before purchase decisions.
- The compass report's strongest vendor numbers (Abridge 97 % confabulation catch, AssemblyAI MER table) are non-peer-reviewed vendor benchmarks — the report itself says so; HOPE's own measured numbers (TASK-470 scorecard, MiniCheck calibration) are the trustworthy baseline here.
- "A6000 PRO" was read as RTX PRO 6000 Blackwell 96 GB; §7.B notes the 48 GB fallback plan if it is an RTX 6000 Ada.
- File:line references reflect `fix/2605-review` on 2026-07-18 and will drift.
- This review deliberately does not re-litigate the TASK-448 findings or the executed TASK-470–483 track; it layers the external report's *additional* asks onto that baseline.
