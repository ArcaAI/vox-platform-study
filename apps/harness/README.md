# HOPE Clinical Documentation Harness (`apps/harness`)

**Ticket:** TASK-330 (+ TASK-345/354/355/357/458/469/480/481/483 hardening waves) · **Status:** production loop, live in the durable substrate · **Port:** 8866 · **Stack:** Python 3.11 / FastAPI / Temporal

A Python/FastAPI service whose real job is a **Temporal durable workflow**:
`HarnessDocWorkflow` runs the bounded **`policy → guides(retrieve) → generate → sensors → gate`**
clinical-documentation loop for one consultation. `apps/api` (NestJS) stays the gateway and
system-of-record (authZ, tenant/CLS, Postgres, WORM audit, consent, sign-off) and drives the loop
through two internal HTTP endpoints — it never talks to Temporal directly. The harness treats
STT / NLP / SMR / Qdrant / Temporal as tools (ACI): all non-deterministic I/O (HTTP calls,
model inference, clock/random access) lives in Temporal **activities**; the workflow **body**
stays deterministic.

What the loop actually does today, end to end:

- **Bounded regen loop** — up to `max_regen` re-generations, driven by five cheap deterministic
  ("computational") sensors every iteration, then a costlier model-backed ("inferential") pass
  (groundedness + safety, optionally citation-verify + a deterministic atomic-fact gate) folded
  in once the computational verdict settles.
- **Two delivery shapes** — the legacy single-phase path (inferential pass inside the regen loop,
  one persist straight to `PENDING_REVIEW`) and the newer **optimistic two-phase** path (deliver a
  readable draft immediately, run inferential assurance *after* delivery, retract-or-finalize based
  on what assurance finds).
- **Institutional RAG** (flag-gated) — hybrid dense+sparse retrieval over a tenant knowledge corpus,
  degrade-safe, feeding a StrictCitations block into the prompt.
- **Claim-check** — large clinical blobs (transcript/prompt/note/RAG chunks) are moved out of
  Temporal history into an out-of-band blob store above a size threshold.
- **Fail-closed PHI egress guard** — redacts before any cloud-bound LLM/judge/safety call; local
  providers are a pass-through.
- **Live policy injection** — per-tenant `HarnessPolicy` (thresholds, guard toggles, model
  selection, gate SLA) fetched from apps/api once per run; a fetch failure degrades to code
  defaults rather than crashing the loop.
- **Clinician gate** — a `wait_condition()` race between an `approval` signal and a durable SLA
  timer, with escalation and a terminal abandon bound.

---

## Architecture (Temporal mapping)

| Loop element | Temporal construct |
|---|---|
| policy fetch / transcript NER / retrieval / generate / sensors / persist / finalize | Activity (idempotent, retryable; all I/O + model calls live here) |
| bounded regen loop, optimistic assurance loop | deterministic loop in the Workflow body |
| clinician sign-off gate | `workflow.wait_condition()` on an `approval` Signal raced against a durable SLA timer |
| clinician edit (optimistic path only) | `edit` Signal — re-binds + re-runs the assurance pass |

```
apps/harness/
├── src/harness/
│   ├── main.py                    # FastAPI app (create_app + lifespan); best-effort Temporal connect
│   ├── __init__.py                # __version__
│   ├── core/
│   │   ├── config.py              # pydantic-settings: Settings (HARNESS_*) + Temporal/Safety/Phi/
│   │   │                          #   Retrieval/ClaimCheck sub-configs
│   │   ├── logging.py             # structlog JSON logging (+ OTel trace context)
│   │   └── llm_concurrency.py     # shared per-endpoint LLM concurrency governor + rate-limit retry
│   ├── api/endpoints/
│   │   ├── health.py              # GET /health, /health/live, /health/ready
│   │   ├── internal.py            # document:start, signal/approve, signal/edit (apps/api → harness)
│   │   ├── admin.py               # workflow-ops: list/describe/cancel/terminate/signal
│   │   └── knowledge.py           # institutional-knowledge ingest (chunk → embed → Qdrant upsert)
│   ├── guides/retrieval/          # institutional RAG (Phase 3): retriever, Qdrant store, sparse
│   │   │                          #   (fastembed BM25), chunker, StrictCitations prompt block
│   ├── guards/phi/                # fail-closed PHI egress guard (Presidio + clinical NER, optional
│   │   │                          #   `guardrails` extra); egress.py is the activity-facing chokepoint
│   ├── sensors/
│   │   ├── computational/         # 5 deterministic gate sensors (Phase 1)
│   │   ├── inferential/           # 4 model-backed gate sensors (Phase 2/3/E2)
│   │   ├── registry.py            # canonical computational-sensor order + factory
│   │   └── aggregator.py          # pure verdict aggregator (PASS / REGEN / FLAG policy)
│   ├── services/                  # typed httpx tool clients: api_client, smr_client, nlp_client,
│   │   │                          #   embeddings_client, reranker_client, sensor_runner, provenance
│   ├── temporal/
│   │   ├── workflows.py           # HarnessPingWorkflow + HarnessDocWorkflow — deterministic bodies
│   │   ├── activities.py          # every activity the workflow calls (I/O + model calls)
│   │   ├── models.py              # workflow/activity input & result dataclasses/pydantic models
│   │   ├── claim_check.py         # out-of-band blob store (TASK-483 Temporal-history budget)
│   │   ├── client.py              # get_temporal_client() — env-configured address/namespace
│   │   └── worker.py              # worker entrypoint: python -m harness.temporal.worker
│   ├── eval/                      # standalone PDSQI-9/faithfulness/ICC eval harness (see eval/README.md)
│   └── tests/                     # pytest: unit/ (hermetic) + integration/
├── eval/                          # non-Python eval assets (promptfoo) — see eval/README.md
├── Dockerfile                     # multi-stage on hope-python-base; built from the REPO ROOT context
├── pyproject.toml                 # PEP 621 + uv; opt-in extras: eval, guardrails, rag, atomic-fact
└── .env.example
```

---

## The document loop (`HarnessDocWorkflow`)

One workflow instance per consultation, id `harness-doc-{consultationId}` (deterministic ⇒
`document:start` is idempotent — a second start on an already-running loop is a no-op). The body
(`temporal/workflows.py`), in order:

1. **Policy** — `fetch_policy` reads the tenant's `HarnessPolicy` from apps/api once. Success
   overrides the gate budget/SLA, sensor thresholds, guard toggles, and model selection; a fetch
   failure degrades to the code defaults and flags `reduced_assurance` (an unreachable policy
   endpoint must never silently *relax* a stricter tenant policy).
2. **Transcript NER** — `extract_entities` runs medical NER over the transcript via NLP. When
   `HARNESS_NER_PRIORS_ENABLED` is on, it first tries to reuse already-persisted, ontology-coded
   `NamedEntity` rows instead of a cold pass. An NLP outage degrades (forces human review) rather
   than crashing.
3. **Institutional retrieval** — `retrieve_context` runs once, before the regen loop (stable across
   regens). Off by default (`HARNESS_RETRIEVAL_ENABLED=false`); when enabled it builds a query from
   the extracted entities and runs the hybrid retriever (see below). A backend outage degrades to
   an empty context, never raises into the loop.
4. **Bounded regen loop** — `assemble_prompt → generate → extract_entities(note) → run_sensors`,
   then `aggregate()` the five computational results. `REGEN` while `regens_used < max_regen`
   loops back to `assemble_prompt`; otherwise the loop proceeds.
5. **Delivery — two shapes, chosen by `optimistic_delivery_enabled` (policy/settings kill-switch)
   and a Temporal patch marker**:
   - **Legacy (default)** — `run_inferential_sensors` runs *inside* the loop and its verdict is
     folded into the same `aggregate()` call as the computational sensors (another `REGEN` loops
     back). Once settled, `persist_draft` writes the full-scored draft straight to
     `PENDING_REVIEW`.
   - **Optimistic (`optimistic_delivery_enabled`)** — the computational verdict alone triggers an
     early `persist_draft` (`phase=DRAFT_PENDING_SENSORS`, verdict withheld) so the clinician can
     start reading immediately. An **assurance loop** then runs `run_inferential_sensors` as a
     post-delivery pass:
     - an `edit` signal during assurance re-binds the pass to the edited content and re-runs it
       (capped by `max_edit_reruns`), and permanently disables silent regen-if-untouched;
     - an untouched draft with a `REGEN`-fixable verdict is silently regenerated + re-delivered
       once (budget permitting);
     - a settled `FLAG` verdict **retracts** the delivered draft (`retract_draft` — apps/api marks
       it `RETRACTED` + writes the WORM audit) instead of silently backfilling the flag — the
       safety net for the accepted pre-assurance sign-off window; the workflow completes terminally
       without a clinician gate. Anything else **finalizes** (`finalize_assurance` backfills the
       verdict, flips `DRAFT_PENDING_SENSORS → PENDING_REVIEW`).
6. **Clinician gate** — `workflow.wait_condition()` on the `approval` signal, timing out at
   `gate_sla_seconds`. A timeout calls `escalate_gate` (records the breach to apps/api) and resets
   the wait to `gate_escalation_seconds`; this repeats until either approval arrives or
   `gate_max_escalations` is hit, at which point the loop **abandons** (completes terminally,
   `approved=false`, draft stays `PENDING_REVIEW` for manual handling — it never waits forever).
7. **Record** — a late approval (including one racing the final escalation) records the
   `GATE_DECISION` WORM audit via `record_gate_decision` and the workflow completes,
   `approved=true`.

Fail-safe invariants baked into every step: an SMR (generation) failure always **propagates** —
no draft is ever persisted from a failed generation. Everything else (NLP, retrieval, the
inferential pass, a policy fetch) **degrades** rather than raising: a degraded/missing input is
never a silent auto-`PASS` — the aggregator forces `FLAG` (human review) instead. Progress is
reported to a live UI feed (`report_progress`, best-effort/fire-and-forget) at each major stage
transition; a `phase()` query exposes the current stage for ops/tests.

Replay safety: every behavior added after the original loop shape (progress reporting, the
optimistic delivery split, the gate terminal-abandon bound, edit-rerun caps, retraction) is gated
behind a `workflow.patched(...)` marker so an in-flight execution recorded before that change keeps
replaying its original command sequence. Changing the *sequence* of activity calls always needs a
new patch marker + a captured replay fixture (`src/harness/tests/unit/temporal/test_replay_compat.py`)
— adding a data-only field to an existing activity input does not.

---

## Sensors

Two tiers, both instantiated fresh per run and folded by the same pure `aggregate()` (in
`sensors/aggregator.py`). Policy: a **degraded** or **missing-expected** sensor always forces
`FLAG` (never silent auto-PASS); a **highest-harm** failure is never auto-regenerated (`FLAG`
straight away); a **regen-fixable** failure loops back to generation while budget remains, then
escalates to `FLAG`.

| Sensor | Tier | Failure class | What it checks |
|---|---|---|---|
| `entity_faithfulness` | computational | highest-harm | Every clinically-material entity in the note traces back to the transcript (no fabricated findings) |
| `numeric_dose` | computational | highest-harm | Dosage/numeric values in the note match the transcript |
| `schema_validity` | computational | regen-fixable | The note conforms to the expected SOAP/response-format shape |
| `coverage_omission` | computational | regen-fixable | No clinically-significant transcript content was silently dropped |
| `citation_presence` | computational | regen-fixable | Claims that should carry a knowledge-chunk citation actually have one |
| `groundedness` | inferential | regen-fixable | Per-claim LLM-judge entailment of the note against the transcript + cited evidence; feeds `ragTriadScore` |
| `citation_verify` | inferential | regen-fixable | Per-claim LLM-judge entailment of each `[[kb:<id>]]` citation against its cited chunk |
| `atomic_fact` | inferential | regen-fixable | Deterministic, judge-free NLI entailment gate (self-hosted; default hermetic `DeterministicOverlapEntailer`, optionally a staged MiniCheck-Flan-T5 GGUF via `HARNESS_ATOMIC_FACT_MODEL_PATH`); opt-in via `HARNESS_ATOMIC_FACT_ENABLED` |
| `safety` | inferential | highest-harm | IBM Granite Guardian content-safety screen (harm/bias/jailbreak/violence/profanity/sexual-content/unethical-behavior) over a selectable engine (LM Studio default; Ollama/Azure/Bedrock) |

The inferential pass (`run_inferential_sensors`) runs the applicable sensors **concurrently**
(`asyncio.gather`) against one calibrated judge client + one Granite Guardian client built once per
call; a per-claim verdict cache is threaded across regen passes so an unchanged claim is never
re-judged. Every cloud-bound field (note → safety provider, transcript + claim premises + knowledge
chunks → judge provider) passes through the PHI egress guard first (see below); a fail-closed block
degrades the whole inferential pass rather than raising into the loop.

---

## Institutional RAG retrieval (`guides/retrieval/`)

Flag-gated off by default (`HARNESS_RETRIEVAL_ENABLED=false`) — the whole feature is additive.
When enabled: `build_query` turns the extracted transcript entities into a dedup'd query string,
which is **dense**-embedded (self-hosted LM Studio `/v1/embeddings` — the query can carry PHI, so
it never leaves the box) and **sparse**-embedded in-process (`fastembed` BM25, `SparseBm25Embedder`).
`KnowledgeQdrantStore.hybrid_query` fuses both via the Qdrant Query API
(`prefetch(dense)` + `prefetch(sparse)` → `FusionQuery(RRF)`), filtered on **both** prefetch
branches by `tenant_id` **and** `status=APPROVED` (the load-bearing tenant-isolation + approval
gate — see `infrastructure/docker/scripts/init-qdrant-collections.py` for the `knowledge_chunks`
collection shape). The fused candidates are reranked by an HF TEI cross-encoder
(`RerankerClient`) and truncated to `top_k_rerank`.

Retrieved chunks are rendered into a **StrictCitations** prompt block
(`build_strict_citations_block`) instructing the model to cite a supporting chunk inline as
`[[kb:<chunkId>]]`; `extract_cited_ids` parses those markers back out **strictly** — an id the
model invents, or one that was never retrieved, is silently dropped rather than trusted, so a
hallucinated citation can never reach `citationsMap` or the citation-verify sensor.

**Degrade-safe is the load-bearing invariant**: an outage of the embeddings client, Qdrant, or the
reranker yields an empty context (`degraded=True`) and flags reduced assurance — it never raises
into the durable loop. An empty *result set* from healthy backends (nothing relevant to cite) is
not a degrade.

`POST /api/v1/internal/knowledge/ingest` (`api/endpoints/knowledge.py`) is the write side: chunks
text, embeds it dense+sparse, and upserts into the same collection with a stable
`uuid5(tenant, document, chunkIndex)` point id (idempotent re-ingest). Called by apps/api's
`IngestKnowledgeDocument` BullMQ processor once a `KnowledgeDocument` is `APPROVED`.

---

## Claim-check (Temporal history budget, `temporal/claim_check.py`)

Temporal records every activity input/output into an immutable, replayed-on-every-pickup workflow
history bounded by a size budget. The loop threads large clinical blobs (transcript, assembled
prompt, generated note, RAG chunk text) through many activities, and the regen loop multiplies
that. The fix is the standard **claim-check pattern**: a blob at/above `min_bytes` (64 KiB by
default, measured in UTF-8 bytes) is written out-of-band and replaced with a small,
content-addressed `ClaimCheckRef` (store/bucket/key/size/sha256); a below-threshold blob stays
inline, unchanged. Activities dereference the ref at their edge (`_resolve_ref` /
`_resolve_knowledge_chunks`) — the workflow body only ever holds the small ref, so history size no
longer scales with blob length or regen count.

Backends (`HARNESS_CLAIM_CHECK_STORE`): `memory` (process-local dict — the **default**, correct
for the hermetic test suite and single-worker local dev; a multi-worker deploy MUST switch to
`s3`, or a cross-worker activity retry fails loud with `ClaimCheckNotFound`) or `s3` (self-hosted
MinIO/S3-compatible; `boto3` is imported lazily so the base install never needs it). A round-trip
mismatch (`ClaimCheckIntegrityError`) or a missing blob (`ClaimCheckNotFound`) always fails loud —
the loop errors and retries rather than silently proceeding on empty/partial clinical text. Writes
are content-addressed (sha256), so a Temporal activity retry re-puts an identical object
idempotently. Toggle the whole feature with `HARNESS_CLAIM_CHECK_ENABLED` (default on).

---

## PHI egress guard (`guards/phi/`)

Every cloud-bound LLM call (the `generate` activity's prompt/system-prompt to a cloud SMR
provider; the inferential pass's note/transcript/citations/knowledge-chunks to a cloud judge or
safety provider) passes through `ensure_egress_safe` / `ensure_inferential_egress_safe`
immediately before the call. Fail-closed by contract: if `PhiRedactor` (Presidio analyzer +
anonymizer + a clinical-NER recognizer, the optional `guardrails` extra) cannot **confirm** PHI was
removed, the guard raises `PhiEgressBlocked` — the activity blocks the call and degrades rather
than ever risking a silent unredacted leak. A **local** provider (the default deployment — LM
Studio/Ollama) is a pure pass-through, so the guard costs nothing when nothing egresses; only
providers listed in `HARNESS_PHI_CLOUD_EGRESS_PROVIDERS` (default `["azure", "bedrock"]`) trigger
redaction. The effective policy (`phi_enabled` / `phi_fail_closed`) is snapshotted once at workflow
start (from `HarnessPolicy` or the code default) so enforcement is deterministic across replay.

---

## Configuration

Every setting is env-driven (`pydantic-settings`, prefix `HARNESS_`; the Temporal substrate shares
`TEMPORAL_*` with the rest of the platform). Selected knobs — see
[`core/config.py`](./src/harness/core/config.py) and [`.env.example`](./.env.example) for the full,
authoritative list (safety/PHI/retrieval/claim-check each have their own sub-prefix):

| Variable | Default | Description |
|---|---|---|
| `HARNESS_HOST` / `HARNESS_PORT` | `0.0.0.0` / `8866` | Bind |
| `HARNESS_SERVICE_TOKEN` | *(empty)* | Shared `X-Service-Token` — guards inbound internal/admin routes AND authenticates outbound calls to apps/api. Empty disables the guard (local dev only) |
| `HARNESS_MAX_REGEN` | `2` | Regen budget per draft |
| `HARNESS_GATE_SLA_SECONDS` / `HARNESS_GATE_ESCALATION_SECONDS` | `86400` / `43200` | Clinician-gate SLA + re-escalation cadence |
| `HARNESS_OPTIMISTIC_DELIVERY_ENABLED` | `false` | Two-phase optimistic delivery kill-switch |
| `HARNESS_NER_PRIORS_ENABLED` | `false` | Reuse persisted, ontology-coded NER priors instead of a cold transcript pass |
| `HARNESS_RETRIEVAL_ENABLED` | `false` | Institutional RAG retrieval |
| `HARNESS_ATOMIC_FACT_ENABLED` | `false` | Deterministic reference-free atomic-fact sensor |
| `HARNESS_MODEL_CACHE_TTL_SECONDS` / `HARNESS_MODEL_CACHE_MAX_MODELS` | `600` / `1` | Idle TTL + residency bound for the MiniCheck entailer. **Bootstrap fallbacks only** — the runtime values come from the control plane (`harness.modelCache.*`); the TTL is clamped to `[60, 3600]` |
| `HARNESS_SAFETY_PROVIDER` / `HARNESS_SAFETY_MODEL` | `lm-studio` / `granite-guardian-4.1-8b` | Safety-screen engine + model |
| `HARNESS_PHI_ENABLED` / `HARNESS_PHI_FAIL_CLOSED` | `true` / `true` | PHI egress guard toggle + fail-closed posture |
| `HARNESS_CLAIM_CHECK_ENABLED` / `HARNESS_CLAIM_CHECK_STORE` | `true` / `memory` | Claim-check toggle + backend (`memory` \| `s3`) |
| `HARNESS_JUDGE_*` | see `eval/README.md` | The runtime judge (groundedness/citation-verify) reuses the eval harness's judge config verbatim |
| `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` / `TEMPORAL_TASK_QUEUE` | `localhost:7233` / `default` / `harness-task-queue` | Temporal frontend |

---

### Model retention (TASK-530, D-08)

The MiniCheck-Flan-T5 GGUF entailer is **not** immortal. It sits behind the shared
`hope_runtime_models.SyncModelCache` (`cache="harness_minicheck"`): loaded on first use,
re-calibrated on every load including reloads, and released once idle past
`harness.modelCache.ttlSeconds`. Before TASK-530 it lived in a module dict with no TTL,
no bound and no unload, so a worker that verified one document pinned the GGUF for its
whole life.

Two facts an operator needs:

- **It lives in the Temporal WORKER process**, not the FastAPI app — the entailer is built
  inside an activity. The worker runs a 60 s periodic sweep so an idle entailer is released
  even when no further verification arrives. Restarting only the FastAPI app frees nothing.
- **The cache is synchronous on purpose.** `_atomic_fact_entailer` (`temporal/activities.py`)
  is a plain `def` and a `llama_cpp.Llama` construction is a blocking CPU/GPU call, not
  awaited I/O — so the entailer path stays sync and uses the thread-locked sibling of the
  shared cache. Policy, metrics and reason labels are identical to the asyncio one.

A build or calibration failure still falls back to the safe `DeterministicOverlapEntailer`
(never an auto-PASS) — including when a *reload* fails, not just a first load.

Operator runbook: [`docs/operations/inference/model-retention.md`](../../docs/operations/inference/model-retention.md).


## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/health` | Detailed health; echoes the configured Temporal substrate (no dialing) |
| GET | `/api/v1/health/live` | Liveness — always 200 if the process is up |
| GET | `/api/v1/health/ready` | Readiness — 503 unless the Temporal frontend actually responds |
| GET | `/metrics` | Prometheus metrics |
| GET | `/api/v1/docs` | Swagger UI |

### Internal (service-to-service, `X-Service-Token`)

apps/api is the only caller; the Temporal SDK stays isolated in the harness. Mounted under
`/api/v1/internal`:

| Method | Path | Description |
|---|---|---|
| POST | `/internal/consultations/{id}/document:start` | Start the document loop (idempotent on `harness-doc-{id}`) |
| POST | `/internal/workflows/{id}/signal/approve` | Forward a clinician sign-off to the `approval` signal |
| POST | `/internal/workflows/{id}/signal/edit` | Forward a clinician edit of the optimistically-delivered draft to the `edit` signal |
| POST | `/internal/knowledge/ingest` | Chunk → embed → Qdrant upsert one institutional-knowledge document |

### Admin workflow-ops (`/api/v1/internal/harness`, `X-Service-Token`)

Wraps the Temporal client so apps/api's `HarnessOpsClient` can observe/operate the document
workflows; a missing/closed workflow returns 404, a search-attribute outage degrades to a memo +
client-side tenant filter (never a 500).

| Method | Path | Description |
|---|---|---|
| GET | `/workflows?tenantId&status&consultationId&limit&pageToken` | List (visibility query; cursor-paged) |
| GET | `/workflows/{id}?phase=true` | Describe (adds `historyLength`, `pendingActivities`, `memo`, `result`; `phase=true` also queries the loop phase) |
| POST | `/workflows/{id}/cancel` | Request cooperative cancellation |
| POST | `/workflows/{id}/terminate` | Terminate immediately (body `{ reason? }`) |
| POST | `/workflows/{id}/signal` | Forward an arbitrary signal (body `{ signalName, payload? }`) |

#### One-time setup: the `HarnessTenantId` search attribute

`document:start` tags each workflow with a `HarnessTenantId` **Keyword** search attribute (for
server-side tenant filtering in the admin list) and a `tenantId` memo (the fallback). Register it
**once per cluster/namespace**:

```bash
temporal operator search-attribute create --name HarnessTenantId --type Keyword
#   add --namespace <ns> if not "default"
```

If it is not registered, the harness still works — `document:start` retries the start memo-only,
and the admin list falls back to memo + client-side tenant filtering.

---

## Quick start (local dev)

Python **always** runs in the conda env `arcaenv` (HOPE rule).

```bash
# 1. Install the service (editable) into the conda env — pick the extras you need
#    (base install is slim; eval/guardrails/rag/atomic-fact are all opt-in)
conda run -n arcaenv pip install -e "apps/harness[dev,test,eval,guardrails,rag]"

# 2. Start the Temporal dev stack — opt-in via the `temporal` compose profile
docker compose -f infrastructure/docker/docker-compose.yml \
               -f infrastructure/docker/docker-compose.dev.yml \
               --profile temporal up -d temporal temporal-ui
#   Temporal Web UI: http://localhost:8233   gRPC frontend: localhost:7233

# 3. Run the FastAPI app (from the monorepo root)
pnpm harness:dev
#   → http://localhost:8866/api/v1/health   ·   docs: /api/v1/docs

# 4. In a second terminal, run the Temporal worker (required to actually process runs)
pnpm worker:dev
```

The FastAPI app starts even when Temporal is down — it degrades `/health/ready` to 503 rather
than crashing (fail-safe). The **worker** is what actually requires a reachable Temporal server;
without it, `document:start` succeeds (the workflow is scheduled) but nothing executes until a
worker picks it up. Institutional RAG additionally needs LM Studio (dense embeddings), Qdrant, and
a TEI reranker running; the safety sensor needs a Granite-Guardian-capable model loaded on its
configured engine. All of these are individually degrade-safe — the loop still runs (flagged
`reduced_assurance` / forced human review) with any subset down.

---

## Testing

```bash
pnpm harness:test            # all tests (unit + integration), verbose
pnpm harness:test:unit       # unit/ only
pnpm harness:test:cov        # with coverage
pnpm harness:lint            # ruff
pnpm harness:format          # black
pnpm harness:typecheck       # mypy
```

Or directly: `conda run -n arcaenv pytest apps/harness/src/harness/tests/ -v --tb=short`.

**Hermetic by design.** `src/harness/tests/unit/` (the CI-gating suite, ~90 files across
`api/`, `core/`, `eval/`, `guards/`, `guides/`, `sensors/`, `services/`, `temporal/`) needs **no**
live DB, Redis, LLM, or Temporal server: workflow tests run against Temporal's time-skipping
`WorkflowEnvironment` (fetched once on first run), tool clients are stubbed, and the retrieval
suite runs Qdrant in its `qdrant-client` in-memory mode. The GitLab CI job (`test-harness` in
`.gitlab/ci/test.yml`) installs `.[test,eval,rag]` and runs exactly this suite — the `rag` extra is
required at collection time even though `HARNESS_RETRIEVAL_ENABLED` defaults off, because the
retrieval tests import `qdrant_client` directly. A separate, `allow_failure: true`
`harness-eval-gate` CI job wires the release-blocking eval commands (`python -m harness.eval.ci`
+ the promptfoo output-contract check, see `eval/README.md`) — it is diagnostic-only until a
CI-reachable judge backend and the real clinician golden set land.

Workflow **replay-compat** tests (`tests/unit/temporal/test_replay_compat.py`) capture fixture
histories for every `workflow.patched(...)` gate and re-run them against the current workflow
definition — required green before any change to `workflows.py`'s activity call sequence.

`src/harness/tests/integration/` holds tests that need real infra (opt-in, not part of the CI
gate).

---

## Docker

Built from the **repo root** context (it needs the shared `uv.lock` + workspace `pyproject.toml`),
on top of the shared `hope-python-base` image. The production image is baked with the `rag`,
`guardrails`, and `atomic-fact` extras (`uv sync --extra rag --extra guardrails --extra
atomic-fact`) so institutional RAG, the PHI guard, and the atomic-fact verifier are all available
without a rebuild — each still activates only when its own flag/config is turned on.

```bash
docker build -t hope-python-base infrastructure/docker/python-base/
docker build -f apps/harness/Dockerfile --target production -t harness .   # from repo root
docker run -p 8866:8866 harness                              # FastAPI app (default ENTRYPOINT)
docker run harness python -m harness.temporal.worker         # Temporal worker (override the command)
```

---

## Evaluation harness (`eval/`)

The PDSQI-9 LLM-as-judge, RAGAS-style faithfulness, DeepEval wrappers, judge-calibration
(ICC/Gwet AC2), and golden-set runner are a **separate, standalone** offline eval harness — it
never imports `packages/*` or writes to Postgres, and it is not part of the live document loop.
See [`eval/README.md`](./eval/README.md) for how to run it, the golden-set lanes, judge
configuration, and the current (honest, caveated) live-gate results.

---

## Conventions / deviations

- Mirrors **`apps/smr`** for dependency management (PEP 621 `pyproject.toml` + the shared root
  `uv.lock`), multi-stage Dockerfile on `hope-python-base`, `structlog` logging, pydantic-settings
  config, and the standardized health contract.
- Like the other Python services, the package is **editable-installed** into `arcaenv`; `pytest`
  also sets `pythonpath = ["src"]` as a safety net so tests run pre-install.
- Heavy/optional dependencies (`qdrant_client`, `fastembed`, `presidio`, `llama_cpp`, `boto3`) are
  imported **lazily** inside the functions that need them (not at module top level), so a slim
  install (or a slim runtime image) degrades feature-by-feature instead of import-crashing the
  whole app; `tests/unit/test_import_surface.py` locks this in (`create_app()` + the worker module
  must import even with the optional extras hidden).
- The Temporal dev stack is **opt-in** behind the compose `temporal` profile, mirroring the
  existing Vault precedent, so the default infra stack is unchanged.
