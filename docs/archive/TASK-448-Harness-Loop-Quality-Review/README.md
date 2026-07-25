# TASK-448 — Harness-Loop Quality Review (Realtime Transcription · NER · Summarization)

- **Status**: Completed (review) — 2026-07-09
- **Type**: Quality audit / architecture review + SOTA research (no source code changed)
- **Owner surfaces**: `apps/harness` · `apps/stt` · `apps/api` · `packages/applications` (live-documentation, streaming, consultation) · `packages/agentic-sdk-v2` · `packages/med-ner` · `apps/nlp` · `apps/admin-console` (playground)
- **Related**: TASK-330/345/348/354/355/357/358/359/363 (harness lineage, archived) · TASK-351 (realtime transcription performance) · TASK-446 (playground guardrails/NER gateway) · TASK-442 (playground impersonation canvas)
- **Method**: 10 parallel opus-4.8/xhigh subagents (6 code reviewers, 3 SOTA researchers, 1 adversarial verifier) orchestrated in one deterministic workflow. ~1.76M subagent tokens, 258 tool calls, 0 agent failures.

> **Scope**: This is a review-only ticket. Nothing in the codebase was modified. Every defect below becomes a candidate follow-up ticket in the roadmap; none is executed here.

## Requirement Analysis

Review the quality of the implemented "harness loop" for realtime consultation transcription, NER, and summarization against latest (2024–2026) best practices for **performance, quality, scalability, and maintainability**, backed by **deep SOTA research on realtime harness loops**, and deliver a verified findings register plus a prioritized remediation roadmap.

### Acceptance criteria

- [x] All four subsystems reviewed with `file:line` evidence quotes (A harness · B STT streaming · C gateway/live-doc · D SDK/playground) — 33 findings kept, every one carrying a verbatim code quote.
- [x] SOTA research (2024–2026) across streaming ASR, clinical NER/entity-linking, incremental summarization, and durable orchestration — 24 research findings, every claim carrying a named, dated citation.
- [x] Every Critical/High finding adversarially verified against the code — 11/13 verified by the batched skeptic; the 2 unverified are reviewer-confidence-Medium and marked PLAUSIBLE. The Critical + top-4 Highs additionally re-read by hand.
- [x] Findings joined to SOTA gaps; prioritized P0/P1/P2 remediation roadmap with effort estimates.
- [x] Zero source-code changes (review only) — `git status` shows only this ticket doc added.

### Verdict (headline)

The harness loop is **architecturally sound and, in several respects, ahead of the field** — the draft-then-finalize dual-tier shape, the bounded sensor-gated regen loop, the PDSQI-9 + calibration + judge-parity eval assets, the replay-safe Temporal versioning, and the 404-over-403 tenancy posture on HTTP/SSE are all SOTA-aligned. The problems are **not in the design; they are in the seams and the edges**: one cross-tenant PHI-egress hole on the WebSocket boundary, a family of silent data-loss paths under realistic network/Redis/worker failures (all traceable to the same at-most-once transport with no consumer groups), a broken live-NER field contract, and an ASR/NER **stack that is a generation behind** (2023 commit policy, generic non-clinical NER models with unpopulated ontology columns). **1 Critical, 11 High, 18 Medium, 3 Low.**

## Current State Evaluation (verified 2026-07-09)

### Architecture as-built

Two transcript pipelines run over each consultation and **must not be conflated** — conflating them was the single biggest review-error risk and was pre-empted in every agent prompt:

```
REALTIME LOOP (best-effort, clinician-facing live surface)
  mic ─▶ [SDK: RNNoise ─▶ Silero VAD ─▶ STT local-Whisper | backend-WS]
      ─▶ WS /ws/stt/stream (single-use ticket)
      ─▶ XADD stt:audio:{sid}  ──(plain XREAD, NO consumer groups)──▶ STT SessionManager
      ─▶ Silero VAD + LocalAgreement-2 commit ─▶ StreamingInferenceWorker (faster-whisper)
      ─▶ XADD stt:result:{sid} ──▶ ┬─▶ SttWsGateway ─▶ WS captions (partials dropped @512KiB, finals queued 200)
                                    └─▶ LiveDocumentationService ─▶ debounce(3seg/5s)
                                          ─▶ SMR /generate (prior SOAP + ≤12k delta) ─▶ NLP /classify/tokens OVER THE NOTE
                                          ─▶ Redis pub/sub ─▶ SSE /consultations/:id/live-summary/stream
  finalize ─▶ WAV upload ─▶ internal callback ─▶ persist TRANSCRIPT ContextItem ──▶ fires TranscriptionCreated

DURABLE HARNESS (post-hoc, system-of-record, triggered ONCE on the full transcript)
  TranscriptionCreated ─▶ HarnessDocWorkflow (Temporal):
    fetch_policy ─▶ extract_entities (NLP NER over TRANSCRIPT) ─▶ persist NamedEntity
      ─▶ retrieve_context (flag-gated RAG)
      ─▶ bounded regen loop [assemble ─▶ SMR generate ─▶ computational sensors ─▶ aggregate; REGEN < max_regen=2]
      ─▶ inferential sensors (groundedness / citation-verify / Granite-Guardian safety)
      ─▶ [optional] optimistic two-phase delivery (flag + workflow.patched gated)
      ─▶ clinician gate (approval/edit signals, 86400s SLA + 43200s escalation, re-escalates indefinitely)
      ─▶ record_gate_decision (WORM audit)
```

**Authority**: the durable clinical artifacts are the persisted `TRANSCRIPT`/summary/`NamedEntity` rows and the harness-gated draft. The live-doc SOAP note and its entities are ephemeral UX and are never what the clinician signs. Guardrails are **not** in the live loop — only SMR input pre-validation (fail-open) + the harness post-draft Granite Guardian sensor.

### Findings register

33 findings survived the evidence gate (0 dropped for missing quotes) and cross-reviewer dedup (2 duplicates folded: C3-04→C3-01, C6-05→C6-02). Verdict column: **✓C** confirmed by adversarial verifier · **✓H** additionally re-read by hand during synthesis · **~P** partially-confirmed/severity-adjusted · **? PLAUSIBLE** reviewer-confidence-Medium, not reached by the verifier.

| ID | Subsystem | Category | Sev | Conf | Location | Verdict | One-line |
|---|---|---|---|---|---|---|---|
| **C4-01** | gateway | security-tenancy | **Critical** | High | [auth.controller.ts:837](apps/api/src/modules/auth/auth.controller.ts) · [stt-ws.gateway.ts:242](apps/api/src/modules/streaming/stt-ws.gateway.ts) | ✓C ✓H | `/auth/stream-ticket` mints `stt_session:*` tickets with **no ownership check**; the WS gateway never verifies ticket-tenant vs session-tenant → **cross-tenant live-transcript PHI egress** keyed on a loggable sessionId. |
| **C1-01** | harness | patient-safety | High | Med | [workflows.py:662](apps/harness/src/harness/temporal/workflows.py) | ✓C ✓H | Optimistic path emits "Draft ready for review" + closes the SSE **before** the safety/groundedness pass; sign-off is reachable in that window ([summary.service.ts:456](apps/api/…)), so a later `FLAG` records as `SIGNED`. |
| **C6-01** | sdk-playground | patient-safety | High | High | [use-live-stt-session.ts:322](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts) | ✓C | Client 1 MiB `bufferedAmount` watermark **silently drops outbound audio** in both stacks; dropped PCM never reaches the durable transcript, no clinician-visible signal. |
| **C2-06** | stt-session | patient-safety | High | Med | [preprocessor.py:295](apps/stt/src/stt/streaming/preprocessor.py) | ? PLAUSIBLE | Isolated short utterances below `min_speech_frames` never confirm VAD onset and are dropped entirely (a crisp "No." to "Any allergies?"). |
| **C2-01** | stt-session | correctness | High | High | [commit_policy.py:74](apps/stt/src/stt/streaming/commit_policy.py) | ✓C | LocalAgreement-2 keeps the committed **count** monotonic but re-slices the **surface** from the latest hypothesis → a "stable" allergy negation can silently flip ("no known"→"known"). |
| **C2-03** | stt-session | data-loss | High | High | [session_manager.py:1942](apps/stt/src/stt/streaming/session_manager.py) | ✓C | Transcript-persist callback failure is swallowed as "non-fatal" with no retry/outbox/DLQ → durable transcript **and** the harness trigger permanently lost on a transient gateway blip. |
| **C3-01** | seam | reliability-durability | High | High | [streamingAudioBridge.service.ts:311](packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts) | ✓C | Resume/replay is architecturally defeated: reader always re-reads `stt:result` from `0-0`, per-connection seq resets, disconnect finalizes the upstream session → reconnect **floods duplicates then goes silent**. |
| **C3-02** | seam | data-loss | High | High | [stt-ws.gateway.ts:581](apps/api/src/modules/streaming/stt-ws.gateway.ts) | ✓C ✓H | Fire-and-forget audio `XADD`, no consumer groups, no audio-direction resume → a Redis blip permanently drops clinical speech from the transcript with only a generic `BRIDGE_ERROR`. |
| **C5-01** | live-doc-ner | nlp-summary-quality | High | High | [live-documentation.service.ts:825](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts) | ✓C ✓H | Live NLP mapping reads `e.value`/`e.type`/`e.start` but the NLP contract serializes `text`/`entity_type`/`position` → **every live entity is blank UNKNOWN**; the colocated test mocks the buggy shape so it stays green. |
| **C5-02** | seam | nlp-summary-quality | High | High | [token_classifier.py:86](apps/nlp/src/nlp/services/token_classifier.py) | ✓C ✓H | `aggregation_strategy` is accepted but ignored → HF pipeline runs at `NONE` → **medications persist as subword `##` fragments** with BIO-prefixed classNames into `NamedEntity` and harness prompts. |
| **C1-02** | harness | reliability-durability | High | Med | [workflows.py:849](apps/harness/src/harness/temporal/workflows.py) | ✓C | No `continue_as_new`; the gate re-escalates indefinitely and the **edit-driven assurance re-run is uncapped** → unbounded LLM spend + event-history growth on one execution. |
| **C2-02** | stt-session | data-loss | High | Med | [session_manager.py:2392](apps/stt/src/stt/streaming/session_manager.py) | ? PLAUSIBLE | Reaper's 60 s idle timeout (using `streaming_session_timeout_s`, not the dead `streaming_audio_idle_timeout_s=300`) finalizes live consultations on a >60 s stall, dropping all post-stall audio. |
| C1-03 | seam | reliability-durability | Med | Med | [api_client.py:133](apps/harness/src/harness/services/api_client.py) | — | Harness callbacks carry no idempotency key → a retry after a lost ack can double-write the WORM audit / draft. |
| C1-04 | harness | reliability-durability | Med | High | [smr_client.py:63](apps/harness/src/harness/services/smr_client.py) | — | Non-idempotent SMR `generate` wrapped in a retry policy → lost response re-invokes the LLM (double spend, divergent completion). |
| C1-05 | harness | observability | Med | High | [activities.py:732](apps/harness/src/harness/temporal/activities.py) | — | `escalate_gate` is a no-op log: SLA breach notifies no one and records nothing to apps/api. |
| C1-06 | harness | correctness | Med | Med | [workflows.py:272](apps/harness/src/harness/temporal/workflows.py) | — | Failed `fetch_policy` silently falls back to code-default thresholds **without** setting `reduced_assurance` → a stricter tenant policy is silently relaxed. |
| C2-05 | stt-session | data-loss | Med | Med | [session_manager.py:1398](apps/stt/src/stt/streaming/session_manager.py) | — | Finalize inference-drain has a bounded 60 s timeout → the tail utterance (closing med changes) can be dropped on GPU backlog. |
| C2-07 | stt-session | reliability-durability | Med | Med | [session_manager.py:1956](apps/stt/src/stt/streaming/session_manager.py) | — | No per-session finalize lock → reaper + final-frame + control-FINALIZE can finalize concurrently (duplicate Media rows, double upload). |
| C3-03 | gateway | data-loss | Med | High | [stt-ws.gateway.ts:394](apps/api/src/modules/streaming/stt-ws.gateway.ts) | — | 200-final egress queue drops the **oldest** final permanently; the "resume buffer still holds it" mitigation comment is false. |
| C3-05 | stt-dataplane | scalability | Med | High | [redis_streams.py:220](apps/stt/src/stt/streaming/redis_streams.py) | — | `stt:result` is unbounded during an active session (no MAXLEN, only a post-close TTL) → memory growth + O(n) re-read amplifies C3-01. |
| C4-02 | gateway | security-tenancy | Med | High | [ai-inference.client.ts:26](apps/api/src/modules/ai-inference/ai-inference.client.ts) | — | NLP/Guardrail proxy sends PHI with **no** auth header and SMR is fail-open, while STT-internal + harness are fail-closed — asymmetric defense-in-depth. |
| C4-03 | gateway | security-tenancy | Med | Med | [tenant-owned-resource-sse.guard.ts:32](apps/api/src/common/tenant-owned-resource-sse.guard.ts) | — | SSE access checked once pre-stream only → a revoked/logged-out/tenant-switched user keeps receiving live-summary PHI for the stream's life. |
| C4-04 | gateway | correctness | Med | High | [smr-proxy.controller.ts:222](apps/api/src/modules/streaming/smr-proxy.controller.ts) | — | `withRetry` re-POSTs `/generate` on mid-flight transport errors with no idempotency dedup → duplicate billable generation + divergent drafts. |
| C4-05 | gateway | security-tenancy | Low | Med | [smr-proxy.controller.ts:204](apps/api/src/modules/streaming/smr-proxy.controller.ts) | — | SMR proxy forwards upstream error bodies verbatim → prompt/PHI or internal detail can echo into client telemetry. |
| C5-03 | seam | doc-drift | Med | High | [consultation.prisma:311](packages/database/src/prisma/db_main/consultation.prisma) | — | `NamedEntity` ontology columns (umls/snomed/rxnorm/icd/loinc) are **read** by prompt-assembly + faithfulness scoring but **never written** by any path — coded lists run on empty codes. |
| C5-04 | live-doc-ner | correctness | Med | High | [live-documentation.service.ts:444](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts) | — | Delta-cap truncation keeps the last 12k chars and advances the cursor past the dropped head → oldest content (chief complaint / allergy) permanently absent from the live note. |
| C5-05 | sdk-playground | nlp-summary-quality | Med | High | [KnowledgePipeline.ts:452](packages/agentic-sdk-v2/src/core/KnowledgePipeline.ts) | — | Browser auto-NER mints a fresh `crypto.randomUUID` per extraction → store dedup never matches → repeated entities accumulate with per-segment (meaningless) offsets. |
| C5-06 | live-doc-ner | correctness | Med | High | [live-documentation.service.ts:675](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts) | — | Claim-only owner lock (unconditional SET, no NX) → two instances run one consultation's live-doc → duplicate SMR spend + duplicate persisted `PRE_SUMMARY` rows. |
| C6-02 | sdk-playground | observability | Med | High | [use-live-stt-session.ts:289](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts) | — | Direct hook stays stuck on status `reconnecting` after a successful auto-reconnect → clinician assumes it's broken and restarts. |
| C6-03 | sdk-playground | reliability-durability | Med | High | [use-live-stt-session.ts:293](apps/admin-console/src/features/playground-live-transcription/api/use-live-stt-session.ts) | — | Terminal reconnect failure sets `error` without releasing the mic or DELETEing the gateway session → leaked mic + held concurrency slot. |
| C6-04 | seam | correctness | Med | Med | [SttWebSocketClient.ts:623](packages/agentic-sdk-v2/src/core/SttWebSocketClient.ts) | — | `normalizeTranscript` drops the whole transcript on any missing/mistyped field (numeric `is_final` unmatched); no shared client/server contract type (`dts:false`). |
| C2-04 | stt-session | correctness | Low | High | [session_manager.py:1671](apps/stt/src/stt/streaming/session_manager.py) | ~P | PAUSE/RESUME are no-op logs — **downgraded from High**: no current client emits a backend PAUSE (only `finalize`), and the SDK `pause()` halts audio at the source, so the harm is latent, not active. |
| C3-06 | seam | doc-drift | Low | High | [streamingAudioBridge.service.ts:166](packages/applications/src/services/stt/streaming/streamingAudioBridge.service.ts) | — | Gateway hardcodes `MAXLEN ~10000` while the STT config default is `2000` — two bounds on one key; the config knob does not govern the live path. |

### Per-subsystem state

**A. Harness Temporal workflow — sound core, provisional-delivery + policy-degrade edges.** The regen loop is replay-deterministic (C1 verified no wall-clock/RNG/iteration-order leaks; `patched()` markers are covered on both branches by the replay fixtures). Two real edges: the optimistic path signals "ready" and closes the SSE before the safety pass (**C1-01**, and sign-off is genuinely reachable in that window), and a policy-fetch blip silently downgrades a stricter tenant policy to code defaults without flagging reduced assurance (**C1-06**). Retried non-idempotent activities (SMR generate, WORM callbacks) risk double-spend/double-write (**C1-03/04**); `escalate_gate` is a no-op so an overdue draft parks silently (**C1-05**). `continue_as_new` is genuinely **not required** for this shape (S3 math: ~7 years to the event cap) — but the uncapped edit-driven assurance re-run and the absent terminal-abandon path are real (**C1-02**). **The harness sensor placement is correct and latency-appropriate — no latency finding was filed against it.**

**B. STT session/compute — correct steady state, lossy edges.** The reaper is a genuine safety net and steady-state finalize is sound. The edges bite: the "stable" caption surface can silently contradict itself (**C2-01**, allergy-negation flip), a swallowed persist callback loses the whole transcript (**C2-03**), the 60 s reaper finalizes on a stall (**C2-02**), the bounded finalize-drain drops the tail utterance (**C2-05**), short crisp words fall below VAD onset (**C2-06**), and concurrent finalize entrants duplicate media (**C2-07**). Diarization/speaker attribution lives outside the reviewed files and was flagged **unassessed** — the realtime path currently attaches **no** speaker labels (see S1).

**C. Gateway + live documentation — the highest-value cluster.** The Critical PHI-egress hole is here (**C4-01**). The live-doc NER surface is functionally broken two ways (**C5-01** blank entities, **C5-02** subword fragments), it extracts over the generated note not the transcript (laundering hallucinations, S2-04), truncation drops the head of long notes (**C5-04**), the owner lock doesn't exclude (**C5-06**), and the ontology columns everyone reads are never written (**C5-03**). Service-token posture is asymmetric for PHI-bearing internal traffic (**C4-02**), long SSE streams never re-check authz (**C4-03**), and SMR retries can double-generate (**C4-04**). HTTP/SSE tenancy is otherwise well-guarded (404-over-403 consistent across all three consultation streams).

**D. SDK client loop + playground — two divergent stacks, silent failure UX.** Outbound-audio drops are invisible in both stacks (**C6-01**), the direct hook stalls on `reconnecting` after recovery (**C6-02**) and leaks on terminal failure (**C6-03**), transcript normalization is a brittle hand-mirrored contract (**C6-04**), and browser auto-NER churns duplicate entities (**C5-05**). The playground runs two stacks that disagree on failure UX; **summaries bypass the SDK entirely** (BFF hooks), so the SDK summary path is untested against the real backend. **No streaming e2e exists** — the highest-risk untested paths are resume-after-drop, backpressure recovery, and ticket-refresh mid-session.

**Seam (the through-line).** The end-to-end realtime chain provides **exactly-once nowhere**: live captions are at-most-once and degrade to duplicate-then-frozen on reconnect; the durable transcript is at-most-once at ingest with a crash-loss hole. The root cause is one decision — plain `XREAD` with no consumer groups — which C3-01/C3-02/C3-03/C3-05 and S1-DELIVERY all trace back to. The harness and live-doc **both** call SMR + NLP over overlapping content (duplicated compute, divergent artifacts); the live draft is discarded and the harness regenerates cold (see S3-F5).

## SOTA Research & Gap Analysis

24 research findings, all 2024–2026, each joined to a HOPE component. Full citation set in the agent journal; the load-bearing tables and verdicts follow.

### S1 — Streaming ASR, ambient clinical documentation, latency

| Stage | SOTA target (2024–26) | HOPE as-built | Gap | Source |
|---|---|---|---|---|
| First partial word | ~300 ms (AssemblyAI 307 ms P50; Deepgram Nova-3 sub-300 ms) / 500 ms (Kyutai-1b) | faster-whisper partial every **1.0 s** over 8 s tail | ~3–4× slower | AssemblyAI; Deepgram Nova-3; Kyutai STT |
| Stable / non-revisable word | immutable from emission (~300 ms) | LocalAgreement-2 commits after **2 agreeing partials** → ~1–2 s | ~5–7× slower | Whisper-Streaming baseline arXiv:2307.14743; AssemblyAI |
| End-of-turn / final | semantic endpoint, 160–500 ms | Silero VAD fixed silence offset only | no semantic endpointing | AssemblyAI; LiveKit v1; Kyutai VAD |
| Speaker label | frame-level, sub-second | **none in live loop** | capability absent | NVIDIA Streaming Sortformer arXiv:2507.18446 |
| Draft note update | forms continuously, few-second refresh | debounce 3 seg / 5 s + 4 s min-interval | +4–9 s | Abridge |
| Audio → visible stable transcript | <0.5–1 s | ~2–4 s | ~4× | composite |

*Transport hops (WebSocket PCM + two Redis XADDs) are tens of ms — **not** the bottleneck.*

**Delivery semantics** — HOPE's plain-XREAD Redis Streams is **at-most-once** (crash between read and persist loses the frame). It survives today only because the system-of-record is written to Postgres via gateway callbacks, not Redis. **Minimal upgrade (S-effort): convert `stt:audio` + `stt:result` readers to Redis consumer groups (`XREADGROUP` + `XACK` + `XAUTOCLAIM`) on the same Redis** — at-least-once + crash recovery, and a natural single-owner mechanism for the live-doc lock. NATS JetStream is the middle option for durable fan-out; Kafka is overkill for ephemeral audio frames.

**Verdicts**: (a) LocalAgreement-2 is a correct 2023 implementation but **augment now / plan to replace** — drop the 1 s partial cadence and render a tentative tail for a free win; pilot a self-hostable streaming-native transducer (**Kyutai STT** open-weights, or **Parakeet-TDT** via Riva/NeMo) for a 5–8× stable-latency cut without shipping PHI to a cloud vendor. (b) Add **streaming 2-speaker diarization** (Streaming Sortformer) — every comparable ambient scribe emits clinician/patient labels; HOPE emits none. (c) The single biggest latency lever is the **ASR commit policy**, not transport — and fixing it cascades because the live note and NER both consume the transcript. There is **no streaming eval harness** (P50/P99 commit latency, partial-revision rate, medical WER/keyterm recall) to measure any of this.

### S2 — Clinical NER / entity-linking / guardrail placement

| HOPE model / path | SOTA option | Clinical-safety delta | Effort |
|---|---|---|---|
| Browser default `Xenova/bert-base-NER` (CoNLL PER/ORG/LOC) | Clinical/BioClinical ModernBERT, GatorTron (server-side) | Recognizes **zero** clinical types → clinically inert on transcripts | M |
| NLP `classify/tokens` (no linker) | MedCAT v2 / Spark NLP / AWS Comprehend Medical | **No UMLS/SNOMED/RxNorm/ICD/LOINC codes** → columns unpopulated/guessed | L |
| NER over the **generated SOAP note** | Extract-from-source + entity-ground (SPEER) | Summary hallucination (~40–50% base rate) becomes first-class clinical entities | M |
| No entity linking anywhere | MedCAT self-supervised UMLS/SNOMED (F1>0.94 transferable) | Coding / interop / decision-support inputs unreliable | L |

| Guardrail stage | HOPE today | SOTA practice | Gap |
|---|---|---|---|
| SMR **input** | validate, **fail-open configurable** | fail-closed / degraded-safe for PHI | wrong default — outage ships unmoderated PHI prompts |
| Live summary **output** → clinician | **none** | output-side + streaming/sentence-level moderation | no output check before clinician view |
| Live summary **groundedness** | **none** | NLI gate (MiniCheck Flan-T5-Large, >500 docs/min) | ungrounded segments reach clinician unmarked |
| Harness **post-draft safety** | Granite Guardian | Granite Guardian 3.x/4 (GuardBench #1) | **at-par** — enable groundedness head + pin version |

**Verdicts**: (a) **Extract from the raw transcript, not the generated note** (re-point C5-01's `callNlp` at the transcript delta; entity-ground note-level entities to source spans). (b) **Browser generic-BERT NER cannot be clinical-grade** — no ambient-scribe product runs clinical NER in the browser; make the server-side NLP service (clinical encoder + MedCAT-class linker) the authoritative producer of `NamedEntity` rows, browser NER a display hint only. (c) **Guardrails must be fail-closed**, and the live surface needs the output + groundedness moderation it currently lacks. (d) The harness sensor stack is **correct** — the gap is entirely on the live surface.

### S3 — Incremental summarization, durable orchestration, eval

| Metric | HOPE today | Gap | Effort |
|---|---|---|---|
| PDSQI-9 (LLM-judge) + calibration + judge-parity | **present** — uncommon strength | keep; add explicit harm-severity item | — |
| RAGAS-style faithfulness | present (LLM-based) | add reference-free NLI atomic-fact check (MiniCheck/AlignScore) as a deterministic gate | S |
| MEDCON / UMLS concept-F1 | **missing** | deterministic add over already-persisted `NamedEntity` codes; recall = omission catcher | S |
| Clinical-significance-weighted error rate (major/minor) | **missing** | npj framework: 1.47% hallucination rate hides 44% *major* — raw rate isn't the safety metric | M |
| Clinician edit-distance / deferral rate / time-to-sign | **missing** (signal exists in the gate, unused) | the top real-world quality proxy — the gate already emits approve/edit into WORM audit | M |

**Orchestration fit**: Temporal as-used is a **good fit** — do **not** add `continue_as_new` (overkill for a single-shot gate). Add a **terminal abandon/expire timer** (indefinite re-escalation has no terminal bound) and the **claim-check pattern** (pass MinIO/S3 refs, not inline transcript/RAG/note blobs) to protect the 50 MB history-size budget; prefer Worker Versioning over further `patched()` accretion. DBOS/Restate/Inngest are viable lighter alternatives but offer no clear win here; Step Functions is the weakest fit (25K-event / 1-year hard caps).

**Verdicts**: (a) `continue_as_new` is **not** a real risk (~7 years to the cap); the size budget + terminal-abandon are the real hardening. (b) The dual-path architecture is **SOTA-aligned but partly redundant** — keep the two durability tiers, but **unify the note lineage**: the harness should warm-start from the live-doc's last incremental note (two-stage scratchpad→final) and reuse `NamedEntity` rows as NER priors instead of regenerating cold. (c) The verify-then-deliver loop is genuinely SOTA-aligned (mirrors AgenticSum/SCRPO/VTG) — harden it with a reference-free atomic-fact verifier and an explicit optimistic-delivery retraction contract.

### HOPE vs SOTA — one-line gap summary

| Capability | Verdict |
|---|---|
| Draft-then-finalize dual-tier architecture | **at-par** (keep; unify lineage) |
| Sensor-gated bounded regen + human gate | **at-par** (add reference-free verifier) |
| Harness eval (PDSQI-9 + calibration + judge-parity) | **ahead of most** (add MEDCON + edit-burden) |
| Temporal versioning / replay safety | **at-par** (add terminal-abandon + claim-check) |
| Realtime transport durability (plain XREAD) | **behind** (consumer groups, S-effort) |
| Streaming ASR commit latency | **significantly behind** (2023 policy; ~5–7×) |
| Semantic endpointing / streaming diarization | **behind** (absent) |
| Clinical NER + ontology linking | **significantly behind** (generic models, no linker) |
| Live-surface output/groundedness guardrails | **behind** (absent) |
| Guardrail fail-posture | **behind** (fail-open) |

## Implementation Plan (Remediation Roadmap)

Nothing here is executed in TASK-448. Each phase is a set of candidate follow-up tickets. Priority is by patient-safety and PHI first, then durability, then quality/scale/strategy.

### P0 — Patient safety & PHI (do first)

| Finding | Fix | Effort |
|---|---|---|
| **C4-01** | Fail-closed on `stt_session:*` scopes at mint (resolve via `streamSessionTenantBinding.lookup`, 404 if not caller's tenant); independently, verify ticket-tenant vs bound-tenant in `handleConnection`. Ideally only server-generated `createStreamSession` can mint the scope. | M |
| **C5-01** | Map the real NLP contract (`text`/`entity_type`/`position.{start,end}`) — `nlp_client.py` already does; reshape the unit-test mock so it fails against the bug. | S |
| **C5-02** | Pass `aggregation_strategy` into the HF pipeline; read `entity_group`; add a multi-subword-medication test. | S |
| **C1-01** | Do not emit the terminal "ready" stage until assurance settles (or use a distinct pre-assurance label the UI must not treat as sign-off-ready); make apps/api reject sign-off while status is `DRAFT_PENDING_SENSORS`. | M |
| **C6-01** | Honor `sendAudioFrame`'s boolean + wire `onBackpressureDrop` in both stacks; show a connection-degraded banner + dropped-frame counter. | M |
| **C2-01** | Freeze committed surface text (store agreed tokens, append only); on contradiction, keep frozen text or explicitly roll back `stable_chars`. | M |
| **C2-06** | Lower `min_speech_duration_ms` for clinical use and/or add a 1-frame onset hangover so brief crisp words confirm. | S |

### P1 — Data durability & correctness under failure

| Finding | Fix | Effort |
|---|---|---|
| **C3-02 / C3-01 / C3-03 / C3-05** (+ S1-DELIVERY) | **Convert `stt:audio` + `stt:result` to Redis consumer groups** (`XREADGROUP`+`XACK`+`XAUTOCLAIM`); key resume state by `sessionId` with a grace window (don't `removeSession` on transient disconnect); seed the bridge reader from a persisted cursor; add client-side seq dedup + explicit gap markers. This one change closes the whole seam cluster. | L |
| **C2-03** | Durable outbox (Redis/DB) + retry worker keyed by idempotency, or fail finalize loudly and retain the session; surface hard-failure to the client instead of publishing `closed`. | M |
| **C2-02** | Use `streaming_audio_idle_timeout_s` (300 s) for the reaper and/or re-adopt the session on reconnect; resolve the dead-config drift. | S |
| **C2-05** | Transcribe the flushed tail utterance inline before building the transcript. | M |
| **C5-04** | On truncation, don't advance the cursor past the dropped region (carry overflow forward) or keep the head; log a PHI-safe counter. | S |
| **C5-06** | `SET NX` + bail out of `start()` when a live foreign instance holds the lock; add fencing/renewal; deterministic upsert of the durable snapshot. | M |
| **C4-03** | Re-assert SSE access periodically / on a revocation event for long-lived PHI streams. | M |
| **C4-02** | Uniform fail-closed `X-Service-Token` for all PHI-bearing internal hops (SMR, NLP, Guardrail). | M |
| **C1-02** | Cap edit-triggered assurance re-runs (coalesce rapid edits) + a terminal abandon timer. | L |
| C2-07 · C1-03 · C1-04 · C4-04 | Per-session finalize lock; idempotency keys on harness callbacks + SMR generate; retry only connect-phase failures. | M each |

### P2 — Quality, scale, maintainability, observability

Fixes: C5-03 (populate or retire the ontology columns), C5-05 (stable entity ids), C6-02/C6-03/C6-04 (reconnect-recovered status, terminal-failure cleanup, shared wire-contract type + numeric `is_final`), C1-05 (real escalation notification), C1-06 (set `reduced_assurance` on policy-fetch failure), C3-06 (single MAXLEN source of truth), C4-05 (sanitize upstream error bodies), C2-04 (implement PAUSE or reject it).

### SOTA enhancement track (strategic, larger)

Server-side clinical NER + ontology linking (S2 — Clinical/BioClinical ModernBERT + MedCAT/Spark NLP; makes the browser NER a hint and populates `NamedEntity` codes) · re-point live NER to the transcript with source-grounding (S2-04) · fail-closed + live output/groundedness moderation (S2-05/06/07 — MiniCheck-class gate) · streaming-native ASR + sub-second partials (S1-ASR) · semantic endpointing (S1-ENDPOINT) · streaming diarization (S1-DIAR) · streaming eval harness (S1-EVAL) · harness warm-start from the live note + reuse NER priors (S3-F5) · rolling/hierarchical summarization for long encounters (S3-F1) · MEDCON concept-F1 + harm-weighted error rate + clinician edit-burden telemetry (S3-F3/F6/F7) · terminal-abandon timer + claim-check payloads (S3-F4) · reference-free atomic-fact verifier + optimistic-delivery retraction contract (S3-F2).

### Risk register (for the remediation work + this review's own limits)

| Risk | Impact | Mitigation |
|---|---|---|
| C2-02 and C2-06 (both High) were not reached by the verifier | Two High findings rest on reviewer confidence-Medium only | Re-read the reaper-timeout and VAD-onset code before scheduling their fixes; both have concrete evidence quotes. |
| Diarization/inference internals were outside the reviewed file set | Speaker-attribution correctness unassessed | Scope a follow-up review of `stt/diarization/*` + `inference.py` alongside the S1-DIAR work. |
| Whether apps/api dedups harness callbacks / blocks sign-off during `DRAFT_PENDING_SENSORS` was not fully traced | Bears on C1-01/C1-03/C1-04 severity | The C1-01 verifier traced sign-off *is* reachable ([summary.service.ts:456](apps/api/…)); confirm the callback dedup path when fixing C1-03. |
| The consumer-groups migration (P1) touches the hot audio path | Regression risk on the realtime loop | Gate it behind the streaming eval harness (S1-EVAL) so latency/loss are measured, not asserted; it currently has **no e2e coverage** (S-10). |
| `blaze999/Medical-NER` id2label format (B-/I- prefix) unconfirmed | C5-02's className corollary is Medium-confidence | Confirm the model's label scheme; the subword-fragmentation defect itself is model-independent and High-confidence. |

## Implementation Summary

**No source code was changed.** This ticket delivered a review. Method: one deterministic workflow spawned 10 opus-4.8/xhigh subagents — 6 code reviewers (C1 harness · C2 STT session · C3 realtime data-plane · C4 gateway security · C5 live-doc/NER/summary · C6 SDK/playground/tests), each with a precomputed file manifest ([D]eep/[S]kim/[X]skip caps) and a ground-truth architecture preamble to prevent batch-vs-realtime conflation; 3 SOTA researchers (S1 streaming ASR · S2 clinical NER/guardrails · S3 summarization/orchestration/eval); and 1 batched adversarial verifier. Reviews and research ran in parallel; a single barrier fed cross-reviewer dedup, then the verifier re-read every Critical/High finding.

Coverage was deep and honest about its edges: reviewers deep-read ~9k lines (`workflows.py`, `activities.py`, `session_manager.py` targeted zones, `commit_policy.py`, `redis_streams.py`, `inference.py`, both gateway controllers, `live-documentation.service.ts`, `MedNERProcessor.ts`, `SttWebSocketClient.ts`, `TranscriptionPipeline.ts`, the direct hook) and explicitly recorded what they could **not** assess (diarization internals, whether apps/api dedups callbacks, the deployed NER model's exact label scheme). Several review questions returned **sound** verdicts worth recording: the regen loop is replay-deterministic, `patched()` markers are covered on both branches, HTTP/SSE tenancy is consistent 404-over-403, within-connection egress backpressure is correct, and the SOAP parser degrades gracefully.

Quality controls that held: the schema **required a verbatim evidence quote at file:line** (0 findings dropped for missing evidence, so all 35 raw were substantiated); the 12 seed findings were marked KNOWN so agents deepened rather than re-reported (e.g. S-04 became the Critical C4-01, S-01 became the C3-01 resume analysis, S-05 became the composite C5-06); dedup folded 2 duplicates; the verifier **downgraded C2-04 from High to Low** by proving no current client can trigger the PAUSE harm — evidence the adversarial pass did real work rather than rubber-stamping. During synthesis the Critical + top-4 Highs (C4-01, C5-01, C5-02, C1-01, C3-02) were **re-read by hand** and all confirmed exactly as reported.

## Verification Evidence

**Adversarial verifier (V1)** — 11 of 13 Critical/High verified (the 2 unverified are confidence-Medium and reached the batch last):

| Finding | Verdict | Note |
|---|---|---|
| C4-01 | **CONFIRMED** | Mint-side early-return + WS scope-only check traced end-to-end; cross-tenant subscribe that HTTP/SSE would 404 succeeds over WS. |
| C2-01 | **CONFIRMED** | Committed surface re-sliced from latest hypothesis; corrupts live stable region (durable transcript unaffected). |
| C2-03 | **CONFIRMED** | `gateway.create_transcript` has no retry loop; exception swallowed; no re-drive job exists. |
| C2-04 | **PARTIALLY-CONFIRMED → Low** | Code fact true, but no client emits backend PAUSE and SDK `pause()` halts audio at source. |
| C3-01 | **CONFIRMED** | All four mechanisms verified (0-0 re-read, no MAXLEN on results, disconnect finalizes, no client dedup). |
| C3-02 | **CONFIRMED** | Un-awaited XADD, `maxRetriesPerRequest:3`, plain XREAD, no audio-direction resume. |
| C5-01 | **CONFIRMED** | NLP `Entity` serializes `text`/`entity_type`/`position`; reader uses `value`/`type`/`start`; test masks it. |
| C5-02 | **CONFIRMED** | `self.pipeline(request.text)` ignores accepted `aggregation_strategy` → subword fragments. |
| C6-01 | **CONFIRMED** | Both stacks ignore the boolean return + never wire `onBackpressureDrop`; drop reaches the durable transcript. |
| C1-01 | **CONFIRMED** | Sign-off reachable in the pre-assurance window (`summary.service.ts` permits `SIGNED_BEFORE_ASSURANCE`). |
| C1-02 | **CONFIRMED** | Zero `continue_as_new`; uncapped edit-driven re-run is the acute vector. |
| C2-02 | *not reached* | Reviewer confidence Medium; PLAUSIBLE. |
| C2-06 | *not reached* | Reviewer confidence Medium; PLAUSIBLE. |

**Hand spot-check (synthesis)** — re-read the cited code for C4-01 ([auth.controller.ts:837-840](apps/api/src/modules/auth/auth.controller.ts) early-return confirmed; the comment above it documents the check that `stt_session` skips), C5-01 ([live-documentation.service.ts:825-832](packages/applications/src/services/consultation/live-documentation/live-documentation.service.ts) vs [token_classifier.py:142-150](apps/nlp/src/nlp/services/token_classifier.py) field names), C5-02 ([token_classifier.py:87](apps/nlp/src/nlp/services/token_classifier.py) pipeline call), C1-01 ([workflows.py:662-664](apps/harness/src/harness/temporal/workflows.py) terminal stage before the assurance loop), C3-02 ([stt-ws.gateway.ts:581-592](apps/api/src/modules/streaming/stt-ws.gateway.ts) fire-and-forget with a false resume-recovery docstring). All five confirmed.

**Scope proof**: `git status` shows only `docs/implementation/TASK-448-Harness-Loop-Quality-Review/` added — no source files touched.

## Change History

| Date | Change |
|---|---|
| 2026-07-09 | Ticket opened; 10-agent review campaign launched (6 code reviewers, 3 SOTA researchers, 1 adversarial verifier — opus-4.8/xhigh). |
| 2026-07-09 | Campaign completed (1.76M subagent tokens, 0 failures). 33 findings kept (1 Critical, 11 High, 18 Medium, 3 Low); 24 SOTA research findings. Report written, top-5 findings hand-verified. Status → Completed (review). |
