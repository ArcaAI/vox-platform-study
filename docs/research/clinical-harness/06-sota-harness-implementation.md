# 06 · SOTA Harness Implementation (2026)

> The implementation-level state of the art for building the `guides → generate → sensors → gate` loop: orchestration
> approach, durability/HITL, structured-output enforcement, groundedness sensors, PHI redaction, eval harness, and
> PHI-safe observability. **Headline:** hand-roll the bounded loop in FastAPI (Anthropic-aligned), add a **durable
> layer (DBOS default on existing Postgres; Temporal as scale-up)** for resumable confirm-before-commit sign-off, and
> adopt — don't build — the schema/groundedness/PHI/eval/tracing pieces.
>
> **One open decision flagged:** DBOS vs Temporal vs LangGraph for durability (see §1 + recommendation 3).

---

## 1. Key findings

**Orchestration approach (2026)**
- **Anthropic still recommends "the simplest thing that works":** successful LLM systems use "simple, composable
  patterns," not heavy frameworks, which "obscure prompts and make debugging harder." Use **workflows**
  (deterministic, predefined paths) for well-defined tasks; reserve **agents** (LLM self-directs) for open-ended ones. [1]
- **HOPE's loop is a *workflow*, not an *agent*** (fixed path, bounded retries) → hand-roll it in plain Python/FastAPI
  rather than adopt an agent "brain." [1]
- **LangGraph** is the 2026 default for *stateful* workflows: `interrupt()` pauses a node, persists via a checkpointer
  (Postgres/Redis), resumes via `Command(resume=...)` — but the node **re-executes from its start** (nodes must be
  idempotent) and a persistent checkpointer is required or it silently no-ops. [5][4]
- **Pydantic AI** = type-safe tool I/O + FastAPI ergonomics; ships native durable execution via **Temporal** and
  **DBOS** wrappers (`TemporalAgent`/`DBOSAgent`). [2][9]
- **DBOS** = lightweight durable execution **in-process as a library**, checkpointing workflow/step state to
  **Postgres**; auto-resumes from last completed step on restart. Best fit for a FastAPI app that already has Postgres,
  least abstraction. [10]
- **Temporal** = gold-standard durable orchestration for *long* HITL: `wait_condition()` for an approval **Signal**
  for hours/days at **zero compute**, durable timers for SLAs/escalation, full **Event History replay + audit**.
  Constraint: LLM/tool calls must live in **Activities**; adds a server/cluster to operate. [6][8][11]
- **LlamaIndex Workflows** and **Burr** exist but are less differentiated for durable HITL. [4]

**Eval harness**
- **DeepEval** = pytest-native CI gates; `FaithfulnessMetric`, `HallucinationMetric`, `SummarizationMetric`, `GEval`
  (custom LLM-judge rubric). Best for "fail the PR on regression." [14]
- **RAGAS** = best-in-class RAG metrics; **Faithfulness = (#claims supported by context)/(#total claims)** via
  claim-decomposition; verifier swappable for **Vectara HHEM-2.1** (small T5 NLI) for cheap production checks. [15]
- **promptfoo** = YAML/CLI, 50+ assertions + red-team; strongest for prompt regression + multi-model A/B in CI. [13]
- **Langfuse** = observability hub; standard pattern = **DeepEval/promptfoo at PR time** + a **cron sampling 1–5% of
  production traces** to run RAGAS/DeepEval and write scores back. [12]
- **Golden-dataset versioning:** version prompts + datasets + evaluators + models together (Git/DVC); pin dataset
  versions; set release thresholds before comparing. A Postgres table + GitHub Actions cron is enough to start. [42][43][44]
- **Clinical rubric automation — PDSQI-9:** validated LLM-specific successor to PDQI-9 (9 attributes incl. **Cited**,
  Accurate, Thorough, Synthesized; α=0.879, ICC=0.867 on 779 summaries / 8,329 ratings). **Epic publishes an
  open-source LLM-as-judge** (LiteLLM, JSON in/out, 1–5 Likert + justifications); a reasoning judge (o3-mini-class)
  hit **ICC 0.818 vs humans, median diff 0, ~22 s/eval**. [16][17][19]

**Guardrails**
- **PHI redaction — domain matters:** general PII tools collapse on clinical text. **GLiNER-PII drops to ~0.41
  macro-F1** on clinical (NAME 0.07, CONTACT 0.07, IDNUM 0.06); **Presidio** is solid for general PII but unvalidated
  clinically; **John Snow Labs Healthcare NLP** hit **96% F1** clinical PHI (vs Azure 91 / AWS 83 / GPT-4o 79) and
  runs on-prem/air-gapped. Practical stack: **Presidio + clinical NER** → John Snow Labs for regulatory-grade recall. [20][21][22]
- **NeMo Guardrails vs Guardrails AI:** NeMo = Colang dialog control (best for *chatbots*); **Guardrails AI** =
  validator/RAIL + Pydantic for **structured-output + content validation** with re-ask (50–60+ Hub validators incl.
  PII, JSON, MiniCheck groundedness) → better fit for a bounded *document pipeline*. [23][24]
- **Structured-output enforcement (strongest→weakest):** constrained decoding (**Outlines/XGrammar via vLLM
  `guided_json`** — schema→FSM, invalid tokens masked, *mathematically* valid, ~8% latency) ≈ **OpenAI Structured
  Outputs** (`strict:true`, OpenAI-only) > **Instructor** (provider-agnostic Pydantic + retry). For self-hosted
  models, **Outlines+vLLM** is the durable choice. [40][39][41]
- **Self-hosted classifiers:** **Bespoke-MiniCheck-7B** = SOTA grounded-factuality/entailment (LLM-AggreFact 77.4% vs
  HHEM 71.8%), **~200 ms/GPU**, runs on a laptop/Ollama/vLLM, exposed as a Guardrails AI validator → ideal "sensor."
  **Llama Guard 3** (1B/8B/11B-V) for I/O safety. [27][28][29]

**Faithfulness / grounding SOTA (clinical summaries)**
- **Claim-decomposition + entity-level + NLI entailment** is dominant: split output into sentence/entity "semantic
  pieces," retrieve top-k source pieces, classify entailment; add **exact entity-match** (type+value) for facts. [31]
- **QA-based faithfulness** (question-generate → sort → evaluate) gives transparent detection with a tunable
  threshold. [33]
- **Token-likelihood/entropy alone over-predict hallucinations;** context-aware uncertainty aggregated to entity
  level is more reliable. [32]
- **⚠️ 2026 caution:** NLI classifiers (HHEM, MiniCheck, Azure Groundedness) trained on 2015-era NLI **underperform
  on long real RAG contexts** → use **claim-level checks + a reasoning judge for borderline cases**, and **plan to
  fine-tune** entailment models on clinical text. [30][34]
- **Citation verification:** force every sentence/section to cite source span IDs (STT transcript, NER spans, Qdrant
  chunk IDs); verify each by entailment — the mechanism behind PDSQI-9's "Cited" attribute. [16]

**Durable + observable HITL**
- **Confirm-before-commit / attestation:** pause at the gate, surface state, finalize **only on explicit approval
  signal** (with timeout/escalation); record who/when/edits. Temporal's signal+timer gives a complete compliance
  audit trail. [11][6]
- **Resumable jobs:** durable execution survives crashes/deploys by replaying recorded steps (Temporal Event History
  / DBOS Postgres checkpoints / LangGraph checkpointer) — essential when sign-off lags hours/days. [7][10]
- **PHI-safe tracing:** **Langfuse** offers a **HIPAA cloud region + BAA** or **fully air-gapped self-host**; redact
  via **client-side `mask` on the SpanProcessor** *and* **server-side ingestion-masking** on the OTel endpoint. Add a
  **defense-in-depth** redaction at app SDK *and* OTel Collector, plus a CI test that **scans exported telemetry for
  PHI**. [35][36][37][38]

## 2. Recommended implementation stack
| Layer | Choice | Why |
|---|---|---|
| Control loop | **Hand-rolled FastAPI/Python** (`guides→generate→sensors→gate`) | Deterministic *workflow*; Anthropic-aligned, fully auditable, no hidden abstraction |
| Durability/resume + HITL | **DBOS** (in-process, Postgres) → *Temporal* if outgrown | Lightweight, runs inside FastAPI on existing Postgres; survives crashes + long sign-off waits |
| Tool I/O typing | **Pydantic AI** (or plain Pydantic) | Type-safe STT/NER/LLM tool contracts; native DBOS/Temporal wrappers |
| Schema enforcement | **Outlines + vLLM `guided_json`** (self-host) / **OpenAI Structured Outputs** (cloud) | Logit-level valid clinical JSON for on-prem; provider-native path for cloud |
| Groundedness sensor | **Bespoke-MiniCheck-7B** + RAGAS-style claim decomposition | SOTA entailment ~200 ms, on-prem; per-claim grounded/not for the gate |
| PHI redaction | **Presidio + clinical NER** → **John Snow Labs** | On-prem scrubbing at ingress/egress + before tracing; clinical recall matters |
| Safety classifier | **Llama Guard 3 (1B/8B)** self-host | Cheap I/O safety in the same air-gapped footprint |
| Validator composition | **Guardrails AI** (RAIL/Pydantic, MiniCheck + PII) | Composes redaction + schema + groundedness + re-ask |
| Eval (CI gate) | **DeepEval (pytest)** + **promptfoo** | Fails PRs on faithfulness/hallucination/regression vs versioned golden sets |
| Eval (RAG/prod) | **RAGAS** faithfulness + **PDSQI-9 LLM-judge** (Epic OSS) | RAG grounding monitoring + validated clinical-quality rubric |
| Observability/audit | **Langfuse** (HIPAA region+BAA or self-host) over **OTel**, masking at SDK+Collector | PHI-safe traces; stores eval scores; backs the immutable audit trail |

## 3. Build vs adopt
| Capability | Build/Adopt | What |
|---|---|---|
| Bounded loop & gate logic | **Build** | Plain Python/FastAPI state machine |
| Durable checkpoint/resume + HITL wait | **Adopt** | DBOS (light) or Temporal (scale) — don't hand-roll crash recovery |
| Tool wrappers (STT/NER/LLM/Qdrant) | **Build** (thin) | Pydantic-typed adapters over existing services |
| JSON schema enforcement | **Adopt** | Outlines+vLLM / OpenAI Structured Outputs |
| PHI redaction | **Adopt** | Presidio (+clinical NER) → John Snow Labs |
| Groundedness/entailment scoring | **Adopt** (+ fine-tune) | Bespoke-MiniCheck-7B / HHEM; fine-tune on clinical later |
| Safety classification | **Adopt** | Llama Guard 3 |
| Validator orchestration | **Adopt** | Guardrails AI (or LLM-Guard) |
| Eval metrics & judges | **Adopt** | DeepEval + RAGAS + promptfoo + PDSQI-9 (Epic OSS) |
| Golden-dataset versioning | **Build** (on standard tools) | Git/DVC + pinned versions + thresholds |
| Tracing/observability | **Adopt** | Langfuse + OTel; **build** masking callbacks + audit schema |
| Audit trail / attestation record | **Build** | Append-only store: inputs, model+versions, retrieved chunk IDs, sensor scores, gate decision, clinician identity/edits/timestamp |

## 4. Recommendations for HOPE's implementation plan (sequenced)
1. **Frame it as a workflow, not an agent** — explicit Python in the FastAPI orchestrator with hard bounds (max
   regen attempts, max tool calls); use a framework only for durability/HITL. [1]
2. **Eval-first: stand up the harness before the generator** — versioned golden set (50–100 cases across
   tenants/specialties), **DeepEval + promptfoo** as CI release gates (faithfulness/coverage/PHI-leak thresholds),
   pinned to dataset versions. [14][13][42]
3. **Adopt durable execution early — default DBOS** (checkpoints to existing Postgres, resumes across multi-hour/day
   sign-off; every node idempotent). **Temporal** is the documented scale-up (multi-region, SLA timers, escalation,
   replay audit). [10][6]
4. **Make sign-off a hard gate** with confirm-before-commit + attestation (clinician identity, timestamp, edits;
   timeout/escalation); never auto-finalize. [11]
5. **Enforce structured output at generation** — Outlines+vLLM `guided_json` (on-prem) / OpenAI Structured Outputs
   (cloud); Instructor-style Pydantic+retry as fallback. [40][39]
6. **Wire sensors as grounding + safety** — per-claim/entity **Bespoke-MiniCheck-7B** vs retrieved Qdrant chunks +
   STT/NER spans, RAGAS claim decomposition, citation-span verification, Llama Guard 3; gate on thresholds, route
   failures into bounded regen. [27][15][29]
7. **Require sentence-level citations** — force source-span IDs, verify by entailment, expose in the clinician UI
   (PDSQI-9 "Cited" + trust). [16]
8. **Layer PHI redaction at every boundary** — Presidio + clinical NER (→ John Snow Labs) at ingress/egress *and*
   before tracing; CI test scanning exported telemetry for PHI. [20][38]
9. **PHI-safe, tenant-aware tracing** — Langfuse (HIPAA region+BAA or air-gapped) over OTel, masking at SDK + OTel
   Collector; tag traces by tenant; store eval scores on traces. [35][37]
10. **Automate the clinical rubric** — Epic's **PDSQI-9** LLM-judge (reasoning judge) for offline release evals +
    sampled production audits; track the 9 attributes as dashboards/regression gates. [16][17]
11. **Build an immutable audit trail as a first-class artifact** — append-only per document: prompt+template version,
    model+version, retrieved knowledge IDs, every sensor score, gate decision, clinician attestation. [11]
12. **Plan a clinical fine-tune of entailment/PHI models** — off-the-shelf NLI/PHI degrade on clinical/long-RAG;
    schedule fine-tuning of MiniCheck/HHEM + de-id NER on tenant data once labeled eval traffic exists. [30][22]

## Sources
1. Anthropic — Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
2. Pydantic AI vs LangGraph (Altai): https://altaitools.com/pydantic-ai-vs-langgraph/
3. Best AI agent frameworks 2026 (Alice Labs): https://alicelabs.ai/en/insights/best-ai-agent-frameworks-2026
4. Pydantic AI vs LangGraph (ZenML): https://www.zenml.io/blog/pydantic-ai-vs-langgraph
5. LangGraph interrupts (LangChain docs): https://docs.langchain.com/oss/python/langgraph/interrupts
6. Temporal — human-in-the-loop approvals: https://temporal.io/blog/human-in-the-loop-approvals
7. Temporal — dynamic AI agents: https://temporal.io/blog/of-course-you-can-build-dynamic-ai-agents-with-temporal
8. Temporal AI agent workflows / durable execution 2026 (Effloow): https://effloow.com/articles/temporal-ai-agent-workflows-durable-execution-2026
9. Pydantic AI — Temporal durable execution: https://pydantic.dev/docs/ai/integrations/durable_execution/temporal/
10. Pydantic AI — DBOS durable execution: https://pydantic.dev/docs/ai/integrations/durable_execution/dbos/
11. Temporal — HITL cookbook (Python): https://docs.temporal.io/ai-cookbook/human-in-the-loop-python
12. DeepEval vs RAGAS (genai.qa): https://genai.qa/blog/deepeval-vs-ragas/
13. promptfoo vs DeepEval vs RAGAS (genai.qa): https://genai.qa/blog/promptfoo-vs-deepeval-vs-ragas/
14. LLM evaluation framework benchmark 2026 (aiml.qa): https://aiml.qa/llm-evaluation-framework-benchmark-2026/
15. RAGAS — Faithfulness metric: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/
16. Epic — PDSQI-9 LLM-as-judge (evaluation-instruments): https://github.com/epic-open-source/evaluation-instruments/tree/main/src/evaluation_instruments/instruments/pdsqi_9
17. PDSQI-9 validation (PubMed 40323321): https://pubmed.ncbi.nlm.nih.gov/40323321/
18. PDSQI-9 study (npj Digital Medicine): https://www.nature.com/articles/s41746-025-02005-2
19. LLM-as-judge clinical validation (PubMed 40313300): https://pubmed.ncbi.nlm.nih.gov/40313300/
20. John Snow Labs vs Microsoft Presidio de-identification: https://www.johnsnowlabs.com/comparing-john-snow-labs-medical-text-de-identification-with-microsoft-presidio/
21. How good are open-source LLM de-id tools in medical context (JSL): https://www.johnsnowlabs.com/how-good-are-open-source-llm-based-de-identification-tools-in-a-medical-context/
22. Clinical de-identification benchmark (arXiv 2503.20794): https://arxiv.org/html/2503.20794
23. Guardrails AI vs NeMo Guardrails (AICoolies): https://aicoolies.com/comparisons/guardrails-ai-vs-nemo-guardrails
24. AI guardrails (My Engineering Path): https://myengineeringpath.dev/genai-engineer/ai-guardrails/
25. Best AI guardrails (General Analysis): https://generalanalysis.com/guides/best-ai-guardrails
26. Guardrails AI — RAIL how-to (GitHub): https://github.com/guardrails-ai/guardrails/blob/main/docs/how_to_guides/rail.md
27. Bespoke-MiniCheck-7B (Bespoke Labs): https://www.bespokelabs.ai/bespoke-minicheck
28. Bespoke-MiniCheck-7B (HuggingFace): https://huggingface.co/bespokelabs/Bespoke-MiniCheck-7B
29. Llama Guard 3 (Meta): https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-3/
30. Hallucination detection comparison (BlueGuardrails): https://blueguardrails.com/en/blog/hallucination-detection-comparison
31. Entity-level faithfulness + NLI (Springer, Complex & Intelligent Systems 2025): https://link.springer.com/article/10.1007/s40747-025-01833-9
32. Context-aware uncertainty for hallucination (arXiv 2502.11948): https://arxiv.org/html/2502.11948v3
33. QA-based faithfulness (Scientific Reports 2025): https://www.nature.com/articles/s41598-025-31075-1
34. Clinical groundedness on long RAG (medRxiv 2025): https://www.medrxiv.org/content/10.1101/2025.02.28.25323115v1.full
35. Langfuse — HIPAA: https://langfuse.com/security/hipaa
36. Langfuse — self-host data masking: https://langfuse.com/self-hosting/security/data-masking
37. Langfuse — masking feature: https://langfuse.com/docs/observability/features/masking
38. HIPAA-compliant OpenTelemetry pipelines (OneUptime): https://oneuptime.com/blog/post/2026-02-06-hipaa-compliant-opentelemetry-pipelines-redact-phi/view
39. OpenAI — Structured Outputs guide: https://developers.openai.com/api/docs/guides/structured-outputs
40. Outlines library (Engineers of AI): https://engineersofai.com/docs/llms/structured-generation/Outlines-Library
41. Structured outputs in production (Tian Pan): https://tianpan.co/blog/2025-10-11-structured-outputs-in-production
42. Answering "is the AI accurate?" (DEV/sapotacorp): https://dev.to/sapotacorp/how-to-answer-the-cfo-question-is-the-ai-accurate-3fbd
43. How to build prompt evals (PromptLayer): https://blog.promptlayer.com/how-to-build-prompt-evals-for-llm-apps/
44. CI/CD pipelines for RAG systems (apxml): https://apxml.com/courses/large-scale-distributed-rag/chapter-5-orchestration-operationalization-large-scale-rag/ci-cd-pipelines-rag-systems
