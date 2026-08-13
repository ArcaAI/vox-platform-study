# Agentic Platform Program — Phased Execution Plan (2026-07-20)

- **Status**: Pending (owner approval gate — Phase 1 of rule 01 lifecycle)
- **Type**: infrastructure (program) — child tickets are `feature` / `refactor` / `bugfix` / `docs`
- **Source**: owner directives 2026-07-20 (expectations E1–E8) + [companion findings review](./2026-07-20-agentic-platform-review-findings.md) (gap register GAP-*, defect register D-01…D-21, misalignment register M-01…M-14)
- **Numbering**: child tickets are suggested **TASK-523 … TASK-534** — the highest allocated number in `docs/` + git history is TASK-522 (the 2026-07-19 agentic program). Confirm each number at open time per the CLAUDE.md ticket workflow.
- **Owner surfaces**: planning only — this document owns NO source files. Every code change belongs to a child ticket with its own exclusive file-ownership manifest (TASK-449 orchestration convention, proven again by the TASK-508–522 run).
- **Relation to prior programs**: TASK-508–522 (executed 2026-07-19) closed observability/control-plane/engines/accuracy scope; its docs were removed from `docs/implementation/` in the staged cleanup and remain recoverable at `git show HEAD:docs/implementation/TASK-508-*`. This program picks up the residuals that review left open **plus** the four new owner requirement areas: config-plane completion (E2/E5), template-pipeline governance (E4), unified model lifecycle (E6), and route/IA cleanup (E7).

---

## 1. Requirement analysis → phase map

| Owner expectation | Primary phases | Gap/defect IDs addressed |
|---|---|---|
| E8 defects/lint/typecheck/build green | **P0** | D-01…D-06, D-13…D-15, D-16…D-21 |
| E2 DB-backed runtime config, avoid env | **P1**, P3 | GAP-C1, C2, C5, C6, C7; D-11, D-19 |
| E5 provider-specific management | **P1, P2** | GAP-C1…C4; D-10, D-12 |
| E3 guardrail/nlp global-admin-only | **P5** (+P0 doc drift) | GAP-G1, G2; E3-L1/L2, D-16 |
| E6 load-on-request, 1 min–1 h, VRAM-aware | **P3** | GAP-L1…L4; D-07…D-10 |
| E4 template pipelines | **P4** | GAP-T1…T3; D-13 |
| E7 routes/interfaces | **P5** | M-01…M-14 |
| E1 SOTA agentic loop residuals | **P6** | GAP-A1…A9; D-22…D-28; enablement matrix |
| Verification | **P7** | cross-cutting |

Dependency graph (phases can overlap where lanes are disjoint — see §4):

```
P0 defect clearance ─┬─► P1 config-plane core (DB→domain→app→api)
                     │        │
                     │        ├─► P2 model sources + discovery
                     │        ├─► P3 lifecycle & retention (needs P1's settings write-lane)
                     │        ├─► P5 governance + console IA (needs P1 read surfaces)
                     │        └─► P6-B agentic context/budget/mining (needs P1 write-lane)
                     ├─► P4 template governance (independent of P1)
                     ├─► P6-A loop defect closure (independent — parallel to P1)
                     └─► P6-C enablement (owner/hardware-gated, anytime after P6-A)
                                        │
                              P7 E2E validation (last)
```

---

## 2. Methodology & delivery discipline (binding for every child ticket)

This section is the "how we work in parallel" contract. It restates only what the repo already enforces, plus program-specific rules.

### 2.1 Per-ticket lifecycle (rule 01 — no phase skipped)
1. **Receive & confirm** — confirm ticket number, restate requirement, classify.
2. **Explore** — code-verified Current State Evaluation in the child README **before** any code (each ticket below already carries the program-level evidence; the child re-verifies its own file list because the tree moves).
3. **Plan** — child README (`docs/implementation/[TASK-52x]-[Name]/README.md`) with the TDD test list and the file order, approved before code.
4. **Implement** — TDD Red→Green→Refactor. RED runs are pasted into the README (a test that never failed verifies nothing). Layer order: database → domains → applications → api → python services → console.
5. **Verify & document** — paste actual gate output; update README Implementation Summary + Change History.

### 2.2 TDD protocol specifics
- Unit tests land **inside** the ticket, colocated per repo convention (`__tests__/*.test.ts`, `apps/<svc>/tests/` or in-package `src/<pkg>/tests/`).
- Integration tests only where a hermetic substrate exists (in-memory Qdrant, Temporal time-skipping, test Postgres via `pnpm infra:test:up`). The harness CI suite stays hermetic (no live Temporal/DB/Redis).
- **All cross-service E2E is Phase 7** (owner's "e2e at last" discipline, proven in the 508 run) — specs may be *authored* earlier, executed in P7.
- Every mutation-path test asserts: factory usage on create, `broadcastSysEvent` on mutations, 404-over-403 on cross-tenant, DTO whitelist rejection of undeclared fields, OCC 428/412 on versioned PATCH.

### 2.3 Parallel-team rules (the design-train, adapted)
- **Exclusive file-ownership manifests**: every ticket lists the exact files/globs it owns; two in-flight tickets never share a file. Cross-ticket contracts (DTO shapes, endpoint paths, settings keys) are frozen in this plan's AD sections so dependent lanes can build against them one batch apart.
- **Fresh implementer per task + independent reviewer per task** (the `executing-plans` convention): the reviewer gets the child README + diff, verifies gates, and files findings before the next dependent task starts.
- **Git posture**: agents/developers do not rebase or force-push shared branches; one MR per ticket against `dev`; the ~330 currently-uncommitted files on `fix/2605-review` are the owner's to commit first — **P0 starts only after the owner lands the current tree** (otherwise every manifest collides with the uncommitted wave).
- **Layer-gate commands** (verified in root `package.json`): `pnpm db:migrate` + `db:generate` · `pnpm --filter @arcaai/domains build test` · `pnpm --filter @arcaai/applications build test` · `pnpm api:build` + `pnpm test:unit` · `pnpm py:<svc>:test|lint|typecheck` · `pnpm --filter @arcaai/admin-console build lint test` · `pnpm test:e2e` (P7, API up first).
- **Console screens**: rule 12 design gate applies. The owner waived Figma for the TASK-512 wave; each P5 screen ticket must record either an approved frame or an explicit waiver in its README before implementation.
- **DB rules**: additive migrations named `task_<nnn>_<desc>`; local dev DB is `db push`-managed and behind migration history — author + commit migration SQL, apply locally via `psql`/`db push`, never `migrate reset`. **Generator reality (corrected 2026-07-20 during TASK-524 — the earlier wording understated this):** only `gen:model` scaffolds. `gen:entity`/`gen:factory` are barrel RECONCILERS + schema-coverage checkers that reproduce committed files verbatim and **never create new artifacts**; `gen:repository` is broken; `gen:mapper` is **destructive — never run it** (it strips the `FIELDS_NOT_WRITABLE` `_version` guard from mappers before crashing — one run clobbered 24 mappers and stripped the guard from 18). So a new domain model = `gen:model` + **hand-author entity, factory, mapper AND repository**, then `gen:entity`/`gen:factory` to reconcile barrels and prove coverage. Also add the model to `ResourceType` in BOTH `audit.prisma` (+ `ADD VALUE` migration) and the domain enum if it emits sys-events, or every AuditLog INSERT 500s. Full table: `.claude/rules/03-domain-layer.md` §Generated Code Discipline. Rebuild `@arcaai/database`/`@arcaai/domains` after enum/client changes (vitest reads dist).
- **Temporal**: command-sequence changes need `workflow.patched(...)` + a captured replay fixture; additive activity-input fields are command-neutral (preferred).
- **Env vars**: this program *removes* env authority; the few genuinely new bootstrap vars must go to `turbo.json#globalEnv` + `.env.example` (+ `.env.dev`). Python dep changes ⇒ `uv lock` at root.
- **Code comments**: each ticket's "Comment/doc deltas" row is part of its DoD — stale comments are defects (D-16…D-21 proved they mislead operators).

### 2.4 Lanes (suggested team split)

| Lane | Surface | Tickets (primary) |
|---|---|---|
| A — Data | `packages/database`, `packages/domains` | 524, 527, 531 |
| B — Platform TS | `packages/applications`, `apps/api` | 524, 526, 528, 531, 532 |
| C — Console | `apps/admin-console` | 526, 528, 531, 532 |
| D — STT | `apps/stt` | 523(part), 525, 527, 529 |
| E — LLM services | `apps/smr`, `apps/guardrail`, `apps/nlp`, `apps/harness`, `apps/tts` | 523(part), 525, 527, 529, 533 |
| F — Infra/CI | `.gitlab/ci`, compose, k3s, Grafana | 523(part), 529(part), 534 |

A lane never edits another lane's files inside the same phase; cross-lane handoffs happen at the frozen contracts in §3.

### 2.5 Completion & Cleanup Doctrine (owner directive 2026-07-20 — BINDING for every child ticket)

Three non-negotiable rules, enforced by the per-ticket independent review and part of every ticket's Definition of Done:

1. **Incorrect implementations MUST be cleaned up completely and properly** — never patched around, never left as a coexisting alternative. The wrong mechanism is removed in the same MR that lands the right one; its tests, comments, docs, env vars, seeds, and nav/DTO surfaces go with it. A fix that leaves the wrong path reachable is an incomplete fix.
2. **Partial implementations MUST be finished correctly and properly** — a capability that is scaffolded, dormant, fallback-only, or wired on one path but not the other is either completed end-to-end (schema → service → API → consumer → UI → tests → docs) inside its owning ticket, or explicitly retired under rule 3. "Built but not wired" is not an acceptable terminal state for anything this program touches.
3. **Redundant implementations MUST be cleaned up completely and properly** — where two mechanisms serve one purpose, the program converges on ONE (the AD-contract choice), migrates all consumers, and deletes the loser: no shadow catalogs, no parallel governance mechanisms, no duplicated editors, no convergently-copied code left in place "for safety".

**Binding classification of the current tree** (reviewers verify the owning ticket leaves NOTHING in its column behind):

| Class | Item | Owning ticket |
|---|---|---|
| Incorrect | D-22 stt segment producers (streaming emits nothing; batch emits wrong field shape) | 533-A |
| Incorrect | D-23 `warmStartEnabled` dead console knob shadowing the real env switch | 533-A |
| Incorrect | D-24 MCP triple-orphan (unpatchable knob, unserialized policy fields, stub token resolver) | 533-A |
| Incorrect | D-13 tenant-write-on-SYSTEM error shape (412/raw Prisma instead of clean 404) | 523 (0.10) |
| Incorrect | D-05 private `llama_cpp._internals` imports | 523 |
| Incorrect | D-15 retired `LLM_URL`/`SMR_SERVICE_URL_HTTP`/`NLP_SERVICE_URL(_HTTP)` still in `turbo.json#globalEnv`; misleading `.env.example` blocks; wrong fail-posture comment | 523 |
| Incorrect | D-16/17/18/20 stale comments/copy misrepresenting the security posture; D-06 dead alias re-export | 523 |
| Incorrect | E3-L1/L2 tenant-writable guardrail/PHI/NLP on-off switches (per OD-2) | 532 |
| Partial | D-19/GAP-C7 `agentic.context.*` catalog-only stub (no write route, env-only consumption) | 524 + 533-B |
| Partial | GAP-C1/C2 provider connections + hyperparameters env-only (SMR: zero override of any kind) | 524 + 525 + 526 |
| Partial | D-12/GAP-C3 `localPath` honored only by stt; no S3 source; MiniCheck paths env-only | 527 |
| Partial | GAP-C4 LM Studio/Ollama discovery fallback-only, no admin surface | 528 |
| Partial | GAP-L1/L2 retention env-wired (stt/guardrail), unwired (nlp), absent (harness MiniCheck, tts); no `keep_alive`/`ttl` propagation; no VRAM probe | 529 |
| Partial | D-26 `smr.live` routing built, never invoked · D-25 finalize path missing JSON repair · D-27 OTel dead flag (finish or retire — ticket decides) · D-28 claim-check prod guard | 533-A |
| Partial | GAP-T1/T2/T3 template clones unlocked, clone implicit-only, no resync | 531 |
| Partial | GAP-A2 evidence-link machinery without data or production UI · GAP-A1 gate-edit signal captured but unused · GAP-A6 eval gate `allow_failure` | 533 |
| Partial | M-09 backend admin surfaces (ai-services, instructions, edit-burden, golden-sets) with no screens | 532 |
| Partial | M-05/M-11 tenant `/ai-model-defaults` dead-end screen | 526 |
| Redundant | GAP-C5 dual settings governance (`GlobalSetting` locked-row vs settings registry), `ux-constants` shadow model catalogs, unregistered kill-switches, D-11 dead `GlobalSettingRead` path + orphan `stt.config.*` seed rows | 524 + 525 |
| Redundant | GAP-L1 three convergently-copied `ModelCache` implementations | 529 |
| Redundant | M-02 duplicate global-policy/live-kill-switch editors · M-03 prompt-template governance split across two screens · M-08 `/pstudio` naming collision | 532 |
| Redundant | D-18 `NLP_TASK_KEYS` dead export · dead `LANGFLOW_*` env blocks · `models.nlp.classification` zero-consumer key (wire or retire — 524 decides) | 523 / 524 |

**Quality, performance & conformance gates (every ticket):**
- **Plan conformance**: the reviewer diffs the implementation against this plan's AD contracts and the ticket README; any deviation requires a recorded decision row in the ticket's Change History (the TASK-508 D-xx discipline) — silent deviation is a review blocker.
- **Requirement traceability**: each ticket's DoD re-asserts the E1–E8 items and GAP/D/M IDs it claims to close (§1 map); the reviewer verifies closure is FULL per this doctrine, not partial. TASK-534 verifies the program-level roll-up.
- **Performance**: no hot-path regression without measurement — prefix-cache stability preserved (trailing-suffix rule), retention caches sized to avoid reload storms (clamped TTL floors), semaphore changes preserve in-flight work, VRAM eviction never evicts pinned/in-use models, admin list endpoints paginate (no unbounded scans). Anything measurement-gated (windowing, enablement flips, engine changes) ships with its before/after numbers pasted.
- **Code quality**: house patterns only (rules 02–13 + skills); TDD RED evidence pasted; zero new lint/typecheck warnings (only-warn treated as errors); comment/doc deltas landed with the code — a merged MR leaves no stale claim about its own surface.

---

## 3. Architecture decisions (program-wide, frozen contracts)

### AD-1 — One config plane, three registries, one write-lane

Everything an admin can change at runtime lives behind exactly three DB-backed registries, all already existing (extend, don't invent):

| Concern | Registry | Writes |
|---|---|---|
| Which model serves a task | `AiTaskDefault` (`models.<taskKey>`) | global-admin-only (existing) |
| What a model *is* (identity, source, weights) | `AiModel` | global-admin-only (existing) |
| Provider connections, hyperparameters, retention, concurrency, agentic-context | **settings-registry keys + two new tables (AD-2)** | global-admin-only; tenant lane only for cloud BYO credentials |

**The missing write-lane** (GAP-C7) is built once, in TASK-524: registered keys with `tier: 'global-kv'` become writable through a single route pair —
`GET/PUT admin/settings/registry/:key` — that (a) resolves the descriptor via `HOPE_SETTINGS_REGISTRY.getOrThrow`, (b) enforces `globalOnly` + `editableBy` + `maxScope` **from the descriptor** (one enforcement point, replacing today's hand-rolled per-surface guards), (c) persists to the tier's store (`GlobalSetting` row for `global-kv`/`db-config`), (d) emits a sys-event + audit row, (e) invalidates the `AppSettingsService` cache. `EffectiveSettingsService` gains the missing override lane: DB value → code default (and per-namespace cascades where they exist). The kill-switch fail-safe invariant moves from test-only into the registry assembly path (boot guard).

**Python delivery**: services never read `GlobalSetting` tables directly (except guardrail's existing resolver and stt's pipeline reader, both kept). A new internal endpoint
`GET /api/v1/internal/effective-config?service=<name>` (X-Service-Token guarded, like the existing internal routes) returns the resolved subset each service consumes (retention, concurrency, provider profiles, agentic-context). Services poll it with a 60 s TTL cache + negative-cache fallback to env (exact guardrail `tenant_config.py` pattern — proven fail-safe). Env vars remain **bootstrap fallback only** and their pydantic field docstrings say so.

### AD-2 — Two new tables (Prisma, `@@schema("core")`, house field template)

**`AiProviderConnection`** — where a provider lives + how to authenticate (E5-cloud; generalizes `TenantTtsProviderCredential`):

```prisma
model AiProviderConnection {
  // meta + id + tenantId per house template (SYSTEM row = platform default; tenant row = BYO)
  provider        String   // validated app-side against AI_MODEL_PROVIDERS
  baseUrl         String?  // ollama/lm-studio/vllm/llama-cpp/azure endpoint
  region          String?  // bedrock
  apiVersion      String?  // azure
  deploymentName  String?  // azure (absorbs the GlobalSetting 'smr-azure-deployment' key)
  encryptedApiKey Bytes?   // Vault-Transit via secret-field.util (never returned by any read DTO)
  keyVersion      Int?
  enabled         Boolean  @default(false)
  extraJson       Json?    // provider-specific extras (validated per-provider DTO)
  // resource-status + audit blocks
  @@unique([tenantId, provider])
  @@index([tenantId], name: "AiProviderConnection_tenantId_idx")
  @@schema("core")
}
```

Rules: SYSTEM rows global-admin-only. Tenant rows allowed **only** for cloud API providers (`azure`, `bedrock`, later `sarvam`-class) — the E5 "both global and tenant admin configure endpoint + api key"; self-host engines (`ollama`, `lm-studio`, `vllm`, `llama-cpp`, `built-in`) reject tenant rows (service-layer 403, mirroring `GLOBAL_ADMIN_ONLY_TASK_PREFIXES` style). Resolution: tenant row (enabled) → SYSTEM row → service env fallback.

**`AiRuntimeProfile`** — hyperparameters / context / concurrency (E5: global-admin-only, "default set for all OR each provider"):

```prisma
model AiRuntimeProfile {
  // meta + id + tenantId (SYSTEM-only in this program — hyperparameters are global-only per E5)
  provider      String
  modelSlug     String?  // null = provider-level default; set = per-model override (AiModel.slug)
  temperature   Float?
  topP          Float?
  maxTokens     Int?
  contextLength Int?     // n_ctx for GGUF engines; request ctx budget for API engines
  maxConcurrent Int?
  tpmLimit      Int?
  rpmLimit      Int?
  timeoutS      Int?
  keepAliveSeconds Int?  // retention hint forwarded to server-managed engines (AD-4)
  extraJson     Json?    // engine-specific (n_threads, n_gpu_layers, num_predict, guided_json toggle…)
  // resource-status + audit blocks
  @@unique([tenantId, provider, modelSlug])
  @@schema("core")
}
```

Cascade at request/injection time: explicit request params → `AiTaskDefault.configJson` (per-task tweaks, already exists) → `AiRuntimeProfile(modelSlug)` → `AiRuntimeProfile(provider default)` → service env/pydantic default. The gateway injects the resolved profile alongside `{provider, model}` for SMR/NLP (stateless-gateway contract preserved); guardrail's resolver and stt's reader pick profiles up in their existing DB reads; harness receives them through `fetch_policy`/effective-config.

### AD-3 — Model source resolution (E5-transformer; GAP-C3, D-12)

- `AiModelSource` enum gains `S3` (migration `task_52x_ai_model_source_s3`). `sourceUri` conventions documented on the schema: `hf:<org>/<repo>` (or bare HF id), `file:///abs/path`, `s3://bucket/prefix`. `localPath` remains the operator override with **highest precedence everywhere**.
- One Python resolver per service-family, same contract (mirrored implementation, conformance-tested): `resolve_model_dir(identity) -> Path` — prefers `local_path` (exists-check), else scheme-dispatch: HF → `snapshot_download` (honors `HF_HUB_OFFLINE`); `s3://` → download-once into the service's cache dir (MinIO/S3 client already in every deployment; checksum verify when `AiModel.checksum` set; single-flight lock); `file://` → verify + use.
- Close D-12: guardrail's SQLAlchemy read model adds `local_path` (+ the gateway NLP DTO gains `modelPath?` next to `model_name`); the two MiniCheck weight paths (guardrail groundedness, harness atomic-fact) resolve DB-first (their `AiModel` rows exist: `minicheck-flan-t5-large`) with env fallback.

### AD-4 — Unified model lifecycle & retention (E6; GAP-L1…L4)

- **Contract, not framework**: the three convergent `ModelCache` implementations (stt / guardrail / nlp) are aligned to one documented contract — single-flight load, pin/unpin, idle-TTL sweep, LRU eviction, clamp **[60 s, 3600 s]**, soft ceiling under all-pinned load, load/evict/resident metrics. Preferred packaging: a shared uv-workspace package (`packages/py-runtime-models`, workspace member consumed by stt/guardrail/nlp/harness/tts); fallback if the owner rejects a new workspace member: keep per-service copies + a shared conformance-test template asserting the contract (**owner decision OD-3**).
- **Retention config** (the "only global admin controls retention" requirement): new settings-registry keys, all `globalOnly: true`, `tier: 'global-kv'` —
  `models.retention.ttlSeconds` (default 600, clamp 60–3600) · `models.retention.maxModels.<service>` · `models.retention.vramBudgetMb.<service>` · optional `models.retention.ttlSeconds.<service>` override. Delivered via the AD-1 effective-config endpoint; env become fallback. NLP's unwired cache (D-07) and stt's dead `GlobalSettingRead` path (D-11) are both closed by this lane (the stt seed rows `stt.config.model_cache.*` are migrated into the registry keys and the SQLAlchemy dead model deleted).
- **Adoption**: harness MiniCheck entailer moves onto the cache (bounded, evictable — closes D-08); tts local engines (Kokoro/IndicParler) become lazy load-on-first-request + TTL-evicted (closes D-09; startup `warm_and_register` becomes an optional warmup flag, default off).
- **Server-managed engines**: HOPE forwards its retention decision instead of ignoring it — Ollama requests gain `keep_alive: <resolved ttl>` (closes D-10); LM Studio requests gain the `ttl` field (JIT-loaded models; LM Studio default is 60 min JIT TTL, auto-evict is an ops recommendation documented in the runbook); vLLM/llama.cpp server are resident-by-design on dedicated tiers — documented, with optional vLLM **sleep-mode** (level 1/2 sleep + `/wake_up`) noted as a later opt-in for multi-model GPU sharing, not in this program's scope.
- **VRAM awareness** (GAP-L3): optional `pynvml` probe util in the shared package — before a load, if `free_vram < estimate + headroom`, evict idle (unpinned) LRU entries first; estimates remain the fallback on CPU-only hosts or when NVML is absent. Per-service `vramBudgetMb` bounds multi-service hosts deterministically (no cross-process arbiter daemon — deliberately rejected as over-engineering; single-GPU multi-service hosts get budgets instead).
- **Concurrency** (GAP-L4): per-provider `maxConcurrent` moves into `AiRuntimeProfile`; stt `worker_concurrency`/`streaming_max_concurrent` and guardrail/nlp inference semaphores read effective-config (nlp gains the semaphore it currently lacks entirely).

### AD-5 — Discovery as a first-class admin surface (E5-lmstudio/ollama; GAP-C4)

- New gateway route `GET admin/ai-models/discovery?provider=` (global-admin): merges DB registry rows with the **live** engine listing (SMR `GET /providers` probe → Ollama `/api/tags`, LM Studio/vLLM `/v1/models`), tagging each entry `registered | discovered | registered-missing-on-server`, including load state where the engine reports it.
- `POST admin/ai-models/discovery/register` creates an `AiModel` row from a discovered entry (slug/name/provider/format prefilled; global-admin action, OCC-free create).
- The `/ai-models` console screen (currently nav-hidden) becomes the provider/model hub: registry grid + discovery drawer + "register" action; the ai-task-defaults picker stays DB-only (governance unchanged). `guardrail-providers` gateway route keeps no live fallback (correct — fail-configured), documented.

### AD-6 — Template-pipeline governance (E4; GAP-T1…T3)

- `AsrPipeline` gains lineage: `sourceTemplateSlug String?` + `templateLocked Boolean @default(false)` (clones of the 9 SYSTEM templates get `templateLocked: true`, `sourceTemplateSlug: <slug>`). Migration backfills existing tenant rows by slug-match against the 9 template slugs.
- **Write-guards** (service layer, `PipelineService`): `update`/`delete` on a `templateLocked` row → `ForbiddenException` with the actionable message "Template copies are read-only — clone to customize" (same-tenant rows, so an honest 403 with guidance, not 404; **owner decision OD-1** confirms which of `toggle`(enable/disable) and `setDefault` stay allowed on locked copies — plan default: both stay allowed; only content edits and deletion are locked).
- **First-class clone**: `POST admin/audio/pipelines/:id/clone {name, slug}` — copies YAML + current version as clone-v1, clears `templateLocked`, sets `sourceTemplateSlug` (provenance). Console: "Template" badge, read-only YAML view, prominent **Clone** button on locked rows.
- **Resync** (GAP-T3): `POST admin/tenants/:id/pipelines/resync` (global-admin) + a nightly job (settings-key-gated, default off) — adds missing templates to a tenant and fast-forwards `templateLocked` copies whose YAML still equals their clone-time template version; never touches unlocked (customized) rows. D-13's ugly 0-match errors are fixed in the same ticket (explicit ownership guard → clean 404).

### AD-7 — Governance tightening (E3; GAP-G1/G2)

- `safetyEnabled`, `phiEnabled`, `phiFailClosed` join `GLOBAL_ADMIN_ONLY_POLICY_KEYS` (tenant PATCH carrying them → 403) — **owner decision OD-2** (default: lock all three; a tenant-visible *request* path can come later).
- `pipeline.harnessEnabled` / `pipeline.autoNerEnabled` descriptors gain `globalOnly: true` and the pipeline-policy write path enforces descriptor metadata (via the AD-1 single enforcement point) — tenant/department/doctor rows for those two keys become read-only (**same OD-2 confirmation**; `autoSummaryEnabled`/`dnaStyleEnabled` stay tenant-tier).
- Dedicated RBAC resources `McpServer`, `AgentTrajectory` replace the borrowed `HarnessPolicy` ability on those controllers (M-12) — additive CASL subjects + seed policy update.
- Doc-drift D-16 fixed everywhere in P0 (before the rules change semantics again).

---

## 4. Phases & child tickets

Sizes: S ≤ 2 d · M ≤ 1 w · L > 1 w (per engineer). Every ticket carries: goal, exclusive file manifest, change table (UPDATE vs NEW), TDD plan (RED first — named tests), comment/doc deltas, gates.

**Execution-ready child READMEs (authored 2026-07-20, each with a code-verified Current State, patterns/best-practices section, per-file change tables, ownership manifest, and RED-first TDD plan — the per-ticket detail supersedes the summaries below where they differ):**

| Ticket | README |
|---|---|
| TASK-523 | [Defect & Drift Clearance](../TASK-523-Defect-Drift-Clearance/README.md) |
| TASK-524 | [Config-Plane Core](../TASK-524-Config-Plane-Core/README.md) |
| TASK-525 | [Service Config Adoption](../TASK-525-Service-Config-Adoption/README.md) |
| TASK-526 | [BYO Cloud Credentials](../TASK-526-BYO-Cloud-Credentials/README.md) |
| TASK-527 | [Model Source Resolution](../TASK-527-Model-Source-Resolution/README.md) |
| TASK-528 | [Model Discovery Hub](../TASK-528-Model-Discovery-Hub/README.md) |
| TASK-529 | [Model Lifecycle & Retention](../TASK-529-Model-Lifecycle-Retention/README.md) |
| TASK-531 | [Pipeline Template Governance](../TASK-531-Pipeline-Template-Governance/README.md) |
| TASK-532 | [Governance & Console IA](../TASK-532-Governance-Console-IA/README.md) |
| TASK-533 | [Agentic-Loop Completion](../TASK-533-Agentic-Loop-Completion/README.md) |
| TASK-534 | [E2E Validation](../TASK-534-E2E-Validation/README.md) |

---

### Phase 0 — Defect & drift clearance (`TASK-523`, size M, lanes D/E/F + spot TS) — starts immediately after the owner commits the current tree

Goal: every gate green (E8) and every stale comment corrected (so later phases inherit a truthful tree). No behavior changes beyond the listed fixes.

| # | Fix | Files (owner-lane) | TDD/verification |
|---|---|---|---|
| 0.1 | D-01 `codeSwitching` — add the field to `CreateStreamingSessionRequest`, matching `code_switching` in `apps/stt/src/stt/pipeline/dto.py` (SDK↔Python contract; coordinate with any open ASR ticket owner) | `packages/agentic-sdk-v2/src/types/stt.ts` (lane E/SDK) | existing RED tests in `stt.types.test.ts:58-75` turn GREEN; `pnpm --filter @arcaai/vox typecheck` |
| 0.2 | D-02 unused import | `apps/api/tests/e2e/mcp-admin.spec.ts` (lane B) | `pnpm --filter @arcaai/api lint` |
| 0.3 | D-03 prettier ×71 | `packages/agentic-sdk-v2/**` (lane E/SDK) | `pnpm --filter @arcaai/vox lint` clean |
| 0.4 | D-04 mypy `no-any-return` | `apps/stt/src/stt/transcription/preprocessing.py:288` (lane D) | `pnpm stt:typecheck` |
| 0.5 | D-05 mypy wave: replace `llama_cpp._internals` private imports with public API (or a typed local shim); add per-module `ignore_missing_imports` overrides for genuinely optional extras (`presidio_*`, `qdrant_client`, `deepeval*`) in the two pyproject mypy configs; drop the `unused-ignore` | `apps/guardrail/src/guardrail/services/groundedness_scorer_minicheck.py`, `apps/harness/{pyproject.toml,src/harness/sensors/inferential/minicheck_entailer.py}`, `apps/guardrail/pyproject.toml` (lane E) | `pnpm guardrail:typecheck` + `py:harness:typecheck` clean; harness/guardrail test suites stay green |
| 0.6 | D-06 unused import warning | `packages/ui/src/components/registries/diceui/media-player.tsx` (lane C) | ui build warning gone |
| 0.7 | D-14/M-10 `@StreamScope` on the SMR task stream + console switch to ticket flow | `apps/api/src/modules/streaming/smr-proxy.controller.ts`, `apps/admin-console/src/features/playground-llm/api/client.ts` (lanes B+C) | RED: controller unit test asserting the decorator/ticket handshake; existing stream e2e stays green in P7 |
| 0.8 | D-15 `.env.example` hygiene: correct the Azure block to `SMR_AZURE_*`; remove (after verifying no TS reader) `SUMMARY_SERVICE_PROVIDER` + the SMR-section `LANGFLOW_*` quartet; add the missing `turbo.json#globalEnv` URL vars; fix the guardrail fail-posture comment | `.env.example` (lane F) | doc-only; grep assert in review |
| 0.9 | D-16…D-18, D-20, D-21 comment/copy/dead-code sweep (the four "nlp.* tenant-editable" sites, tools-mcp "read-only", `NLP_TASK_KEYS`, `suggest-diagnosis.request.ts:8`, settings-registry barrel export) | listed files (lanes B+C) | admin-console tests updated where copy is asserted; lint clean |
| 0.10 | D-13 clean-404 hardening: explicit ownership guards in `PipelineService.update()/delete()` (mirrors `setDefault`) | `packages/applications/src/services/stt/pipeline/pipeline.service.ts` + tests (lane B) | RED: cross-tenant update/delete asserts `DataNotFoundException` (not 412/raw Prisma) |

**Out of scope**: anything behavioral from later phases. **Gates**: full §2.3 layer-gate sweep + `pnpm turbo lint` + both mypy lanes. **DoD**: all §5 findings-gates re-run green and pasted.

---

### Phase 1 — Config-plane core (`TASK-524` DB/registry/API, size L, lanes A+B · `TASK-525` service adoption, size L, lanes D+E · `TASK-526` BYO credentials + console, size M, lanes B+C)

**TASK-524 — Provider connections, runtime profiles, and the settings write-lane**

- **Changes**: NEW `ai-provider-connection.prisma` + `ai-runtime-profile.prisma` (AD-2, migrations `task_524_*`); hand-authored domain trios (entities/factories/mappers/repos — generators crash, per constraint); NEW `AiProviderConnectionService`/`AiRuntimeProfileService` (+ symbol tokens, modules, DTO mappers; secret handling via `encryptSecretField` — the util's header comment gains the new consumer, closing its "future consumers" note); NEW controllers `admin/ai-providers` (connections; SYSTEM rows `@Authorize(['manage','all'])`) and `admin/ai-runtime-profiles` (global-admin-only) with OCC; **the AD-1 write-lane**: `PUT admin/settings/registry/:key` + effective-facade override lane + boot-time kill-switch guard + registration of the currently-orphaned keys (`rate-limit.enabled`, `audit-retention.*`, trajectory-retention) into the catalog; UPDATE `smr-proxy.controller.ts` + `ai-inference.controller.ts` to inject resolved profile params alongside `{provider, model}`; UPDATE seeds (SYSTEM connection rows derived from today's `.env.production` values as data, marked placeholder).
- **TDD (RED first)**: `ai-provider-connection.service.test.ts` — tenant row for `ollama` → 403; tenant row for `azure` → allowed; key never in any read DTO; SYSTEM write by tenant admin → 403. `ai-runtime-profile.service.test.ts` — cascade resolution order (model-override beats provider-default beats null); clamp validation. `settings-registry-write.test.ts` — `globalOnly` enforced from descriptor; `maxScope` clamp via `assertWithinMaxScope` (which thereby gains its first production caller); kill-switch boot guard throws on default-ON. Controller tests: OCC 428/412; cross-tenant 404. Update `task-506` count-assert tests knowingly (the 508 run's lesson: seed-count tests break silently otherwise).
- **Comment deltas**: `secret-field.util.ts` header; `ai-task-default.prisma` comment (D-16 already fixed in P0 — extend with the new cascade note); settings-registry `effective-settings.service.ts` header ("override lane lands later" → done).
- **Gates**: database/domains/applications/api build+test; migration SQL reviewed; allow-lists (`TENANT_SCOPED_MODELS`) updated for both new models.

**TASK-525 — Service pull-paths (env → effective-config)**

- **Changes**: NEW gateway internal route `GET internal/effective-config?service=` (service-token; returns retention/concurrency/profile/agentic-context subsets); Python: shared fetch-with-TTL-cache helper per service (guardrail pattern); SMR providers consume injected profile params (temperature/max_tokens/timeouts/max_concurrent semaphore resizing on refresh) with env fallback; guardrail resolver extends its SQL read with profiles + `local_path`; NLP consumes injected params + gains its inference semaphore; stt replaces the dead `GlobalSettingRead` path with the effective-config client for `model_cache`/`workers` keys (delete the dead SQLAlchemy model + migrate the two seed rows into registry keys); pydantic field docstrings across all services annotated "bootstrap fallback — runtime value comes from the control plane".
- **TDD**: per-service RED tests — "profile injected → overrides env default", "endpoint unreachable → env fallback + negative cache", "semaphore resizes without dropping in-flight permits" (smr), "nlp concurrent requests bounded" (new semaphore). Hermetic: stub the gateway with a local fixture server.
- **Gates**: `py:{smr,guardrail,nlp,stt}:test|lint|typecheck`; no new env vars except none (uses existing gateway URL + tokens).

**TASK-526 — Cloud BYO credentials + tenant screens**

- **Changes**: tenant-lane endpoints on `admin/ai-providers` (`GET/PUT/DELETE admin/ai-providers/tenant/:provider` — azure/bedrock only, Vault-encrypted, never echoed); gateway request-time override injection for SMR azure/bedrock calls (mirror of TTS `resolveProviderOverrides`, fail-open per-credential on decrypt error, logged); console: tenant "AI Configuration" screen (M-05/M-11 rebuild of `/ai-model-defaults`): read-only effective task-model table (cascade source shown) + BYO credential cards (set/replace/remove; Configured/None only) — reusing the `/tts-config` interaction patterns; `tts.credential.*` naming joins the same screen family for consistency (no TTS behavior change).
- **TDD**: RED — tenant A sets azure key → tenant B resolution unaffected (cross-tenant fixture); key never in any response body (`toResponse` snapshot); disabled credential → SYSTEM fallback; screen tests: axe 0 violations, both themes, EmptyState → populated states.
- **Design gate**: needs a frame or recorded waiver (rule 12).

---

### Phase 2 — Model sources & discovery (`TASK-527` source resolution, size M, lanes A+D+E · `TASK-528` discovery & hub, size M, lanes B+C+E)

**TASK-527 — S3/local model sources honored everywhere**

- **Changes**: `AiModelSource` + migration; `sourceUri` scheme conventions documented in the schema comment + `admin/ai-models` Swagger; Python `resolve_model_dir` implementations (stt extends its existing loader-precedence util; guardrail/nlp/harness adopt); guardrail read model + NLP gateway DTO gain `local_path`/`modelPath` (D-12); MiniCheck weight paths DB-first (both services) with env fallback; download cache + checksum verify + single-flight.
- **TDD**: RED per service — "localPath set + exists → used, no network"; "s3:// URI → downloaded once, second call cache-hit" (moto/minio test double); "checksum mismatch → hard error, model not served"; "DB row edited → next TTL window picks new path" (guardrail). Enum-sync test: Prisma `AiModelSource` ⇄ Python literals (the TASK-505 enum-sync precedent).
- **Gates**: database + all Python lanes; `uv lock` if boto3/minio client added to any service.

**TASK-528 — LM Studio/Ollama discovery, registry sync, `/ai-models` hub**

- **Changes**: AD-5 routes (`discovery`, `discovery/register`); SMR probe hardening (per-provider timeout, partial-failure shape); console `/ai-models` unhidden + upgraded (registry grid, discovery drawer with `registered|discovered` badges + load state, register action); nav entry `implemented: true`; the ai-task-defaults screen links "manage models" to the hub.
- **TDD**: RED — controller test merging fixtures (discovered-not-registered, registered-missing-on-server); register action creates a valid `AiModel` row (factory asserted); screen tests incl. empty/error/loading skeletons per rule 10.
- **Design gate**: frame or waiver.

---

### Phase 3 — Unified lifecycle & retention (`TASK-529`, size L, lanes D+E+B(F) — after 524/525 land the settings lane)

- **Changes**: AD-4 in full — shared package `packages/py-runtime-models` (or conformance-spec fallback per OD-3): cache contract + NVML probe util + estimates fallback; stt/guardrail/nlp caches converge onto it (behavioral parity tests first); harness MiniCheck adoption (D-08) — bounded, evictable, activity-safe (load inside activities only, never workflow code); tts lazy-load + TTL (D-09; `warmup` flag default off; `warm_and_register` becomes opt-in); Ollama `keep_alive` + LM Studio `ttl` propagation from resolved retention (D-10); new settings keys registered (`models.retention.*` incl. per-service maxModels/vramBudget); Prometheus metrics per service (`model_cache_loads_total`, `evictions_total{reason=ttl|lru|vram}`, `resident_models`, `resident_bytes_estimate`, `vram_free_bytes` when NVML) + one Grafana dashboard; runbook `docs/operations/inference/model-retention.md` (LM Studio auto-evict/JIT recommendation, Ollama `OLLAMA_MAX_LOADED_MODELS`, vLLM resident posture + sleep-mode pointer).
- **TDD (RED first, per service)**: "second request within TTL → no reload (load-count 1)"; "TTL expiry sweep evicts (fake clock)"; "pinned entry survives eviction pressure"; "VRAM probe short → idle LRU evicted before load (NVML stubbed)"; "clamp: admin value 30 s → 60 s, 7200 s → 3600 s"; "retention change via settings → new TTL within one refresh window"; harness: replay-compat untouched (no workflow-code change — cache lives in activities); tts: "first synth request loads; idle unloads; warmup flag preserves old behavior".
- **Comment deltas**: delete stt `GlobalSettingRead` remnants' comments; `minicheck_entailer.py` "loaded once per worker" comment rewritten; tts `main.py` lifespan comment.
- **Gates**: all five Python lanes test+lint+typecheck; hermetic (NVML/pynvml stubbed; no GPU in CI).

---

> **TASK-530 — reserved.** Intentionally unallocated: the concurrency control-plane scope (GAP-L4) is folded into TASK-524 (`AiRuntimeProfile.maxConcurrent`) + TASK-529 (service adoption). If TASK-529 proves too large in execution, split its concurrency work out under this number.

### Phase 4 — Template-pipeline governance (`TASK-531`, size M–L, lanes A+B+C — independent, can run parallel to P1)

- **Changes**: AD-6 in full — schema columns + backfill migration (slug-match against the 9 template slugs; seed constant exported for reuse); `PipelineService` write-guards + clone endpoint + resync service/endpoint/job; provisioning sets lineage on clone (`tenant.service.ts` clone loop); console: Template badge, read-only YAML for locked rows, Clone dialog, resync button on the tenant detail (global admin); e2e spec authored (executed P7): template immutability (403 + message), clone flow, resync adds a 10th template.
- **TDD (RED first)**: applications — "update locked clone → Forbidden with actionable message"; "delete locked clone → Forbidden"; "toggle/setDefault on locked clone → allowed" (per OD-1 default); "clone → new row, `templateLocked=false`, provenance set, version copied"; "resync: missing template added; customized row untouched; pristine locked row fast-forwarded"; "provision sets lineage on all 9". Database — seed test extends the existing `exactly 9` lock with lineage assertions. Console — locked-row UI states.
- **Comment deltas**: `06-stt.ts` policy-correction block gains the lineage note; `capabilities-matrix` row update if screens change.
- **Owner inputs**: OD-1 (toggle/setDefault semantics on locked copies).

---

### Phase 5 — Governance tightening + console IA cleanup (`TASK-532`, size L, lanes B+C — after 524 for the descriptor-enforced write path)

- **Changes**: AD-7 (E3 locks per OD-2; dedicated `McpServer`/`AgentTrajectory` RBAC resources + seed policy rows); M-register execution: M-02 single policy editor (agentic-policy authoritative; harness-policy Global/Live tabs → read-only + deep-link), M-03 fold prompt-studio into `/agents` elevated tab + retire route (redirect), M-04/M-11 naming + tenant screen (landed via 526 — this ticket finishes nav/labels), M-08 `/pstudio` → `/db-studio` rename, M-09 "AI Services" panel (guardrail/nlp status+config read-only from `admin/ai-services/*`; instructions viewer from `admin/agentic/instructions`; edit-burden + golden-sets surfaced on harness observability), M-13 marker comments, M-14 + M-01 rules 12/13 documentation rows (tier 50-59; the "global-admin-only per-tenant-data" sub-pattern).
- **TDD**: RED — policy-service tests for newly locked keys (tenant write → 403); nav-config tests updated (they exist and assert entries); redirect tests for retired routes; new screens: loading/empty/error skeletons + axe + both themes; controller tests for new RBAC subjects (404-over-403 preserved).
- **Design gate**: frames or waivers for the AI-Services panel + merged editors.
- **Comment deltas**: rules `12`/`13` tier tables; `05-nestjs-api.md` imperative-auth note (M-13).

---

### Phase 6 — Agentic-loop completion (`TASK-533`, size L, lanes E+B+C)

Three sub-scopes with different start conditions. The loop **core** is verified sound (findings §3-E1) — this phase closes the wrongly-wired findings, the learning loop, and enablement.

**533-A — Loop defect closure (independent — may start alongside P0):**
- **D-22 TranscriptSegment pipeline**: fix the producer side — streaming ingest writes segment rows; batch ingest writes real speaker/timing (close the producer/consumer field-shape mismatch); regression: a streamed consultation yields non-empty `segment_citations` at both `generate` sites (`workflows.py:660,892`).
- **D-23 warm-start knob unification**: `HarnessPolicy.warmStartEnabled` becomes the real switch consumed by the TS warm-start path (env `HARNESS_WARM_START_ENABLED` demoted to fallback), matching every other policy knob; the console toggle then does what it says.
- **D-24 MCP productionization (GAP-A3)**: add `mcpToolsEnabled` to `UpdateHarnessPolicyRequest` + service + agentic-policy console form; implement `_resolve_mcp_token` against the platform secrets client (Vault path in `McpServer.authRef`); security tests: authRef never echoed, PHI egress guard screens outbound args, allowlist enforced. Flag stays default-OFF.
- **D-25 finalize-repair parity**: wire `bounded-json-repair` into `summary.service.ts` (same one-corrective-retry contract as live-doc).
- **D-26 `smr.live` activation (GAP-A5)**: live-doc call sites pass `task='live'` so the built two-tier routing actually routes; measurement note comparing live-tier latency before/after.
- **D-27/D-28 tail**: implement minimal OTel spans behind the flag or delete the flag (decide in-ticket); deploy-time guard (k3s env + boot warning→error in multi-worker mode) forcing `HARNESS_CLAIM_CHECK_STORE=s3` in production manifests.
- **TDD**: RED per defect — segment-rows-written assertions (streaming + batch fixtures); "policy warmStart=false + env=true → OFF" precedence test; DTO round-trip for `mcpToolsEnabled`; token-resolver returns Vault secret (secrets client stubbed); summary malformed-JSON → repaired; live call site resolves `smr.live` model. Replay-compat: none of these change workflow command sequence (additive inputs only) — assert fixtures stay green.

**533-B — Control-plane-dependent (after 524):**
- **`agentic.context.*` goes live** (GAP-C7/A8): live-doc + harness consume effective values through the AD-1 lane (replacing `LIVE_DOC_* env ?? code default`); console "Agentic Context" tab becomes read-write (global-admin, OCC); `transcript.mode='windowed'` implemented as the first real context-compaction strategy (window + carry-forward summary), measurement-gated.
- **Token budget enforcement (GAP-A4)**: accumulate per-run tokens in the trajectory spine (usage already on every `GenerationStats`), enforce `tokenBudget.perRun` (0 = unbounded preserved) with graceful stop + gate annotation; `$`-cost metric via per-model price table (`AiModel.metaData`), surfaced on AI-Ops Metrics.
- **Evidence links to the clinician (GAP-A2)**: port the click-to-source review UI out of deprecated `ui-playground` into the console consultation view, consuming `citationsMap.segmentId` (depends on 533-A's D-22 fix).
- **Gate-edit mining (GAP-A1 — the top-value item)**: approved-vs-delivered diffs become (a) eval regression-corpus candidates (append-only export reviewed by the golden-set program) and (b) per-department few-shot exemplar retrieval for prompt assembly (explicitly NOT fine-tuning); privacy: PHI-redacted before storage, WORM source untouched.
- **TDD**: "settings change → next flush uses it (no redeploy)"; budget stop test; windowed-mode equivalence-on-short-transcripts test; exemplar retrieval respects tenant/department scope; axe/theme gates on console changes.

**533-C — Enablement & eval hardening (owner/hardware-gated):**
- **Eval CI hard-fail flip (GAP-A6)** once the judge backend is CI-reachable; golden-set program kickoff (SME assignment — owner action, the true long pole; spec `clinical_v1_spec.md` N≥132).
- **Enablement matrix execution** per the 2026-07-18 review §7 hardware tiers: each dormant flag (`retrieval`, `atomic_fact`, `optimistic_delivery`, `ner_priors`, groundedness gates, claim-check→S3, Sortformer, Parakeet) flips via `HarnessPolicy`/settings (columns exist) with its measurement gate; evidence pasted per flip.

---

### Phase 7 — E2E validation & evidence (`TASK-534`, size M, lanes B+F — last)

- Execute the authored e2e specs live (`pnpm test:up:api` + `pnpm test:e2e`): existing agentic suites (renamed `agentic-policy/generation-stats/mcp-admin/trajectory-admin` specs) + new P1–P6 specs (provider connections incl. cross-tenant 404 + secret-never-echoed; runtime-profile cascade; template immutability/clone/resync; discovery register; retention settings round-trip; BYO azure override reaching SMR).
- Cross-tenant contracts: every new admin/by-id surface gets a `*-cross-tenant.spec.ts` (house rule).
- Env-gated live-engine suites (vLLM/llama.cpp/LM Studio/Ollama with real servers; GPU tiers) — owner-run, runbook'd.
- Full gate sweep re-run + evidence pasted into each child README; program README closes with the roll-up.

---

## 5. Consolidated TDD guidance (program-wide)

1. **RED evidence is mandatory** — paste the failing run in the child README before implementing. A test that never failed is not evidence (repo skill: `test-driven-development`).
2. **Test placement**: TS unit colocated `__tests__/`; integration under `**/integration/**` (live test DB via `pnpm setup:test`); API e2e `apps/api/tests/e2e/*.spec.ts` (P7); Python per-service convention (stt/nlp top-level `tests/`, smr/guardrail/harness in-package).
3. **What to always assert on new admin surfaces**: DTO whitelist rejection · OCC 428 (missing If-Match) / 412 (drift) · cross-tenant 404 (never 403) · secrets never in any response · sys-event broadcast on mutation · factory-created entities (`new XxxEntity` is banned).
4. **Python determinism**: pytest-randomly reseeds numpy per-test *after* fixtures — seed inside test bodies or use local `default_rng` (repo memory); fake clocks for TTL tests; NVML/HTTP always stubbed in CI.
5. **Temporal**: replay-compat fixtures re-captured only when a `workflow.patched` era is added; otherwise additive activity inputs (command-neutral). Harness CI stays hermetic.
6. **Console**: vitest + axe 0-violations per screen + both themes + skeleton/empty/error states are DoD, not extras.
7. **Seed-count tests**: any seed change updates the count-assert tests in the same MR (`ai-model-consolidation-seed.test.ts` precedent).

## 6. Code-comment / documentation update ledger

Beyond D-16…D-21 (P0), each phase's "Comment deltas" row is binding. Program-level docs to keep truthful as phases land: `docs/development-patterns-and-standards.md` (new registries + write-lane pattern), `docs/architecture/data-and-domain-model.md` (new tables, pipeline lineage), rules `12`/`13` (tier rows per M-01/M-14), `apps/harness/README.md` (already rewritten once — extend with cache/lifecycle), `docs/operations/inference/README.md` (+ new retention runbook), `.env.example` (fallback-only annotations per service section), `tests/README.md` (new e2e suites).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Config-plane migration changes live behavior silently (the D-07 lesson: wiring a dead field flips real defaults) | Every adopted setting's default reproduces today's effective behavior byte-for-byte; deviations are their own reviewed decision rows (the 508 D-04/D-07 discipline) |
| Two registries during transition (env + DB) drift | Effective-config responses carry `source: db|env-fallback`; a `/health`-adjacent diagnostics block lists which lane served each key (stt binding-health precedent) |
| Secret handling regressions | Only `encryptSecretField`/`decryptSecretField`; read-DTO snapshot tests; reveal flows require step-up (`GlobalSetting.reveal` precedent) — no new reveal for provider keys (Configured/None only) |
| Template backfill mislabels customized pipelines as pristine | Backfill compares YAML hash against the template's clone-time version before setting `templateLocked`; ambiguous rows left unlocked + logged for operator review |
| VRAM probe flakiness across drivers | NVML strictly optional (feature-detect); estimates path remains; CI never depends on GPU |
| Console churn breaks deep links | Retired routes keep redirects for one release; nav-config tests assert the mapping |
| Parallel lanes collide on `packages/applications/src/services/index.ts` barrels | Barrel edits are append-only, one line per ticket, rebased by the lane lead (the 508 run's ownership-manifest discipline) |

## 8. Open owner decisions (blocking the flagged tickets only)

| # | Decision | Default in this plan | Blocks |
|---|---|---|---|
| OD-1 | Locked template copies: are `toggle` (enable/disable) and `setDefault` allowed? | Both allowed; only content edits + delete locked | 531 |
| OD-2 | Lock scope for E3 toggles (`safetyEnabled`/`phiEnabled`/`phiFailClosed`, `pipeline.harnessEnabled`/`autoNerEnabled`) | Lock all five to global-admin | 532 |
| OD-3 | Shared `packages/py-runtime-models` uv-workspace package vs per-service copies + conformance tests | Shared package | 529 |
| OD-4 | S3 source scope: `s3://` only (MinIO-compatible) or also `azure-blob://` | `s3://` only this program | 527 |
| OD-5 | Default retention TTL value (clamped 60–3600 s) | 600 s | 529 |
| OD-6 | Retire `/prompt-studio` route into `/agents` elevated tab (M-03) vs keep both | Fold + redirect | 532 |
| OD-7 | Commit checkpoint for the current ~330-file uncommitted tree (prerequisite for P0 manifests) | Owner commits before P0 | all |

## 9. Change history

| Date | Change |
|---|---|
| 2026-07-20 | Program plan authored from the 2026-07-20 findings review: 8 phases, child tickets TASK-523…534 (numbers to confirm at open), frozen contracts AD-1…AD-7, lane matrix, per-ticket TDD plans, comment ledger, risks, and 7 owner decisions. |
| 2026-07-20 | **§2.5 Completion & Cleanup Doctrine added (owner directive, BINDING)**: incorrect implementations cleaned up completely, partial implementations finished end-to-end, redundant implementations converged and deleted — with the binding classification table (incorrect/partial/redundant → owning ticket) and the plan-conformance / requirement-traceability / performance / code-quality review gates. Doctrine row appended to all eleven child-ticket Change Histories. |
| 2026-07-20 | All eleven child-ticket READMEs authored under `docs/implementation/TASK-52x/53x-*/` (links table added in §4); TASK-530 reservation noted. Ticket-level verification produced findings errata (see the findings doc Change History) and per-ticket refinements: 524 finalizes the AD-2 schemas (incl. empty-string `modelSlug` sentinel + SYSTEM-shared-read analysis), 525 freezes the effective-config endpoint contract + semaphore-resize design, 526 records the injection-point + route-naming decisions, 527 recommends per-service weight-path transports + adds the missing `AiModelSource` enum-mirror test, 528 pins probe-timeout/naming facts, 529 resolves the three-cache delta + Docker workspace-dep open question, 531 encodes the 403-with-guidance + backfill-safety design, 532 encodes descriptor-driven enforcement + RBAC grandfathering, 533 integrates the D-22/23/24 deep verification + gateway-resolved MCP-token design, 534 fixes the spec matrix + run protocol. |
