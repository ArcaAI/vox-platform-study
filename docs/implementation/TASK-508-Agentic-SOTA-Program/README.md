# TASK-508 — Agentic SOTA Program: Observability, Control Plane & Production Inference

- **Status**: In Progress (owner-approved 2026-07-19; execution running P0 → P6, see [Program Tracker](./TRACKER.md))
- **Numbering**: renumbered `TASK-507` → **`TASK-508`** at open time — `TASK-507` was already claimed by `TASK-507-ASR-Pipeline-Model-Catalog-Refresh` (In Progress). Per owner decision, **child ticket numbers are unchanged (508–522)**; the program shares number 508 with its Phase 0 child and is disambiguated by directory name.
- **Owner run decisions (2026-07-19)**: execute P0 → P6 continuously with a checkpoint report per phase · Figma design-approval gate **waived** for TASK-512 (build against rules 11/12/13 + `ScreenTemplate`, record waiver in the child README) · GPU/tier-hardware suites and live-engine e2e **deferred to the owner** · Phase 7 (E2E) not in this run.
- **Type**: infrastructure (program) — child tickets are `feature` / `refactor` / `infrastructure`
- **Source**: owner directives 2026-07-19 layered on the [external SOTA report gap review (2026-07-18)](../SOTA-Track/2026-07-18-external-sota-report-gap-review.md); supersedes that review's §8 ticket table
- **Owner surfaces**: planning only — every code change belongs to a child ticket with its own exclusive file-ownership manifest (TASK-449 orchestration convention)

---

## 1. Requirement Analysis

Owner directives (2026-07-19), verbatim intent:

1. **Generation effort/output metrics** — for every LLM call capture: **stop reason, total time, time-to-first-token, tokens per second, prompt tokens count, predicted tokens count, total tokens count**.
2. **Ordered session observability** — monitor each working session **in order**: tool call, thinking, etc. (a trajectory: the ordered sequence of steps an agentic session takes).
3. **Global-admin agentic control plane** — global admin can **control, monitor and configure**: the agentic loop, agent instructions (prompts), tools, external tools via **MCP**, context-management strategies, etc.
4. Everything to **SOTA best practices**.
5. Delivery discipline: phased plan, **very detailed, TDD** (unit tests during implementation, **E2E at last**), explicit update-vs-new per change.
6. Engine split: **LM Studio + Ollama stay for local dev/testing; production runs vLLM and llama.cpp** — follow-up tickets for the new provider services.

Carried into this program from the gap review (the owner asked for the plan "once we have detailed review documented"): the review's gap register (G1–G9 accuracy, P1–P6 performance, E1–E5 eval/observability, R1–R2 regulatory, D1–D8 defects).

### SOTA grounding for the three new areas

| Area | SOTA practice this plan encodes |
|---|---|
| Per-call metrics | **OpenTelemetry GenAI semantic conventions** (`gen_ai.*` span attributes: `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.request.model`; metrics: `gen_ai.client.token.usage`, `gen_ai.server.time_to_first_token`, `gen_ai.server.time_per_output_token`) as the naming standard; Prometheus histograms for fleet aggregates; engine-native counters preferred over client estimates (llama.cpp `timings`, Ollama `eval_count/eval_duration`, OpenAI-wire `usage` + `stream_options.include_usage`, Bedrock `converse` usage/stopReason) |
| Ordered trajectory | Trace-shaped observability (Langfuse/LangSmith-style span trees; the report's "AgentOps; capture reasoning traces for audit"): one ordered, typed step stream per session, correlated to the OTel trace, **stats-first / payload-by-reference** (PHI posture — payloads via claim-check/encryption, never in metrics) |
| Control plane | Config-as-registry with versioning + WORM audit + per-tenant overrides + kill-switches (the platform's own proven patterns: `HarnessPolicy`+CAS+`HarnessPolicyChange`, `AiTaskDefault`, TASK-504 settings-registry/effective-facade); approval-gated prompt publishing; MCP per the 2025-06-18/2025-11-25 specs (streamable HTTP, RFC 8707 resource binding, least-privilege tool allowlists, human gates for writes, no token passthrough) with the harness's fail-closed PHI egress guard in front |
| Production inference | vLLM (continuous batching, automatic prefix caching, structured outputs/`guided_json`, `/metrics`) and llama.cpp server (GGUF, `timings`, GBNF grammars, slots) behind SMR's provider registry; OpenAI-compat wire kept as the portability layer; dev/prod parity via a shared provider contract test suite |

---

## 2. Current State Evaluation (verified on `fix/2605-review`, 2026-07-18/19)

Full inventory: the [gap review](../SOTA-Track/2026-07-18-external-sota-report-gap-review.md). Facts that shape this plan:

**Metrics (ask 1) — closer than expected.** SMR already returns `usage: TokenUsage{prompt_tokens, completion_tokens, total_tokens}`, `finish_reason` (default `"stop"`), `latency_ms` on `GenerateResponse` (`apps/smr/src/smr_v2/models/responses.py:37-52`), has a `usage`-typed `StreamChunk` (`models/stream.py:11`), and Prometheus `TTFT_SECONDS`/`TOKENS_TOTAL`/`GENERATION_LATENCY` (`core/metrics.py`). Missing: **tokens/sec**, **TTFT in the non-stream response**, a **normalized stop-reason enum** (providers pass through raw or default), engine-native timing capture, per-call persistence beyond `SummaryMeta` (which covers only summaries: `inputTokens/outputTokens/processingTimeMs/cacheHit`, `consultation.prisma:225-233`), OTel GenAI spans, and any metrics at all on the **harness** (no Prometheus registry) and **live-doc** call sites.

**Trajectory (ask 2) — building blocks, no spine.** Harness has a 5-stage progress feed (SSE via apps/api), a `phase()` query, WORM `HarnessAuditEvent` (hash-chained, wrong tool for high-volume telemetry), and structlog. SMR relays `reasoning` as a distinct channel but nothing persists it. There is **no ordered per-step record** (LLM call / tool call / sensor / retrieval / thinking) for either the harness run or the live-doc session, no step timings, no admin API to read a session's history in order.

**Control plane (ask 3) — strong substrate, fragmented knobs.** Exists: `HarnessPolicy` (sensor thresholds, safety/PHI toggles, `smrProvider/smrModel`, `maxRegen`, gate SLA, **a dormant `toolAllowlist Json?`** — `harness.prisma:300-338`) with CAS + WORM change log + admin endpoints; `AiTaskDefault` registry (guardrail/nlp keys only; `smr.*` absent — `packages/applications/src/services/ai-task-default/constants.ts:10`); prompt-management module (`apps/api/src/modules/prompt-management/`, `PromptTemplate.status` DRAFT default + `PromptVersion` history + scope tiers); TASK-504 settings-registry/catalog/effective-facade/kill-switch; harness admin workflow-ops (list/describe/cancel/terminate/signal). Missing: context-management knobs are env-only (`HARNESS_*` flags, delta caps, claim-check store), no prompt **approval gating at resolution time**, no tools/MCP registry, no console surfaces, `guardrail.*`-style GLOBAL_ADMIN privilege rule not yet applied to agentic keys.

**Engines (ask 6).** SMR providers: `openai_compat` (LM Studio primary), `ollama`, `azure-openai`, `bedrock` (`apps/smr/src/smr_v2/main.py:71-98`). vLLM/llama.cpp both speak the OpenAI wire, so `openai_compat` can *reach* them today — but with no engine identity, no native timings, no prefix-cache/slots visibility, no GBNF, and `AiModel.provider` values don't include them (`stt.prisma:130`). Guardrail engine selector and the harness `JudgeConfig` are similarly LM-Studio/Ollama/Azure/Bedrock-shaped. No serving infrastructure (compose/k3s) exists for vLLM/llama.cpp; embeddings run through LM Studio (`BAAI/bge-m3`).

**Known constraints (from memory + repo rules) that bind every child ticket:**
- Local dev/test Postgres is `db push`-managed and behind migration history — new migrations are authored + committed but applied locally via `psql`/`db push`, never `migrate reset`.
- `gen:mapper`/`gen:repository` generators crash pre-existingly → **hand-author** new domain trios (only model/entity/factory have CI drift gates).
- Rebuild `@arcaai/database`/`@arcaai/domains` after enum/client changes (vitest reads `dist`).
- New runtime env vars → `turbo.json#globalEnv` + `.env.example` (+ `.env.dev` when dev-relevant).
- `test-harness` CI is hermetic — no live Temporal/DB/Redis in harness unit tests; python deps change ⇒ `uv lock` at root.
- Temporal replay safety: command-sequence changes need `workflow.patched(...)` + a captured replay fixture; additive activity-input fields are command-neutral.
- Admin-console screens are design-gated (rule 12): no screen implementation before its approved Figma frame.
- 404-over-403 tenancy; ETag/If-Match OCC on versioned PATCH; sys-events on mutations; DTO whitelisting.

---

## 3. Architecture Decisions (program-wide)

**AD-1 — One normalized stats contract.** A single `GenerationStats` shape serves ask 1 everywhere:

```
GenerationStats {
  stop_reason:        "stop" | "length" | "content_filter" | "tool_call" | "abort" | "error" | "other"
  stop_reason_raw:    str            # provider-native verbatim (e.g. "end_turn", "eosFound", "stopped_limit")
  total_ms:           int            # request start → last byte
  ttft_ms:            int | null     # request start → first content/reasoning token (stream) or engine-native
  tokens_per_second:  float | null   # predicted_tokens / decode-time; engine-native preferred, client-computed fallback
  prompt_tokens:      int            # engine-native
  predicted_tokens:   int            # = completion/eval tokens (llama.cpp naming per owner ask)
  total_tokens:       int
  provider: str; model: str
  engine_native:      dict | null    # raw timings/usage blob for audit (e.g. llama.cpp `timings`, ollama durations)
}
```

Per-provider source of truth: OpenAI-wire (`usage`, `choices[].finish_reason`, streaming `stream_options={"include_usage": true}` final usage chunk; TTFT client-measured at first delta) · Ollama (`done_reason`, `prompt_eval_count`, `eval_count`, `eval_duration`, `total_duration` → tok/s = `eval_count/eval_duration`) · Azure (OpenAI wire + content-filter → `content_filter`) · Bedrock (`converse[_stream]` `usage{inputTokens,outputTokens,totalTokens}`, `stopReason`; stream `metadata` event) · llama.cpp native (`timings{prompt_n, predicted_n, predicted_ms, predicted_per_second}`, `stopped_eos/stopped_limit`) · LM Studio (OpenAI wire; native `stats` captured into `engine_native` when present). Never fail a generation over missing stats — fill client-computed fallbacks, log divergence.

**AD-2 — Trajectory unifies asks 1+2.** One new operational table, `AgentTrajectoryStep` (ordered, typed, tenant-scoped, **not** WORM, retention-pruned), carries per-step timing/status and embeds `GenerationStats` on `LLM_CALL` steps. `SummaryMeta` keeps headline stats for its note; Prometheus keeps fleet aggregates; OTel spans mirror steps when the exporter is configured. Payload capture (prompts/notes/thinking) is **off by default** and, when enabled by policy, stored only as claim-check refs / Vault-Transit ciphertext (TASK-369 pattern) — never plaintext in an ops table.

**AD-3 — Control plane reuses the house registries.** Loop knobs the *workflow* needs deterministically → additive `HarnessPolicy` columns (fetched via the existing `fetch_policy` activity). Cross-service/agentic feature knobs (context strategy, trajectory capture, tool enablement, MCP) → **TASK-504 settings-registry** catalog namespace `agentic.*` with the effective-facade + kill-switch, `GLOBAL_ADMIN`-only writes using the `guardrail.*` 403 precedent (`ai-task-default.service.ts:84-88`). Model routing → `AiTaskDefault` gains `smr.live` / `smr.finalize` (finishing the documented HarnessPolicy→AiTaskDefault migration). Prompts stay in prompt-management; publishing becomes approval-gated.

**AD-4 — Engine matrix.**

| Environment | Chat/summarization | Safety/judge | Embeddings | Rerank |
|---|---|---|---|---|
| Local dev/test | LM Studio (`openai_compat`) · Ollama | LM Studio (Granite GG 4.1-8B) | LM Studio bge-m3 | TEI :8870 |
| Production self-host | **vLLM** (primary, safetensors/AWQ/FP8) · **llama.cpp server** (GGUF tier: MiniCheck, small utility models, CPU/edge) | vLLM (Granite) or llama.cpp (GGUF) | **TEI embeddings** (bge-m3) | TEI :8870 |
| Cloud posture C2 (optional, governance-gated) | Azure OpenAI / Bedrock (existing providers) | — | — | — |

New first-class SMR providers `vllm` and `llama_cpp` (not just `openai_compat` re-pointed): engine identity in the registry/policy, native stats (AD-1), structured-output control (`guided_json`/GBNF), health+cache metrics. `AiModel.provider` gains `"vllm" | "llama-cpp"` values (free string — no enum migration).

**AD-5 — MCP posture.** MCP client lives **only inside harness activities** (determinism preserved; tools are activities). Global-admin-registered servers (SYSTEM-tenant registry rows, Vault-held credentials), streamable-HTTP transport, per-server tool **allowlist** (reusing `HarnessPolicy.toolAllowlist` + settings), **read-only tools first**, every call emits a trajectory step, PHI egress guard screens outbound args **fail-closed** (an MCP server is a cloud egress unless explicitly marked in-boundary), no token passthrough, write-capable tools deferred behind a later approval-gate design. Browser/gateway never talk MCP directly.

**AD-6 — TDD protocol (applies to every child ticket).** For each behavior: write the failing test first (RED — run it, paste the failure), implement minimal GREEN, refactor with suite green. Unit tests land **inside** the ticket; integration tests only where a real substrate exists hermetically (in-memory Qdrant, Temporal time-skipping env); **all cross-service E2E is deferred to Phase 7** (the owner's "e2e at last"). Layer order per rule 01: database → domains → applications → api → python services → console.

---

## 4. Implementation Plan — Phases

Dependency graph:

```
P0 (defects/foundations)
 ├─► P1 (generation metrics) ─► P2 (trajectory) ─► P3 (control plane + console)
 │                                   │                    │
 ├─► P4 (vLLM + llama.cpp engines) ──┴─(stats/parity)     │
 │        │                                               ▼
 │        └─► P4c (prefix-cache + structured output)   P5 (MCP tools)
 └─► P6 (accuracy wave — parallel where surfaces are disjoint)
                       ▼
              P7 (E2E — last)
```

Child-ticket numbers `TASK-508…522` are suggestions (confirm at open time). Sizes: S ≤ 2 d · M ≤ 1 w · L > 1 w.

---

### Phase 0 — Defect clearance & foundations (`TASK-508`, size S–M)

Blocking hygiene from the review; everything later assumes it.

**Changes (all UPDATE unless marked NEW):**

| # | File(s) | Change |
|---|---|---|
| 0.1 | `apps/harness/Dockerfile` | Install extras in prod image: `uv sync --frozen --package harness --no-dev --extra rag --extra guardrails --extra atomic-fact` (D1) |
| 0.2 | `apps/harness/src/harness/guides/retrieval/{qdrant_store,retriever,sparse}.py` | Move `qdrant_client`/`fastembed` imports to lazy (inside functions/`__init__`) so a slim image degrades instead of import-crashing — belt to 0.1's suspenders |
| 0.3 | NEW `apps/harness/src/harness/tests/unit/test_import_surface.py` | RED first: `test_app_and_worker_import_without_optional_extras` (monkeypatch `sys.modules` to hide `qdrant_client` → `create_app()` + worker module import must still succeed) |
| 0.4 | `.gitlab/ci/test.yml` | Add `harness-eval-gate` job running `python -m harness.eval.ci --golden curated_v1 --gate` + the promptfoo contract check (D4/E1) — allowed-to-fail until Phase 6's golden set, then hard |
| 0.5 | `apps/api/src/modules/harness-admin/harness-admin.controller.ts` (+ `__tests__`) | Expose `GET admin/harness/edit-burden?from&to` → `observabilityService.getEditBurden` (D3); `@CanManage('HarnessPolicy')`-class guard; RED: controller unit test asserting route + tenant scoping + DTO shape |
| 0.6 | SMR/NLP/guardrail configs | Dead-config sweep (D6): delete `AzureOpenAIConfig.deployment_name` OR wire it (decide with owner — wiring is one line in `azure_openai.py` client init); delete unread `CircuitBreakerConfig` fields or wire them into `CircuitBreaker.__init__`; delete dead `use_gpu` fields in NLP or honor them (`device` selection) — prefer *wiring* `use_gpu` (it's the intended contract) |
| 0.7 | `apps/harness/README.md` | Rewrite to current reality (7 workflow eras, sensors, RAG, claim-check, optimistic delivery) (D5) |
| 0.8 | `packages/med-ner/src/types/index.ts` | Default preset `'default'` → `'clinical'` (D7) + stale `KnowledgePipeline` comment fix |
| 0.9 | `infrastructure/docker/scripts/init-qdrant-collections.py` + `consultation.prisma` comment | Decide orphaned `context_items` collection (D2): remove provisioning (recommended) — schema columns stay (additive-safe), annotate "reserved, no writer" |

**TDD order:** 0.3 RED → 0.1/0.2 GREEN → 0.5 RED (controller test) → GREEN → 0.6 (each deletion covered by existing suites staying green; each wiring gets one new unit test) → docs.
**Gates:** `pnpm py:harness:test` · `pnpm py:smr-v2:test` · `pnpm py:nlp:test` · `pnpm test:unit` (api) · `docker build` of the harness image + `docker run --rm <img> python -c "import harness.main, harness.temporal.worker"`.

---

### Phase 1 — Generation metrics contract (`TASK-509`, size M) — owner ask 1

**Goal:** every LLM call in the platform yields AD-1 `GenerationStats`; aggregates in Prometheus; headline stats persisted; OTel GenAI naming.

**1A — SMR core (python).**

*RED first* — NEW `apps/smr/src/smr_v2/tests/unit/test_generation_stats.py`:
- `test_openai_compat_maps_usage_and_finish_reason` (fixture: OpenAI-wire response w/ `usage` + `finish_reason:"length"` → `stop_reason=="length"`, counts exact)
- `test_openai_compat_stream_emits_final_usage_chunk` (with `stream_options.include_usage` stub → `StreamChunk(type="usage")` carries counts; TTFT measured from first `chunk`)
- `test_ollama_maps_eval_counts_and_done_reason` (`eval_count/eval_duration/prompt_eval_count/done_reason:"length"` → tok/s computed from durations)
- `test_bedrock_maps_stop_reason_and_usage` (`stopReason:"max_tokens"` → `"length"`; `guardrail_intervened` → `"content_filter"`)
- `test_azure_content_filter_maps_to_content_filter`
- `test_client_side_fallback_when_engine_omits_usage` (no usage → counts estimated? NO — counts null-safe zeros + `engine_native=None`, tok/s from client timing only; assert no exception)
- `test_stats_never_fail_generation` (mapper raises → generation succeeds, stats degraded, warning logged)
- `test_normalized_stop_reason_enum_covers_all_providers` (parametrized raw→normalized table)

*GREEN* — changes:

| File | Change |
|---|---|
| NEW `apps/smr/src/smr_v2/models/stats.py` | `GenerationStats` (AD-1) + `normalize_stop_reason(provider, raw) -> str` mapping table |
| `models/responses.py` | UPDATE `GenerateResponse`: add `stats: GenerationStats \| None`; keep `usage`/`finish_reason`/`latency_ms` for wire-compat (deprecate in docstring) |
| `providers/{openai_compat,ollama,azure_openai,bedrock}.py` | Each `generate` populates stats from native fields; each `generate_stream` records `t_first_token`, requests engine usage (OpenAI wire: `stream_options={"include_usage": True}`; Ollama: final object; Bedrock: `metadata` event) and emits one `StreamChunk(type="usage", data=stats.model_dump())` before `done` |
| `api/endpoints/generate.py` | Thread stats into the response + idempotency cache; stamp `TTFT_SECONDS` (exists), NEW `TOKENS_PER_SECOND` histogram, NEW `STOP_REASON_TOTAL{provider,model,stop_reason}` counter in `core/metrics.py` |
| `core/observability.py` | When OTel enabled: span per generation named `gen_ai.generate`, attrs `gen_ai.system=<provider>`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons=[...]` |

**1B — Consumers.**

| Surface | Change (each with a RED unit test first) |
|---|---|
| `packages/database` | Additive migration `task_509_summary_meta_generation_stats`: `SummaryMeta.stopReason String?`, `ttftMs Int?`, `tokensPerSecond Float?` (predicted/total derivable from existing `inputTokens/outputTokens`); apply locally via `db push`/psql per the env gotcha; hand-sync domain trio (entity/mapper fields) — generators for mapper/repo are broken, hand-author |
| `packages/applications` `summary.service.ts` + `live-documentation.service.ts` `callSmr` | Parse `stats` from SMR response; persist onto `SummaryMeta`; include in the live-summary SSE payload (`metadata.stats`) — vitest: mocked SMR response → persisted fields asserted |
| `apps/harness` `services/smr_client.py` + `temporal/activities.py#generate` | Return stats alongside content; attach to the activity result (additive field — command-neutral, no patch marker); pytest: stub SMR → stats present in `GenerateResult` |
| Judge/sensor call sites (`eval/judge/providers.py`, `granite_client.py`, guardrail `openai_compat.py`) | Capture the same stats shape into their result objects (used by Phase 2 steps); tests per client |
| Gateway `smr-proxy.controller.ts` | Pass-through (no shaping); e2e deferred to Phase 7 |

**Gates:** `pnpm py:smr-v2:test` (all new tests RED→GREEN evidence pasted) · `pnpm --filter @arcaai/applications test` · `pnpm py:harness:test` · `pnpm --filter @arcaai/database test` · lint/typecheck/`uv lock` untouched (no new deps).

---

### Phase 2 — Ordered session trajectory (`TASK-510`, size L) — owner ask 2

**Goal:** every AI working session (live-doc session, harness run, summary job, eval run) produces an **ordered, queryable, streamable** step record: `LLM_CALL | TOOL_CALL | SENSOR | RETRIEVAL | GUARDRAIL | THINKING | SIGNAL | GATE | PHASE`.

**2A — Database (layer 1).**
NEW `packages/database/src/prisma/db_main/agent-trajectory.prisma`:

```prisma
enum AgentSessionKind { LIVE_DOC HARNESS_DOC SUMMARY_JOB EVAL_RUN @@schema("core") }
enum AgentStepType    { LLM_CALL TOOL_CALL SENSOR RETRIEVAL GUARDRAIL THINKING SIGNAL GATE PHASE @@schema("core") }
enum AgentStepStatus  { STARTED OK ERROR SKIPPED TIMEOUT @@schema("core") }

model AgentTrajectoryStep {
  metaData Json? @map("_metadata") @db.JsonB
  version  Int   @default(1) @map("_version")
  id       String @id @default(uuid(7))
  tenantId String
  consultationId String?
  sessionKind AgentSessionKind
  sessionId   String        // live session id | temporal workflowId | bullmq jobId | eval run id
  runId       String?       // temporal runId when applicable
  seq         Int           // per-(sessionId,runId) monotonic, emitter-assigned
  stepType    AgentStepType
  name        String        // e.g. "generate", "sensor:groundedness", "mcp:terminology.validate"
  status      AgentStepStatus
  startedAt   DateTime
  endedAt     DateTime?
  durationMs  Int?
  stats       Json? @db.JsonB      // GenerationStats for LLM_CALL
  payloadRef  Json? @db.JsonB      // claim-check ref / encrypted pointer — never plaintext content
  errorCode   String?
  correlationId String?
  // standard resource-status + audit fields …
  @@unique([tenantId, sessionId, runId, seq], name: "AgentTrajectoryStep_session_seq_unique")
  @@index([tenantId, consultationId], name: "AgentTrajectoryStep_tenant_consultation_idx")
  @@index([tenantId, createdAt], name: "AgentTrajectoryStep_tenant_createdAt_idx")
  @@schema("core")
}
```

Migration `task_510_agent_trajectory_step`; add to `TENANT_SCOPED_MODELS`; add to `MODELS_WITHOUT_SOFT_DELETE` (ops telemetry — hard retention instead); **hand-author** the domain trio + register repository in `CoreDatabaseModule` + barrels. *RED first:* repository unit test (create/list ordered by seq), cross-tenant fixture reuse.

**2B — Applications service + ingest (layers 2–3).**
NEW `packages/applications/src/services/agent-trajectory/` (`IAgentTrajectoryService`, service, module, dto/, mapper, `__tests__/`):
- `recordSteps(batch)` (idempotent on the unique key — `ON CONFLICT DO NOTHING` semantics via repo `createMany` + duplicate-swallow), `listSessions(consultationId | filters, paginated)`, `listSteps(sessionId, cursor)` (keyset pagination per `cursorPagination.ts` — this table grows), Redis republish to `consultation:trajectory:{consultationId}` for live view.
- *RED:* service tests — batch idempotency (same batch twice → one set of rows), ordering, tenant guard (`assertEqualTenants`), sys-event on write **not** required (telemetry exemption — document it), 404-over-403 on cross-tenant reads.

**2C — Emitters.**

| Emitter | Change + tests |
|---|---|
| **Harness** (the ordered spine) | `temporal/workflows.py`: maintain a deterministic `self._seq` counter; pass `(seq, session meta)` into activity inputs (additive → command-neutral); each existing activity (`fetch_policy`, `extract_entities`, `retrieve_context`, `generate`, `run_sensors`, `run_inferential_sensors`, `persist_draft`, gate events, signals) emits start/end step records through NEW `ApiClient.report_trajectory(batch)` → NEW gateway route `POST /api/v1/internal/harness/trajectory` (service-token, batched, `Idempotency-Key`). Fire-and-forget semantics like `report_progress` (a trajectory outage must never fail the clinical loop) but *batched at phase boundaries* to bound call count. `THINKING` steps: when SMR returns non-empty `reasoning`, emit a `THINKING` step (stats only: reasoning token estimate + duration; payload only if `agentic.trajectory.capturePayloads` policy is on → claim-check ref). *RED:* pytest — a full happy-path workflow (time-skipping env, stub ApiClient) produces the exact ordered step sequence `[PHASE:init, LLM?…]` asserted by name list; replay fixture re-captured only if a marker is added (design keeps it command-neutral — assert via `test_replay_compat` staying green). |
| **Live-doc** (`live-documentation.service.ts`) | Emit steps per flush: `RETRIEVAL?`(none today) → `LLM_CALL:flush` (stats from 1B) → `TOOL_CALL:nlp.classify-tokens` → `GUARDRAIL:groundedness` (when enabled) → `PHASE:publish`. Session = live session id. *RED:* vitest with mocked SMR/NLP → ordered rows recorded. |
| **Summary jobs** (`summary.service.ts` + processors) | One `LLM_CALL` step per generate/pre-summary with stats. |
| **Eval runs** (`harness.eval.ci`) | Optional flag `--trajectory` writing `EVAL_RUN` steps (deferred OK). |

**2D — Read APIs + SSE (layer 4).**
- `apps/api/src/modules/agent-trajectory/` NEW controller: `GET admin/agent-trajectory/sessions?consultationId&kind&from&to` + `GET admin/agent-trajectory/sessions/:sessionId/steps?cursor` (`@CanManage('HarnessPolicy')`-family permission — introduce `@CanManage('AgentTrajectory')` resource), 404-over-403; SSE `GET consultations/:id/trajectory/stream` (ticket-scoped, mirrors live-summary stream). *RED:* controller unit tests (guards, DTO whitelisting, cross-tenant 404).
- **Retention:** BullMQ nightly prune job (default 30 d, `agentic.trajectory.retentionDays` setting) — test with fake timers.
- **Prometheus (harness):** NEW `apps/harness/src/harness/core/metrics.py` — `harness_step_duration_seconds{step_type,name}`, `harness_regen_total`, `harness_gate_decision_total{decision}`, wired where steps are emitted; `/metrics` already mounted. NEW Grafana `infrastructure/grafana/dashboards/agentic-trajectory.json` (p50/p95 per step, regen rate, gate decisions, tok/s + TTFT from SMR metrics).

**Gates:** layer order build/test commands (rule 01 table) + `pnpm py:harness:test` incl. replay-compat 9/9 + evidence that a full local run (dev stack) shows ordered steps for one consultation (manual capture pasted into the ticket README).

---

### Phase 3 — Global-admin control plane (`TASK-511` backend M–L, `TASK-512` console L, design-gated) — owner ask 3 (minus MCP)

**Goal:** global admin can **configure** (loop, prompts, tools, context strategies), **monitor** (Phase 1+2 surfaces), **control** (pause/cancel/signal, kill-switches) — all versioned + audited.

**3A — Config consolidation (backend, `TASK-511`).**

| Knob group | Mechanism (AD-3) | Changes |
|---|---|---|
| Loop knobs already in `HarnessPolicy` | keep | — |
| NEW loop knobs the workflow reads | additive `HarnessPolicy` columns (migration `task_511_harness_policy_agentic_knobs`): `optimisticDeliveryEnabled Boolean?`, `atomicFactEnabled Boolean?`, `retrievalEnabled Boolean?`, `warmStartEnabled Boolean?`, `nerPriorsEnabled Boolean?`, `maxEditReruns Int?`, `regenFeedbackEnabled Boolean?` (Phase 6 consumes) — null ⇒ env default (per-field fallthrough precedent `harness-policy.service.ts:167-179`) | `fetch_policy` DTO + `HarnessPolicyKnobs` + harness `PolicyModel` extended; pytest: policy overrides env; vitest: cascade tests |
| Context-management strategy | settings-registry namespace `agentic.context.*`: `liveDelta.maxChars` (today `MAX_DELTA_CHARS=12000` const), `liveFlush.segmentThreshold`, `liveFlush.idleMs`, `claimCheck.minBytes`, `transcript.mode = whole \| windowed` (windowed lands Phase 6), `tokenBudget.perRun` (enforced once Phase 4 tokenizers land) | catalog entries + effective-facade resolution in `live-documentation.service.ts` (replace consts; kill-switch aware); vitest per knob |
| Model routing | `AiTaskDefault` NEW keys `smr.live`, `smr.finalize` (+ seed rows mapping to current defaults); `HarnessPolicyService.resolveSmrSelection` consults AiTaskDefault first, `HarnessPolicy.smrProvider/Model` as legacy fallback (documented migration); `applySmrModelSelection` in the proxy unchanged | constants + seed `16-ai-task-default.ts` + service tests |
| Privilege rule | `agentic.*` settings keys + `smr.*` task keys writable by `GLOBAL_ADMIN` only — real 403 (the `guardrail.*` precedent, same rationale: privilege on a readable key, not an existence probe) | service guard + tests |
| Prompt governance | Resolution-time gating: `prompt-resolution.service.ts` only resolves templates with `status=APPROVED` for clinical flows (fallback chain unchanged otherwise); NEW `POST admin/prompt-templates/:id/approve` (GLOBAL_ADMIN; writes `PromptVersion` pin + WORM-style change row via existing sys-events); seed templates flip to `APPROVED` in the same migration | RED: resolution test proving a DRAFT department template is skipped → falls through to APPROVED default |
| Agent instructions inventory | read-only admin endpoint `GET admin/agentic/instructions` returning the *effective* instruction set per tenant: resolved prompt tier, judge prompt version pin (PDSQI vendored — expose version/hash read-only, non-editable by license/science), sensor thresholds, safety criteria list | controller + service tests |

All mutations: ETag/If-Match OCC (`@RequiresIfMatch` + `updateWithVersion`) + sys-events + `HarnessPolicyChange`/settings audit rows. Every route `@CanManage(...)` with cross-tenant 404 posture.

**3B — Console (`TASK-512`, design-first).**
Screens (global range 10–19, exact numbers assigned in the capabilities matrix at design time): **AI Operations — Runs** (session list → ordered trajectory timeline w/ per-step stats, gate queue, cancel/signal actions), **AI Operations — Metrics** (TTFT/tok-s/stop-reason/regen-rate panels via BFF → Prometheus or embedded Grafana), **Agentic Policy** (HarnessPolicy + `agentic.*` settings editor w/ If-Match, kill-switches), **Prompt Studio** (template list/versions/diff/test-score/approve), **Tools & MCP** (Phase 5 registry; read-only until then). Process per rule 12/13: brief → Figma frames (default+loading+empty+error, both themes) → **owner approval gate** → TDD build (`__tests__` vitest + axe) → Playwright specs in Phase 7. BFF: all data via `/api/hope/[...path]` proxy; TanStack Query; no new UI primitives outside `@arcaai/ui`.

**Gates:** applications+api suites green; design-gate evidence (frame inventory + approval date) recorded in TASK-512's README before any screen code.

---

### Phase 4 — Production inference engines (`TASK-513` vLLM M, `TASK-514` llama.cpp M, `TASK-515` caching/structured-output M) — owner ask 6

**4A — Shared provider-contract test suite first (RED).**
NEW `apps/smr/src/smr_v2/tests/unit/test_provider_contract.py`: parametrized over ALL registered providers with `httpx.MockTransport`/stub fakes asserting the invariants every provider must hold — `generate` returns content+stats; `generate_stream` yields `chunk* → usage → done`; `response_format json_schema` passes through (or documented emulation); timeout raises `LlmCallTimeout`; `_resolve_model` honors caller model (D-7); registry key/`get_info` consistency. Run against existing 4 providers first (locks current behavior), then the two new ones must pass unchanged.

**4B — `TASK-513` vLLM provider + serving.**

| Change | Detail |
|---|---|
| NEW `apps/smr/src/smr_v2/providers/vllm.py` | Subclass/compose the OpenAI-wire client; registry key `"vllm"`; `SMR_V2_VLLM_` config (`enabled=False`, `base_url=http://localhost:8000/v1`, `timeout_s`, `max_concurrent`); native additions: `stream_options.include_usage` always on; map `finish_reason`; structured outputs via `response_format={"type":"json_schema",…}` (vLLM ≥ 0.8 native) with `extra_body.guided_json` fallback toggle; surface engine identity in stats (`provider="vllm"`) |
| NEW health/cache visibility | `health_check()` hits `/health`; NEW optional scrape helper reading vLLM `/metrics` (`vllm:prompt_tokens_total`, prefix-cache hit counters) re-exported as SMR gauges `SMR_ENGINE_CACHE_HIT_RATE{engine="vllm"}` — feeds 4D measurement |
| Registry/config wiring | `main.py` registration block; `AiModel.provider` seed values + registry rows for the tier's chosen models (per gap-review §7); guardrail engine selector + harness `JudgeConfig.provider` accept `vllm` (maps onto their existing OpenAI-compat clients with the new base_url/config prefix `GUARDRAIL_VLLM_`, `HARNESS_JUDGE_` provider value) |
| Serving infra | `infrastructure/docker/docker-compose.dev.yml` NEW profile `inference`: `vllm` service (pinned `vllm/vllm-openai:<ver>`, `--model` from env, healthcheck, GPU reservation), NEW `tei-embed` (bge-m3) alongside existing reranker; `deployment/k3s/base/` NEW `vllm.yaml` (+ overlay patches, registry component rules, no `latest` tags); `.env.example`/`.env.production` reference blocks; `turbo.json#globalEnv` additions |
| Runbook | NEW `docs/operations/inference/README.md`: model staging per hardware tier (gap-review §7 tables), quantization choices, smoke commands |

*Tests:* contract suite passes for `vllm` (fake); env-gated live e2e file `tests/e2e/test_vllm_live.py` (skipped unless `SMR_E2E_VLLM_BASE_URL`) — run in Phase 7.

**4C — `TASK-514` llama.cpp provider.**

| Change | Detail |
|---|---|
| NEW `apps/smr/src/smr_v2/providers/llama_cpp.py` | Native `/completion` client (richer than the OpenAI shim): send `json_schema` (server-side grammar) or GBNF `grammar`; parse `timings{prompt_n, predicted_n, predicted_ms, predicted_per_second}` + `stopped_eos/stopped_limit/stopping_word` → exact AD-1 stats (this engine is the *reference* for the owner's metric names); streaming via SSE lines; registry key `"llama-cpp"`, `SMR_V2_LLAMA_CPP_` config |
| Serving | compose `inference` profile `llama-cpp` service (pinned `ghcr.io/ggml-org/llama.cpp:server-<tag>`, `-m` GGUF path, `--slots` visible healthcheck); k3s manifest; this engine also formalizes hosting for the **already-GGUF** components (MiniCheck scorer path stays llama-cpp-python in-process — unchanged; document the distinction) |
| Config surfaces | guardrail + judge accept `llama-cpp`; `AiModel.provider` value |

*Tests:* contract suite (fake `/completion` server incl. `timings` fixture → stats exactness asserted: `predicted_per_second` passthrough vs client-computed divergence < tolerance); grammar passthrough test; stop-reason mapping (`stopped_limit → "length"`).

**4D — `TASK-515` prefix-caching + structured-output program (rides on 4B/4C).**
1. **Prompt reorder (cache-friendliness)** — `live-documentation.service.ts#buildSmrUserPrompt`: reorder to `[stable system] + [transcript-so-far, append-only] + [current note] + [delta instruction]`; harness `assemble_prompt`: hoist the invariant blocks (template, RAG StrictCitations block, transcript) into a stable prefix ordering across regen iterations. *RED:* prompt-builder unit tests asserting byte-stable prefix across two consecutive flushes/regens given constant inputs.
2. **Measurement** — new Grafana panel from 4B's cache-hit gauge; acceptance: TTFT p50 improvement on a scripted 10-flush live session against vLLM, before/after numbers pasted (owner-run on tier hardware).
3. **Structured output + bounded auto-repair** — enable `json_schema` on vllm/llama-cpp paths for SOAP + judge calls; NEW shared repair step in `packages/applications` summary paths + live-doc: on parse failure, ONE corrective retry appending the seeded `CORRECTIVE_RETRY` template content; keep the tolerant parser as final fallback. *RED:* vitest — invalid-JSON first response + valid second → repaired, exactly one retry, both trajectory steps recorded; harness `jsonio` untouched (its tolerant parse is the judge's fallback).

**Gates:** `pnpm py:smr-v2:test` (contract suite = the evidence) · compose profile boots on a GPU host (owner-run, evidence in ticket) · lint/typecheck · `uv lock` (new python deps: none expected — httpx only).

---

### Phase 5 — MCP external tools (`TASK-516`, size L, feature-flagged OFF) — owner ask 3 (MCP)

**Order note:** intentionally *after* the control plane (registry/audit surfaces exist) and engines (stable local stack). All tools **read-only** in this ticket; write-capable MCP tools are a future ticket with an explicit human-approval-gate design.

| Change | Detail |
|---|---|
| DB | NEW `mcp-server.prisma`: `McpServer{ id, tenantId (SYSTEM-only rows initially), name, baseUrl, transport: "streamable-http", authRef (Vault path — no secrets in DB), toolAllowlist Json, phiBoundary: "external" \| "in-boundary", enabled, … }` + migration `task_516_mcp_server_registry`; hand-authored trio; `TENANT_SCOPED_MODELS` update |
| Admin API | `apps/api/src/modules/mcp-admin/` CRUD (GLOBAL_ADMIN real-403 rule; OCC; sys-events; secret material via TASK-504 secrets flow, never echoed) |
| Harness client | NEW `apps/harness/src/harness/tools/mcp_client.py` (official `mcp` python SDK, streamable-HTTP; `uv lock` at root) + NEW activity `call_mcp_tool(server_id, tool, args, seq)` in `activities.py`: resolves server from policy fetch, enforces allowlist (`HarnessPolicy.toolAllowlist` ∩ server allowlist), **PHI egress guard screens `args` fail-closed when `phiBoundary=external`** (reuse `guards/phi`), bounded timeout/retry, result size-capped + claim-checked, emits `TOOL_CALL` trajectory step |
| Workflow integration | opt-in per-loop: `HarnessPolicy` knob `mcpToolsEnabled Boolean?` (default null→off); first integration point = **terminology validation** after `extract_entities` (validate `NamedEntity` codes against a self-hosted FHIR terminology MCP server — closes gap G7's validation half without a UMLS install); command-sequence change ⇒ `workflow.patched("task-516-mcp-tools")` + new replay fixture |
| Security tests (RED first) | pytest: allowlist deny raises before any network call · PHI-bearing args + `external` boundary → blocked fail-closed · server 5xx → step recorded `ERROR`, workflow degrades (verdict `reduced_assurance`, never crash) · no credential material ever appears in logs/trajectory (assert scrubbing) · tool result over size cap → claim-checked |
| Console | "Tools & MCP" tab from TASK-512 becomes writable (design-gated addendum) |

**Gates:** `pnpm py:harness:test` incl. new replay fixture + all security tests · `uv lock` diff reviewed · flag stays OFF by default everywhere.

---

### Phase 6 — Accuracy wave (parallel tickets, disjoint surfaces) — carried from the gap review

| Ticket | Scope + TDD sketch |
|---|---|
| `TASK-517` Critique-informed regen (S–M) | RED: workflow test — REGEN iteration 2's `assemble_prompt`/`generate` input contains the prior iteration's failed-sensor findings (names + failing claims + expected fixes); pytest fixture drives one failing `numeric_dose`. GREEN: aggregator verdict details threaded into the regen call (additive activity input → command-neutral; verify replay suite green); prompt suffix built from the seeded `CORRECTIVE_RETRY` + structured findings block; gated by Phase 3's `regenFeedbackEnabled` policy knob (default ON after eval evidence). Evidence: harness-eval regen-success delta on golden fixtures. |
| `TASK-518` Negation/assertion (M) | RED: NLP unit tests — "no chest pain", "family history of MI", "if symptoms worsen" → `Entity.assertion ∈ {PRESENT, ABSENT, FAMILY, HYPOTHETICAL, HISTORICAL}`. GREEN: NEW `apps/nlp/src/nlp/services/assertion.py` (ConText/NegEx-style rule engine over a trigger lexicon; model-swap seam documented); `Entity.assertion` field; additive `NamedEntity.assertion` column (`task_518_named_entity_assertion`); persist through all three writers; `entity_faithfulness` + concept-F1 consume polarity (ABSENT entities excluded from positive-claim checks). |
| `TASK-519` Segment-level transcript + evidence links (L) | RED: applications tests — `createTranscript` with segment metadata persists N `TranscriptSegment` rows (id, idx, t0/t1 ms, speaker?, text, charStart/charEnd into the blob); NER grounding resolves char offsets → segment ids. GREEN: NEW `transcript-segment.prisma` (`task_519_transcript_segments`) + ingest change in `sttInternal.service.ts` (stop dropping `metadata` — D8); prompt instructs sentence-level `[[seg:<id>]]` citations on the **finalize** path (StrictCitations mechanism reused; invalid ids dropped by the parser exactly like kb ids); `SummaryMeta.citationsMap` gains segment evidence; SSE/console click-to-source deferred to TASK-512 addendum. Stream path unaffected (segments arrive on finals). |
| `TASK-520` Guideline corpus + tier enablement (M) | Ingestion runbook for a licensed corpus (PMC-OA/CDC/ICD-11 per TASK-330 §2.6) via existing `knowledge:ingest`; enable `HARNESS_RETRIEVAL_ENABLED` (policy knob from Phase 3) on the pilot tenant; build the retrieval golden set (≥132 pairs, alongside TASK-521); flag-flip matrix per chosen hardware tier (gap-review §7): Sortformer staging + `TASK-489` labels ON, MiniCheck GGUF paths, atomic-fact ON, warm-start/NER-priors ON, optimistic delivery ON, claim-check `store=s3` — **one flip per change with a TASK-470 scorecard or harness-eval re-run as its gate** |
| `TASK-521` Clinician golden set program (S eng + program) | Execute `clinical_v1_spec.md`: assign the clinical SME owner (open decision — owner action), collect N≥132 de-identified cases, 3 blinded raters, human ICC≥0.75; then flip Phase 0's `harness-eval-gate` CI job to hard-fail and re-baseline PDSQI/faithfulness/MiniCheck AC-6 on real data |
| (folded) | G7 tier-2 linker (MedCAT/SciSpacy) and G9 ASR second-pass stay evidence-gated backlog per the review |

---

### Phase 7 — End-to-end validation (`TASK-522`, size M–L) — owner's "e2e at last"

Run only after Phases 0–6 (or the subset shipped) are unit/integration-green:

1. **Gateway E2E (Playwright, `apps/api/tests/e2e/`):** `task-509-generation-stats.spec.ts` (stats present on summary + SSE), `task-510-trajectory-admin.spec.ts` (ordered steps; **cross-tenant 404 contract**), `task-511-agentic-policy.spec.ts` (If-Match 428/412; GLOBAL_ADMIN 403 rule; DRAFT-prompt resolution skip), `task-516-mcp-admin.spec.ts` (registry CRUD, secret never echoed). Start stack via `pnpm test:api:up`.
2. **Console E2E:** Playwright specs per TASK-512 screen (from approved frames) + axe 0-violations per screen, both themes.
3. **Engine-matrix live suites (env-gated, owner-run on tier hardware):** SMR e2e against real vLLM + llama.cpp (`SMR_E2E_*_BASE_URL`), provider parity report (same prompt, all engines: stats fields populated, stop reasons normalized, structured output honored); TASK-470 streaming scorecard re-run (ASR guardrails held after any Phase 6 flips); harness `eval.ci` gate on the Phase-6 golden set; a full **live consultation rehearsal**: record → live-doc flushes (trajectory visible in console) → harness run → sensor gate → approve → attested `SIGNED_NOTE`, with the trajectory + metrics screens showing the entire ordered session.
4. **Evidence:** every suite's actual output pasted into TASK-522's README; program status flips to Completed only with this evidence.

---

## 5. Program sequencing & effort summary

| Phase | Tickets | Size | Parallelizable with |
|---|---|---|---|
| 0 Foundations | 508 | S–M | — (first) |
| 1 Metrics | 509 | M | 4A/4B prep, 6 tickets |
| 2 Trajectory | 510 | L | 4, 6 |
| 3 Control plane | 511 + 512 (design-gated) | M–L + L | 4, 5 prep |
| 4 Engines | 513, 514, 515 | M+M+M | 1–3 (disjoint surfaces) |
| 5 MCP | 516 | L | after 3; parallel with 6 |
| 6 Accuracy | 517–521 | S→L each | 1–5 (disjoint) |
| 7 E2E | 522 | M–L | last, by definition |

Critical path: **508 → 509 → 510 → 511/512 → 522**, with 513–515 (engines) needed before any *production* deployment regardless of the rest. The single non-engineering long pole remains **TASK-521's SME assignment** — start it immediately.

## 6. Implementation Summary

Phases **0–6 eng** landed 2026-07-19 (owner-approved continuous run). Live status + decisions: [TRACKER.md](./TRACKER.md). Plan-vs-code audit: [AUDIT-2026-07-19.md](./AUDIT-2026-07-19.md).

| Phase | Ticket README | Eng status |
|---|---|---|
| 0 Foundations | [TASK-508-Agentic-Foundations](../TASK-508-Agentic-Foundations/README.md) | Review — COMPLETE_WITH_GAPS |
| 1 Metrics | [TASK-509-Generation-Metrics](../TASK-509-Generation-Metrics/README.md) | Completed (eng) — follow-ups open |
| 2 Trajectory | [TASK-510-Agent-Trajectory](../TASK-510-Agent-Trajectory/README.md) | Completed (eng) — deferred items open |
| 3A Control backend | [TASK-511](../TASK-511-Control-Plane-Backend/README.md) | Completed |
| 3B Console | [TASK-512](../TASK-512-Agentic-Admin-Console/README.md) | Review — Tools&MCP not yet on mcp-admin |
| 4 Engines | [TASK-513-514](../TASK-513-514-SMR-Production-Engines/README.md) | Review — GPU e2e owner-deferred |
| 4D Cache/structured | [TASK-515](../TASK-515-Caching-Structured-Output/README.md) | Completed |
| 5 MCP | [TASK-516](../TASK-516-MCP-External-Tools/README.md) | Review — flag OFF; console upgrade pending |
| 6 Accuracy | [517](../TASK-517-Critique-Regen/README.md) · [518](../TASK-518-Negation-Assertion/README.md) · [519](../TASK-519-Segment-Transcript/README.md) · [520](../TASK-520-Guideline-Corpus/README.md) · [521](../TASK-521-Clinician-Golden-Set/README.md) | 517–519 eng done; 520/521 owner-run docs |
| 7 E2E | [TASK-522](../TASK-522-E2E-Validation/README.md) | Specs authored + typechecked; **live exec owner-run** |

Program status stays **In Progress** until owner ops (520/521/GPU) and Phase 7 live evidence.

## 7. Change History

| Date | Change |
|---|---|
| 2026-07-19 | Program plan authored from the owner's three new requirement areas (generation metrics · ordered trajectory · global-admin control plane) + dev/prod engine split (LM Studio/Ollama dev · vLLM/llama.cpp prod), layered on the 2026-07-18 external-report gap review; supersedes that review's §8 ticket table. Phases 0–7 with per-ticket TDD instructions; numbers TASK-507–522 provisional per CLAUDE.md ticket workflow. No code changed. |
| 2026-07-19 | P0–P6 eng executed (see TRACKER). §6 Implementation Summary filled; audit + retrospective 509/510 READMEs linked. |
