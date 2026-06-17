# HOPE v2 vs v1 — Architecture & Workflow Comparison (Pros / Cons)

|              |                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Audience** | Technical leadership, product decision makers                                                                                                                                                                                                             |
| **Purpose**  | An honest, evidence-grounded comparison of HOPE **v2** against **v1** — what changed, what improved, and what was traded away or deferred                                                                                                                 |
| **Sources**  | v2: the HOPE v2 repository (architecture docs, service READMEs, code/config). v1: the HOPE v1 PROJECT docs (`Marketing_Brief_Investor.md`, `V1_Technical.md`, `V1_Model_License.md`, `Technical_Document.md`, `Scope_of_Work.md`) and v1 service READMEs. |
| **Stance**   | Not a cheerleading piece. v2 is the clear architectural direction, but it ships with real regressions, added operational complexity, and migration cost. Those are called out explicitly.                                                                 |

---

## 1. Overview — What Changed Conceptually

Both v1 and v2 are the same product at heart: **turn a doctor–patient conversation into a signed, structured clinical note**, on-prem-first, in the doctor's own writing style. Both are Turborepo + pnpm monorepos with a NestJS API gateway fronting Python/FastAPI AI services.

The conceptual shift from v1 to v2 is **from a "vertically integrated, MedGemma-centric, MLOps-heavy" platform to a "lean, provider-portable, safety-and-orchestration-first" platform**:

1. **From one flagship LLM to a provider-portable gateway.** v1 was built around an on-prem **MedGemma 27B** primary model with Azure GPT-4o-mini as overflow. v2 turns summarization into a vendor-neutral LLM gateway (LM Studio default, Ollama, any OpenAI-compatible endpoint, Azure OpenAI, AWS Bedrock; llama.cpp planned) that defaults to **small open-weight models** (Gemma-4-e4b, Qwen 3.5, IBM Granite 4). Lower hardware floor and zero lock-in — but a lighter default than a 27B medical model.
2. **New safety and orchestration tiers.** v2 adds a **dedicated Guardrail service** (medical-context validation, content safety, PII, prompt-injection) and a **Harness service running durable Temporal workflows** for the `guides → generate → sensors → gate` clinical-documentation loop with a clinician sign-off gate. v1 had neither.
3. **Consolidation — some v1 ambitions were dropped or deferred.** v2 removes/defers several v1 services: the shipped **TTS** service (now a planned stub), the **MLflow** MLOps app (now planned; prompt + DNA management migrated to PostgreSQL-native modules), the **federated-learning** backend (`apps/fedl`), and the **behavioral-feedback / InfluxDB** service. v2 is leaner, but narrower than v1's full vision.
4. **Enterprise hardening.** v2 invests heavily in **multi-tenancy isolation** (four composed server-side layers plus a browser-SDK isolation layer) and **secrets management** (HashiCorp Vault with dynamic, short-lived PostgreSQL credentials). v1's docs show more architectural drift and less formal isolation.
5. **Richer transcription.** v2 adds **multi-engine ASR** (Whisper ONNX + Whisper PyTorch + NVIDIA NeMo Parakeet + Azure; whisper.cpp planned), **Cadence punctuation restoration**, and an **in-browser Medical NER** plugin — beyond v1's Whisper-primary + Azure-fallback transcription.

---

## 2. Architecture Comparison (side-by-side)

| Dimension                    | HOPE v1                                                                                              | HOPE v2                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Gateway**              | NestJS 11 (TypeScript)                                                                               | NestJS 11 (TypeScript), port 8868                                                                                                                                                                                |
| **Python AI services**       | `stt-v2`, `smr`, `nlp`, **`tts`**, **`feedback`**, **`fedl`**, **`mlflow`**                          | `stt-v2` (8861), `smr` (8862), **`guardrail`** (8863), `nlp` (8864), **`harness`** (8866)                                                                                                                        |
| **New in v2**                | —                                                                                                    | **Guardrail** service + **Harness** (Temporal durable workflow orchestration)                                                                                                                                    |
| **Dropped / deferred in v2** | TTS (shipped), MLflow (app), federated learning (`fedl`), feedback/InfluxDB                          | TTS → _planned stub_; MLflow → _planned_; federated learning → _not present_; feedback metrics → _not present_                                                                                                   |
| **Summarization LLM**        | **MedGemma 27B** on-prem primary → **Azure GPT-4o-mini** overflow                                    | **Provider-portable gateway**: LM Studio (default; Gemma-4-e4b/Qwen 3.5/Granite 4) · Ollama · OpenAI-compatible (vLLM/TGI) · Azure OpenAI (`gpt-5-mini`) · AWS Bedrock (Claude 3.5 Haiku); **llama.cpp planned** |
| **Provider switching**       | Single env var (`SUMMARY_AGENT_LLM_PROVIDER`: azure_openai / ollama / langflow)                      | Per-request routing through one `generate`/`generate_stream` abstraction; per-provider concurrency, circuit breakers, retries                                                                                    |
| **ASR engines**              | Whisper large-v3-turbo (Q4 ONNX) + Azure Speech fallback                                             | Whisper ONNX + Whisper SafeTensor/PyTorch + **NVIDIA NeMo Parakeet** + Azure Speech (+ whisper.cpp _planned_)                                                                                                    |
| **Punctuation**              | —                                                                                                    | **Cadence / Cadence-Fast** restoration (disabled by default)                                                                                                                                                     |
| **Diarization**              | WeSpeaker embeddings + persistent cross-visit speaker store + encrypted voice biometrics (IndexedDB) | `pyannote/wespeaker-voxceleb-resnet34-LM` (256-d) + `segmentation-3.0` refinement; voice-profile enrollment in Qdrant; reserved-speaker pinning                                                                  |
| **Safety / guardrails**      | None dedicated                                                                                       | **Guardrail service**: GLiNER ONNX (safety/PII/injection) + Granite Guardian / Gemma; plus SMR-side prompt-injection scanner & leak scanner                                                                      |
| **Orchestration / queues**   | Celery + Redis (SMR); BullMQ                                                                         | BullMQ (gateway) + Dramatiq on Redis (STT) + **Temporal durable workflows** (Harness)                                                                                                                            |
| **Streaming**                | WebSocket partials via Redis Streams; SSE                                                            | Redis-Streams streaming with **resume from `Last-Event-ID`**; SSE; WebRTC _planned_                                                                                                                              |
| **Data layer**               | PostgreSQL (Prisma 6.8.2) · Redis · MinIO/S3 · Qdrant · **InfluxDB** · **MLflow**                    | PostgreSQL (**Prisma 7**) · Redis · MinIO · Qdrant · **HashiCorp Vault** (InfluxDB & MLflow dropped/deferred)                                                                                                    |
| **Secrets management**       | Not formalized in docs                                                                               | **Vault** (AppRole + dynamic short-lived PG credentials)                                                                                                                                                         |
| **Prompt / DNA management**  | MLflow-backed service                                                                                | **PostgreSQL-native** (`PromptTemplate` with version history; `DnaWritingStyleReport`) — MLflow proxy removed                                                                                                    |
| **Specialty coverage**       | 7 specialties × 2 visit types = **14 templates**                                                     | **11 specialties** (per-specialty DNA style variables) + guaranteed `CATCHALL_SOAP` fallback                                                                                                                     |
| **Multi-tenancy**            | Standard tenant model                                                                                | **Hardened**: 4 composed server-side layers (CLS → domain guards → Prisma `$extends` → schema) + browser-SDK isolation layer; RLS drafted/deferred                                                               |
| **Frontend**                 | React 19 admin dashboard (port 5174)                                                                 | React 19 / Vite / TanStack Router `ui-playground` (5175) + admin console (5174)                                                                                                                                  |
| **Browser AI**               | RNNoise + Silero VAD + diarization (WASM) + voice biometrics                                         | Same pipeline (`noise-filter` → `vad` → `stt`) **+ in-browser Medical NER** (`@arcaai/med-ner`, Transformers.js)                                                                                                 |
| **MLOps**                    | MLflow app shipped (DNA, prompt/model/dataset mgmt)                                                  | _Planned_ self-hosted MLflow plane; engineering harness (eval/replay/canary) _planned_                                                                                                                           |
| **Deployment**               | Docker, on-prem-first + BYO-Azure tenancy                                                            | Docker Compose (dev) + **systemd single-server** (prod) + opt-in profiles (Vault, Qdrant, Temporal)                                                                                                              |
| **Observability**            | OpenTelemetry + Prometheus + Grafana + Loki                                                          | OpenTelemetry + Prometheus + Grafana (per-service `/metrics`, dashboards)                                                                                                                                        |

---

## 3. Workflow Comparison — Clinical Documentation / Consultation

### v1 consultation flow

1. **Browser audio cleanup** — RNNoise (AudioWorklet, 10 ms frames @ 48 kHz) + WebRTC echo cancellation; 3-tier graceful fallback.
2. **VAD** — Silero VAD trims silence before STT.
3. **STT** — Whisper large-v3-turbo (Q4 ONNX) primary, streaming partials over WebSocket; **Azure Speech fallback**; on-device Whisper Web Worker for privacy mode. Languages: English + Malayalam.
4. **Diarization & re-ID** — WeSpeaker embeddings + agglomerative clustering; **persistent speaker vector store** keeps identity across visits; voice biometrics enrolled + AES-GCM encrypted in IndexedDB.
5. **Summarization** — specialty router (`select_prompt_template`, 14 templates) → context injection (demographics + speaker-labeled transcript + verbatim results + **pre-summary context** from last 12 months) → **DNA writing-style overlay** fetched from MLflow → **MedGemma 27B** (on-prem) primary → **Azure GPT-4o-mini** overflow on context/complexity/JSON-repair failure → `DEPT_VISIT_SCHEMAS` JSON contract.
6. **Persist & learn** — `medical_summaries` (Postgres) + Qdrant; signed-off edits feed **MLflow** (sharper DNA) and the **Feedback Service** (InfluxDB behavioral metrics).

### v2 consultation flow

1. **Browser or backend pipeline** — `@arcaai/noise-filter` (RNNoise) → `@arcaai/vad` (Silero VAD v5) → `@arcaai/stt` (Whisper Web Worker) → `@arcaai/med-ner` (in-browser entity extraction). Identical-structure backend pipeline available for higher fidelity (`pyrnnoise` → Silero VAD → multi-engine ASR → pyannote diarization → **Cadence punctuation**).
2. **Diarization** — pyannote 256-d embeddings, hybrid centroid/history scoring, ambiguity refinement; **reserved-speaker pinning** flows the authenticated doctor's identity through the diarizer; cross-session voice profiles in Qdrant.
3. **Prompt assembly** — **API Gateway** resolves department/visit-type templates from **PostgreSQL** (`PromptTemplate`, version history; `CATCHALL_SOAP` fallback) and assembles variables (`{conversation_language}`, `{pre_summary_text}`, `{same_day_prequel_summary}`, per-specialty `{style_DNA_doctor_department_*}`).
4. **Safety screening** — Guardrail service can validate medical context and screen for PII / unsafe content / prompt-injection; SMR adds an inbound prompt-injection scanner and an outbound secret-leak scanner.
5. **Summarization** — **SMR provider-portable gateway** generates via the selected backend; async generation returns `202 + task_id`, streams to a **Redis Stream**, and supports **resume on disconnect**; `json_schema` structured-output validation; per-provider circuit breakers/retries; Bedrock Guardrails passthrough when applicable.
6. **DNA writing style** — learned asynchronously via BullMQ jobs from a doctor's past `ContextItem` records and stored as versioned `DnaWritingStyleReport` rows (PostgreSQL-native, no MLflow dependency).
7. **Durable documentation loop** _(being built out)_ — the **Harness** runs `guides → generate → sensors → gate` as a Temporal workflow, where clinician sign-off is a durable `wait_condition()` Signal with SLA/escalation timers, reusing STT/NLP/SMR/Qdrant as tools.

### What's different about the v2 workflow

- **Adds:** in-browser Medical NER, multi-engine ASR + punctuation, an explicit guardrail/safety step, resumable streaming, durable sign-off orchestration, and broader specialty coverage (11 vs 7).
- **Simplifies:** prompt + DNA management is now PostgreSQL-native (removes the MLflow service from the hot path).
- **Changes the LLM economics:** v1 leaned on a single heavyweight on-prem model (MedGemma 27B) with cloud overflow; v2 defaults to small open-weight models behind a portable gateway, pushing model choice (and quality/cost trade-off) to the operator.
- **Loses (for now):** the closed feedback loop that fed v1's continuous improvement — MLflow-driven DNA sharpening and InfluxDB behavioral metrics are deferred/removed, and federated learning is gone.

---

## 4. Pros & Cons of v2 (vs v1)

### Pros — where v2 is genuinely better

| Area                                    | Why it's better                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No vendor lock-in**                   | Provider-portable LLM gateway (self-hosted + managed, switchable per request) replaces v1's MedGemma-primary/Azure-overflow coupling.                             |
| **Lower hardware floor**                | Small open-weight defaults (Gemma-4-e4b, Qwen 3.5, Granite 4) run without a dedicated 27B-class GPU node, widening the set of hospitals that can self-host.       |
| **Dedicated safety tier**               | A standalone Guardrail service (GLiNER + Guardian) plus SMR-side injection/leak scanners — a security capability v1 lacked entirely.                              |
| **Durable, auditable orchestration**    | Temporal workflows make the clinical-doc loop and clinician sign-off resumable, traceable, and SLA-aware — a much stronger backbone than v1's Celery/BullMQ jobs. |
| **Enterprise multi-tenancy**            | Four composed isolation layers + browser-SDK isolation + Vault dynamic credentials — materially stronger data-sovereignty/SaaS posture than v1.                   |
| **Simplified prompt/DNA plane**         | PostgreSQL-native templates and DNA reports (with version history) remove the MLflow runtime dependency from the documentation hot path.                          |
| **Richer transcription**                | Multi-engine ASR (incl. NVIDIA Parakeet), punctuation restoration, and in-browser Medical NER exceed v1's transcription stack.                                    |
| **Resilient streaming**                 | Redis-Streams streaming with resume-from-cursor survives network drops without losing in-flight generation.                                                       |
| **Cleaner licensing on the audio path** | v2 drops v1's **Silero STT (CC-BY-NC, non-commercial)** risk and favors Apache-2.0 LLM options (Qwen, Granite).                                                   |
| **Less architectural drift**            | v2 docs/code are more consolidated; v1 carried two contradictory doc generations and duplicated app/package names.                                                |

### Cons — regressions, added complexity, and migration cost

| Area                                   | The honest downside                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lighter default LLM quality**        | v2's default small models (≈2–4B class) are not obviously equal to v1's purpose-built **MedGemma 27B** for clinical summarization quality on the default path. Parity requires the operator to plug in a larger model — the capability is there, but it isn't the out-of-box default. |
| **Capabilities dropped/deferred**      | **TTS** (shipped in v1) is now a planned stub; **MLflow** MLOps plane is planned, not shipped; **federated learning** (`apps/fedl`) is gone; **behavioral feedback / InfluxDB** metrics are gone. Customers who valued these lose them in v2.                                         |
| **Broken continuous-improvement loop** | v1's signed-edits → MLflow (sharper DNA) → InfluxDB feedback loop is not present in v2 yet. DNA still learns from history, but the closed evaluation/feedback loop is deferred.                                                                                                       |
| **Harness is early**                   | The durable clinical-doc loop is a **Phase-0 scaffold** — the headline orchestration capability is largely not built out, while it already adds Temporal as a new operational dependency.                                                                                             |
| **More moving parts**                  | v2 adds Guardrail, Harness, Temporal, and Vault to the run-time surface. More services = more to deploy, monitor, secure, and debug than v1.                                                                                                                                          |
| **New license-review burden**          | v2's **Gemma-based defaults** (Gemma Terms of Use) and **Cadence** punctuation (Gemma-3 backbone → Gemma flow-down) require legal review for healthcare use. v1's MedGemma at least shipped under medical-purpose HAI-DEF terms.                                                      |
| **Carried-over license risk**          | The medical **NLP/NER community models** (`blaze999/Medical-NER`, `shanover/symps_disease_bert_v3_c41`, `michellejieli/emotion_text_classifier`) still ship **without an explicit license** — a v1 risk that v2 does **not** resolve.                                                 |
| **Migration cost**                     | Prisma 6→7, prompt/DNA migration off MLflow into Postgres, SDK move to `@arcaai/vox` (`agentic-sdk-v2`), DNA re-generation, and re-validation of clinical output on smaller default models all represent real switching cost.                                                         |
| **No transport win yet**               | WebRTC remains _planned_ in both versions; v2's audio transport is still WebSocket — the resilience/traversal benefits are not realized today.                                                                                                                                        |
| **Production-maturity gap**            | v1's STT + summarization path is battle-tested; several v2 services are in active development and not yet equally proven in production.                                                                                                                                               |

---

## 5. Recommendation / Summary

**v2 is the right architectural direction and should be the platform of record going forward** — but the migration should be staged and quality-gated, not treated as a drop-in upgrade.

- **Adopt v2 for:** new deployments, customers who need vendor neutrality / strict data sovereignty, environments that can't host a 27B GPU node, and any buyer for whom the dedicated safety tier and hardened multi-tenancy are procurement requirements. v2's portability, security posture, and durable orchestration are strict improvements over v1.
- **Mind the gaps before migrating existing v1 customers:**
  1. **Validate summary quality** on v2's default models against v1's MedGemma-27B baseline for each specialty; where it falls short, configure a larger self-hosted or managed model via the gateway. Don't assume the small-model default matches v1 quality.
  2. **Restore or replace the continuous-improvement loop** (MLflow DNA sharpening + feedback metrics) — these are deferred in v2 and were part of v1's adoption moat.
  3. **Close the licensing actions** — legal review for Gemma/Cadence flow-down, and resolve (or replace) the unlicensed medical NER/diagnosis models before commercial use. This affects both versions but must not be carried forward unexamined.
  4. **Plan for the new operational footprint** — Temporal, Vault, and the extra services need deployment, monitoring, and runbooks.
- **Treat "planned" as planned:** TTS, self-hosted MLflow, llama.cpp, WebRTC, and the full engineering harness are roadmap items, not shipped features. Position them accordingly with customers.

**Bottom line:** v2 trades v1's heavyweight, MLOps-rich, single-flagship-model design for a leaner, safer, vendor-neutral, enterprise-hardened core. The trade buys portability, security, and a lower hardware floor at the cost of a lighter default model, several deferred capabilities, and added operational complexity. For most prospects — especially privacy-sensitive, multi-tenant, cost-conscious hospitals — that's a favorable trade, provided the quality validation and licensing actions above are completed.
