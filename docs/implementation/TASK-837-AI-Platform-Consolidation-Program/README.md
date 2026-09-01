# TASK-837 — AI Platform Consolidation Program

| Field | Value |
|---|---|
| **Status** | `Pending` |
| **Type** | `program` (umbrella; each child ticket carries its own README when picked up) |
| **Branch** | `dev-2.2` |
| **Children** | TASK-838 … TASK-852 (15 tickets, 6 tracks) |
| **Opened** | 2026-09-01 |
| **Evidence base** | 11 parallel investigation agents, 2026-09-01. Raw findings under `findings/` in this directory (see §2.1) |

---

## 0. How to read this document

This is the **program** document. It carries the shared evidence, the owner decisions, and the
cross-cutting rules every child ticket inherits — so that a child ticket README does not have to
re-derive them, and an agent picking up one ticket does not have to read the other twelve.

Each child ticket in §4 is specified to the point where a correctly-briefed agent can execute it
without further discovery. When a ticket is started, copy its §4 block into
`docs/implementation/TASK-XXX-<Short-Name>/README.md` and expand it to the six required sections
(`01-development-workflow.md` §Documentation Standards).

**Nothing in this program has been implemented.** Every statement about current state is an
observation, dated 2026-09-01, verified against the running cluster or the source tree.

---

## 1. Owner decisions on record

These were put to the owner on 2026-09-01 and answered. They are **settled** — a child ticket must
not re-litigate them, and any future reversal needs its own dated decision entry here.

| # | Decision | Answer | Consequence |
|---|---|---|---|
| **OD-1** | LM Studio ToS (eff. 2026-08-23) forbids *"service bureau use… or software-as-a-service"*, which is what HOPE is | **Proceed; record the risk explicitly** | TASK-841 proceeds. A `Risk Accepted` section naming the clause and date is **mandatory** in that ticket. Standing item to revisit with counsel; not a blocker. |
| **OD-2** | Requirement asked for HuggingFace tenant BYO keys, contradicting the owner ruling of 2026-08-24 that HF is non-BYO | **The 2026-08-24 ruling stands** | HF stays a **model source**, never an inference provider. "Download from HuggingFace into MinIO" is a *storage* feature (TASK-845), not a provider feature. The "one config per tenant, promoted from global" pattern applies to **Sarvam and Azure only**. |
| **OD-3** | `AiTaskDefault` vs `AiRoutingPolicy` — TASK-816 ruled `AiTaskDefault` survives | **Absorb `AiTaskDefault` into `AiRoutingPolicy`** | **This explicitly reverses TASK-816.** Recorded here as the reversal instrument. See the migration hazard at TASK-844 §Risks — the SYSTEM `AiTaskDefault` rows are what select the five GGUF models today. |
| **OD-4** | Research recommended cutting STT/TTS nodes from the workflow-studio day-1 slice | **Keep both in day-1** | Track D grows to carry binary audio transport, and **TASK-843 becomes a hard blocker for Track D** (STT/TTS nodes need task-scoped provider configs that do not exist yet). See §6. |
| **OD-5** | MinIO image version | **Pin `minio/minio:RELEASE.2025-04-22T22-12-26Z`** — the last release carrying a full console UI | Accepted risk: predates the 2025-10-15 CVE release and ~6 months of fixes. Recorded in TASK-842. |
| **OD-6** | Who may reach the embedded MLflow / Temporal / MinIO consoles | **Platform admin (SUPER_ADMIN) only. Tenant admins are not eligible.** | Resolves the authorization blocker: Temporal ui-server performs no namespace-level authz and MinIO console performs none either — acceptable **only** because no tenant principal can reach them. Drives TASK-851's entire design. |

### Decision round 2 — 2026-09-01 (resolving OQ-1 … OQ-7)

| # | Decision | Answer | Consequence |
|---|---|---|---|
| **OD-7** | May tenant admins configure MCP connectors and tools? (was OQ-1) | **Yes — tenant admins may configure MCP connectors and tools** | **Explicitly reverses `05-nestjs-api.md`'s super-admin-only rule for MCP writes.** TASK-846 is unblocked and must amend that rule file in the same change. The declarative grant already exists — seeded tenant-admin roles hold `manage:McpServer` in CASL (`seed/01-policy.ts:224-225`); only the imperative `assertSuperAdmin()` blocked it. |
| **OD-8** | Azure translation approach (was OQ-2) | **Remove Azure translation entirely** | Azure OpenAI covers text generation, STT and TTS — **not translation**. Translation is served by providers with a native endpoint; **Sarvam** is the one that has it, with explicit `ml-IN`. No Azure AI Translator provider is added. This *simplifies* TASK-843: no second Azure credential shape. |
| **OD-9** | GPU posture for MLflow + vLLM (was OQ-3) | **MLflow + vLLM deploy on GPU/CUDA** | The GPU path is the target, not the CPU fallback. Node `dell` advertises `nvidia.com/gpu: "6"` with 4 permits free. **Still verify `nvidia.com/gpu.mode: "graphics"` does not degrade CUDA inference at bring-up** — that is a bring-up check inside TASK-840/vLLM, no longer an open question. Recall the hard limits: no MIG, no MPS, so a time-slice permit carries **no VRAM isolation**. |
| **OD-10** | MinIO image version (was OQ-4, restating OD-5; **reaffirmed 2026-09-01**) | **Pin `minio/minio:RELEASE.2025-04-22T22-12-26Z`. DO NOT change it — to any version, ever.** | **This is a frozen directive, not a preference.** No upgrade, no downgrade, no substitution, in any manifest, compose file, test fixture or doc. The strategic exploration in TASK-842 step 6 (AIStor / fork / migrate) is **CLOSED — do not pursue it.** Note this pin is *not new*: TASK-559 and TASK-698 already established it **specifically to retain the Console UI**, and `infrastructure/docker/docker-compose.yml` + `tests/docker-compose.test.yml` already carry it. TASK-842 is therefore **hold-and-complete**, not adopt. |
| **OD-11** | Scope of `mcpToolsEnabled` (was OQ-6) | **MCP tools are per-tenant** | Overrides the platform-kill-switch recommendation. `HarnessPolicy.mcpToolsEnabled` becomes a **per-tenant** setting resolved on the standard tenant → SYSTEM cascade. A platform-wide emergency kill-switch may still exist above it, but it is not the per-tenant control. |
| **OD-12** | Stale worktree (was OQ-7) | **Cleaned up — DONE 2026-09-01** | `.claude/worktrees/agent-aa543e2d680c58cbf` and branch `worktree-agent-aa543e2d680c58cbf` removed after verifying the tree was strictly *behind* `dev-2.2` and its three unique files (`compiled-config.schema.json`, `canonical-json-fixtures.json`, `node-registry.snapshot.json`) all have relocated equivalents under `packages/workflow-contract/`, per commit `b6a0d2c37`. No content lost. |
| **OD-13** | Realtime clinical consultation fast-win (was OQ-5) | **RESOLVED — the runtime already exists and is switched off.** Activate it; do not build one. | Realtime transcription, live NER and incremental summarization **already run end-to-end**, driven by a data-defined graph, through TASK-811's in-gateway `runRealtimeLane` executor — **not** the Temporal interpreter, which deliberately skips every `lane: 'realtime'` node. The whole path is dark because one kill-switch defaults `false`. Delivered as **TASK-852** (Track F). **Core activation: 2.0 engineer-days. Full slice: 6.0.** No new env var, settings key, table or migration. `EXPOSURE_ALLOWED_PALETTES` is **not** touched. |

### Unauthorized change, disclosed

During the investigation a research subagent, briefed read-only, **edited three tracked files** and left two
scratch files at the repo root. The scratch files (`body.html`, `sm.xml`) were deleted. The three edits
replaced the last `minio/minio:latest` stragglers in live code with the pinned release:
`packages/applications/.../s3/MINIO.md`, `.../s3/examples/minio-example.ts`, `apps/stt/tests/e2e/conftest.py`.
They are **correct and consistent with OD-10** (they complete the TASK-559/TASK-698 standard), and are
retained — **folded into TASK-842's scope** rather than committed loose. Disclosed here because the change
was made outside a ticket and outside its brief.

---

## 2. Evidence base

### 2.1 Investigation artifacts

Eleven agents ran in parallel on 2026-09-01. Full findings, with `file:line` and URL citations:

| Document | Covers |
|---|---|
| `findings/cluster-diagnosis.md` | Why the three AI services are at 0 replicas; GPU reality; Argo state; ticket-vs-reality |
| `findings/428-root-cause.md` | The probe-lie defect, full 15-hop call path |
| `findings/ai-platform-inventory.md` | All 14 `ai-platform` routes; what each does; the overlap map |
| `findings/ai-provider-model-audit.md` | The 8 participating Prisma models; resolution cascade; credential storage |
| `findings/workflow-substrate-audit.md` | The Temporal interpreter, node registry, studio canvas, invocation surfaces |
| `findings/mcp-tools-audit.md` | McpServer model, gating, what actually speaks MCP |
| `findings/research-lmstudio.md` | llmster headless, CUDA+CPU image, OpenAI-compat, S3 model store, licensing |
| `findings/research-mlflow-vllm.md` | GGUF plugin reality, CPU verdict, MLflow↔vLLM wiring, 13 corrections to the prior research doc |
| `findings/research-providers.md` | Sarvam / Azure / HF capability matrix per task |
| `findings/research-workflow-studio.md` | Graph-on-Temporal architecture, agentic loop patterns, editor, licences |
| `findings/research-embedded-guis.md` | MLflow / Temporal / MinIO embedding facts, 38 citations |

### 2.2 The findings that shape the whole program

**F-1 — The console lies about engine reachability.** `ai-model-discovery.service.ts:339-341` POSTs to
`apps/text` `/api/v1/providers/probe` **omitting the mandatory `X-Tenant-Id`**. `apps/text` refuses in
middleware (`auth.py:137`, HTTP 428) before the probe runs. The gateway catches the axios error,
copies `err.message` into every provider's `probes[].error`, and returns **HTTP 200**. The screen has
**never observed the real state of any engine**. Independent of replica count. Violates
`00-project-context.md` §"Tenant identity is mandatory on internal service calls"; missed by TASK-737's
seven-call-site sweep.

**F-2 — The three AI services are at zero because Git says zero.** `deployment/k8s/base/{vllm,mlflow,lmstudio}.yaml`
declare `replicas: 0` with written rationale; Argo applied exactly that (`generation: 1`, sole writer
`argocd-controller`). Self-sustaining: the HPAs are inert because the HPA controller refuses a
zero-replica target. Argo reports a zero-replica Deployment as **Healthy**, which is why nothing complained.

**F-3 — Prerequisites are missing, so "scale to 1" is not the fix.** Absent from the cluster **and** from
Argo's desired state: PVC `hope-models-cache`, Secret `hope-models-reader`, Job `hope-lmstudio-model-sync`,
and **`hope-lmstudio` has no Service and no Endpoints at all**. `models.tsv` still reads `SET-AT-PUBLISH`.
`lmstudio-service-cutover.yaml` **does not exist** and must be authored.

**F-4 — GPU is available; VRAM is the constraint.** Node `dell`: `allocatable nvidia.com/gpu: "6"`
(2× RTX 2000 Ada, 16380 MiB, time-slicing ×3), 2 permits held, **4 free**, driver 590.48.01, CUDA runtime
13.1, containerd handlers `nvidia`/`nvidia-cdi`. AVX512F/BW/CD/DQ/VL and AMXFP8 all present.
**`mig.capable: false`, `mps.capable: false`** — a time-slice permit carries **no memory isolation**.
Unresolved: `nvidia.com/gpu.mode: "graphics"` (not compute).

**F-5 — The GGUF plugin exists but is not day-1 material.** In-tree GGUF was deprecated and moved
out-of-tree to the official `vllm-project/vllm-gguf-plugin`. v0.0.5, ~0.1% of vLLM usage,
upstream-labelled *"highly experimental and under-optimized"*, **requires CUDA/ROCm (no CPU build)**,
**cannot read `s3://`**, **cannot do embeddings**, unverified for Granite Guardian. Therefore
**"vLLM + GGUF on CPU" is not a configuration that exists**, and the honest CPU/GGUF path is
llama.cpp/LM Studio — which already runs and which the SYSTEM `AiTaskDefault` rows already select.

**F-6 — The provider-configuration unit does not exist as a row.** It is split across three tables joined
by **strings, not FKs**: `AiTaskDefault` (taskKey→modelSlug) → `AiModel` (slug→provider string) →
`AiProviderConnection` (service+provider→endpoint+Vault ciphertext). Eight models participate in total,
including `AiRoutingPolicy`, `AsrPipeline`, `TenantSttConfig`, `TenantTtsConfig` and legacy
`HarnessPolicy.textProvider/textModel`. **This string-joined chain is the mechanical cause of the screen
fragmentation.**

**F-7 — "One default per task" is structurally impossible today.** `AiTaskDefault` carries
`@@unique([tenantId, taskKey])` — exactly one row per task. There is nowhere to put a second candidate,
so there is no election to hold.

**F-8 — `AiRoutingPolicy` is shipped, migrated, admin-exposed, and has ZERO runtime readers.** It already
models the ordered candidate chain the target requires. This is the cheapest correct home for OD-3.

**F-9 — Three of the four required tasks have no task key.** Task keys cover **text generation only**.
Translation, STT and TTS each route through a different mechanism. This is the largest single piece of
work in the program.

**F-10 — Resolution and credentials are already correct.** Zero occurrences of the Global customer tenant
`50000000-…` in any resolver; every cascade is exactly `[tenant, SYSTEM]`, widening only on absence.
All credentials are Vault-Transit ciphertext in `encryptedApiKey`; writes refused unless
`SECRETS_PROVIDER=vault`. **No plaintext-in-DB and no live `*_API_KEY` env fallback anywhere**, including
all four STT cloud loaders. Three *stale comments* claim fallbacks that no longer exist — delete them.

**F-11 — The workflow substrate is far more built than assumed.** A single generic
`@workflow.defn(name="WorkflowInterpreter")` (`interpreter/workflow.py:87`) loads `compiledConfig` via
claim-check and dispatches through a code-owned `NODE_REGISTRY`. Its docstring bounds it:
*"Linear stage walk + single-level fan-out with an all-settled join. Nothing else (v1)"*. A real
`@xyflow/react` canvas Studio exists with palette, drag-connect, typed `isValidConnection`, schema-driven
inspector, validation rail, undo/redo and OCC autosave. `WorkflowDefinition` rows **are** versions;
published rows are immutable through four layers including this repo's first DB trigger.

**F-12 — Node-type gaps.** 50 node types exist, dual-language parity-gated. **Missing: Loop, Data, TTS,
and any generic Agent** (Agent exists only as ~13 fixed-purpose types; STT exists ×8 but all placeholders).
`temperature`/`maxTokens`/`topP` exist; **`frequency_penalty`/`presence_penalty` do not**.
`WorkflowNodeDescriptor` (`node-registry.ts:41`) has **zero tool/MCP fields**.

**F-13 — There is no streaming producer for workflow RUNS.** `/workflows/:slug/runs/:runId/stream` is a
disclosed **2-second poll bridge** (`workflow-stream.service.ts:16-43`); run detail polls at 5s.
**Scope correction (F-21):** this is true of the *workflow-run* surface only. The **realtime consultation**
path has six real ticket-scoped SSE planes over Redis pub/sub, each `@TenantOwnedResource` with its own
`@StreamScope` — `live-summary`, `live-assist`, `harness-progress`, `harness-assurance`, `trajectory`,
`loop` — plus durable `section.patch` read-back. Realtime streaming is **shipped**; workflow-run streaming
is not.

**F-14 — 1 of 4 invocation surfaces exists, and it refuses consultation.**
`EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])` (`exposure-palette-policy.ts:61`) **explicitly
excludes the `consultation` palette**. A consultation workflow cannot be REST-invoked today at all.
Also verified **false**: the claim that TASK-806 widened palettes to a derived capability set.

**F-15 — MCP is real; the gate is policy.** A real `McpServer` model, gateway module, tested full-CRUD
screen, and a genuine MCP protocol client (`harness/tools/mcp_client.py`, official `mcp` Python SDK).
But super-admin-gated four ways, while **seeded tenant-admin roles already hold `manage:McpServer` in CASL**
(`seed/01-policy.ts:224`) — the imperative `assertSuperAdmin()` overrides the declarative grant.
Tool execution runs **one hardcoded tool** (`validate_codes`), chosen by workflow code, **never by an LLM**.

**F-16 — Two live security exposures.** (a) The admin console sets **no CSP and no `X-Frame-Options`
anywhere** — verified across the app, `next.config.ts`, `deployment/`, and the gateway (no helmet): it is
framable by anyone today. (b) `hope-temporal-ui` has `TEMPORAL_DISABLE_WRITE_ACTIONS` unset — anyone
reaching port 8233 can terminate a clinical-documentation workflow, with no tenant check.

**F-17 — MinIO upstream is archived.** `minio/minio` archived 2026-04-25 (*"THIS REPOSITORY IS NO LONGER
MAINTAINED"*); the console repo 404s. The OSS console was reduced to a bare object browser in May 2025
(admin features → commercial AIStor) — by a repo **rename** (`console` → `object-browser`), not a licence
change; it has been AGPLv3 throughout. Last OSS release 2025-10-15 (a CVE fix) was **never published to
Docker Hub**.

**F-18 — Embedding facts.** All three services already have **native shipped console surfaces**
(`features/storage-browser`, `features/mlflow`, `features/harness-ops` — the last already tenant-filtered
with cancel/terminate/signal). `features/db-studio` + `modules/pstudio/` is a **working same-origin embed
pattern**: gateway serves the HTML behind `manage:PrismaStudio`, cookie rides along, no token reaches the
browser. The session cookie is **host-only, `SameSite=Lax`** (`session.ts:88`) — so any cross-origin embed,
**subdomain included**, will not receive it. Same-origin BFF is the only viable pattern.

**F-19 — Provider capability truths.** Azure OpenAI has **no text-translation endpoint**
(`/audio/translations` is Whisper audio→English only); real translation needs Azure AI Translator, a
separate resource/key/billing. Azure audio endpoints remain on `api-version=preview`. Sarvam covers all
four tasks with explicit `ml-IN`, one `api-subscription-key` for all — but **only chat-completions returns
a `usage` object**, so translate/STT/TTS metering must be self-computed. Sarvam is seeded as `llm:sarvam`
with **no LLM adapter**.

**F-21 — The realtime consultation runtime is built, graph-driven, and dark.** TASK-811's
`runRealtimeLane` (`live-documentation.service.ts:1969-1976`; executor `realtime/realtime-executor.ts:208`)
executes a data-defined lane derived from the tenant's published graph (`realtime-lane.ts:186-238`), with
`PLATFORM_REALTIME_LANE` as the platform fallback: stage 0 `capture` → stage 1 `extractEntities` **and**
`realtimeSummary` concurrently, both `onError: 'degrade'`. Seven handlers are registered
(`realtime-node-registry.ts:426-438`). Entry is `POST /consultations/:id/recording/start`
(`consultation.controller.ts:686-706`) behind `@RequiresConsent(AI_DOCUMENTATION)` and
`verifyConsultationOwnership`. **Partial summarization and live NER both already exist.**
It is dark because `consultation.realtime.graphExecutor.enabled` defaults **false**
(`consultation-gates.constants.ts:150`) and **no row for that key is seeded anywhere** — with it off,
`ensureLaneResolved` returns `null` and the legacy hardcoded flush runs, so the tenant graph is never
consulted.

**F-22 — The per-node admin toggle is implemented but unreachable.** The executor honours
`enabled: node.config?.enabled !== false` (`realtime-lane.ts:213`), but **`enabled` is not a declared
property of any consultation node config schema**, and every schema is `additionalProperties: false`
(`node-config-schemas.ts:593,605,799`). The only runtime keys folded onto every node are
`NODE_RUNTIME_PROPERTIES = { timeoutSeconds, retry }` (`:1233-1240`). The file states the consequence
itself: *"an undeclared key is stripped twice over and a node round-tripped through the authoring UI would
come back with its gate silently removed"* (`:183-187`).

**F-23 — The Pipeline Policy UI misleads admins about realtime.** `autoSummaryEnabled` / `autoNerEnabled`
have a real cascade (doctor→dept→tenant→SYSTEM→code) and a real UI matrix, but are consumed **only by the
post-consultation pipeline** (`consultation-event.handler.ts:124,291`). `LiveDocumentationService` has
**zero** references to them across all 3,567 lines. **Turning "Auto-NER" off today does not stop live
entity extraction.** Likewise the `feature-flags` `GlobalSetting` rows
(`enable-real-time-transcription`, `enable-ner-extraction`) are **advisory only — no SDK path gates on
them**, and the console never reads `useArcaConfig`.

**F-24 — The C-8 undercount.** `exposure-palette-policy.ts` cites "four of thirteen" consultation nodes as
`externalWrite`. The palette has since grown to **31** `paletteKey: 'consultation'` descriptors, of which
**11 declare `externalWrite`**. The constraint against lifting the allow-list is therefore *stronger* than
its own comment claims, not weaker.

**F-20 — Prior-art licence blockers.** **n8n** (Sustainable Use License, non-commercial) and **Dify**
(modified Apache 2.0, *"you may not use the Dify source code to operate a multi-tenant environment"*) are
**design-lessons-only**. Langflow (MIT) and Flowise (Apache 2.0 core, avoid `enterprise/**`) are safe.
`@xyflow/react` 12.11.5 is **MIT across the entire library** — Pro buys examples/support only.

---

## 3. Cross-cutting rules every child ticket inherits

Violating any of these turns a green build into a defect. They are drawn from the repo's own rules plus
the findings above.

### 3.1 Configuration
1. **No hardcoded configuration.** Engine names, model ids, endpoints, credentials, thresholds, prompts
   and label taxonomies are **config**, never literals and never env vars beyond the bootstrap floor
   (what is needed to reach the DB or authenticate to Vault). A `pydantic-settings` field with a real
   model default is a hardcoded selection wearing a costume.
2. **Resolution is always tenant → SYSTEM. Two tiers, no third.** The Global tenant `50000000-…` is a
   **customer tenant** (platform-admin playground) and must never appear in a runtime cascade.
3. **`failMode` is declared, not decided at the call site.** Provider/model *selection* is `closed`
   (unresolved ⇒ raise, substitute nothing); tuning knobs are `open-to-default`.
4. **Funding is derived, never stamped.** BYOK vs CLOUD comes from `row.tenantId === SYSTEM_TENANT_ID`.
5. **Every config cache key includes `tenantId`.**

### 3.2 Security & authorization
6. **Super-admin-only is a 403 privilege boundary**, *not* the 404-over-403 cross-tenant posture. A
   cross-tenant id still returns 404. Every such route carries a standardized `// AUTH-NOTE:` marker
   and still needs a class- or handler-level decorator so the deny-by-default boot audit stays green.
7. **`X-Tenant-Id` is mandatory on every internal service call** carrying tenant-scoped work. An absent
   header is a bug in the **caller**. Genuinely tenant-less work declares itself via `tenantlessReason`.
8. **Never put a credential in a DB column in plaintext.** Vault-Transit ciphertext or a `credentialsRef`.
9. **Nodes store references, never resolved values.** (See §3.4.)

### 3.3 Database
10. Field template order, UUIDv7 ids, `_version` OCC counter never written by a mapper, `tenantId`
    NOT NULL with no default, soft delete via `resourceStatus`.
11. **Never run `pnpm gen:mapper`** — it is destructive and strips the `_version` OCC guard.
    `gen:entity`/`gen:factory` only reconcile barrels; entity/factory/mapper/repository are **hand-authored**.
12. **Migrations are authored against a throwaway shadow database**, never the dev DB. Never stage an
    unapplied migration folder under `migrations/` — Prisma applies every subdirectory regardless of name.
13. New sys-event-emitting models need `ResourceType` in **both** `audit.prisma` (+ `ADD VALUE` migration)
    and `packages/domains/src/enums/generated/ResourceType.ts`.

### 3.4 Workflow-specific
14. **Temporal workflows are deterministic**: no I/O, no network, no `random`, no wall-clock, no env reads
    inside `@workflow.defn`. `max_time` is a **workflow timer**, never wall-clock.
15. **Compile the editor document into a runtime IR at publish. Never send editor JSON to Temporal.**
    Payload ceiling is 2 MB/payload, 4 MB/gRPC message; use claim-check to MinIO from day 1 —
    retrofitting rewrites every activity signature.
16. **Graph nodes must never become an ungoverned config surface.** One careless node schema storing a
    model id, endpoint or key in graph JSON silently bypasses the tenant→SYSTEM cascade *and* BYOK funding
    derivation. Store references; resolve in the activity; fail closed on a disabled connection.
17. **Do not route token streams through Temporal.** Signals land in history; the ceiling is
    51,200 events / 50 MB per run.
18. **A published version is immutable and a run is pinned to it.** "The graph cannot change mid-run" is a
    **feature** for clinical auditability, not a limitation to engineer around.

### 3.5 Delivery
19. TDD: failing test first, always see RED. Paste actual command output as evidence — "tests pass" with
    nothing quoted is not a result.
20. **Do not run the test suites of `apps/compat-playground`, `apps/quick-compat-app`, or `packages/ui`**
    unless the change is inside them.
21. Container images are built **only by GitLab CI**. Never a local build as evidence.
22. k8s manifests live in the external repo `arca/hope-v2-deployment`. No live-cluster edits as the durable
    fix. Promotion is digest-pinned by CI.
23. WCAG 2.2 AA with an axe scan at 0 violations is a definition-of-done gate, both themes.

---

## 4. The ticket set

Legend for the per-ticket header: **Tier / Effort** follows `14-multi-agent-worktrees.md` §1 — tier per
*stage*, never per pipeline; never downshift the stage whose verdict you act on; escalate on evidence,
not on a hunch. §5 carries the consolidated tier table and the reasoning.

---

# TRACK A — Make it work and make it honest

*Days, not weeks. Unblocks every other track. No decisions outstanding.*

---

## TASK-838 — Console Security Headers & Temporal Write Lockdown

| | |
|---|---|
| **Tier / Effort** | `sonnet` / **medium** — mechanical change, but the verdict (does CSP break the existing embed?) is acted on |
| **Depends on** | nothing. **Start here.** |
| **Owns** | `apps/admin-console/next.config.ts`, `apps/admin-console/src/proxy.ts`; manifest repo `hope-temporal-ui` env |
| **Type** | `infrastructure` / `bugfix` |

### Requirement analysis
Two live exposures (F-16), independent of every other decision in this program, fixable in hours.

### Current state
- The admin console emits **no `Content-Security-Policy` and no `X-Frame-Options`** — verified across the
  app, `next.config.ts`, `deployment/`, and the gateway (no helmet). Any site can frame it.
- `hope-temporal-ui` runs with `TEMPORAL_DISABLE_WRITE_ACTIONS` unset. Anyone reaching port 8233 can
  terminate a running clinical-documentation workflow. The ui-server applies **no namespace-level
  authorization at all**, so there is no tenant check behind it either.

### Implementation plan
1. Add a security-headers block to `apps/admin-console/next.config.ts` covering **all** routes:
   `Content-Security-Policy: frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: strict-origin-when-cross-origin`.
   **`frame-ancestors 'self'` — not `DENY`.** `DENY` would break the existing `features/db-studio`
   same-origin iframe and pre-emptively break TASK-851.
2. Prefer the CSP `frame-ancestors` directive over `X-Frame-Options`. Do **not** add a full
   `script-src`/`style-src` policy in this ticket — Next.js needs nonce plumbing for that, and scope creep
   delays a two-hour security fix.
3. Manifest repo: set `TEMPORAL_DISABLE_WRITE_ACTIONS=true` on the `hope-temporal-ui` Deployment.
   **Trap:** the ten per-action flags (`TEMPORAL_WORKFLOW_TERMINATE_DISABLED` et al.) are **UI hints only —
   no middleware reads them.** Only `TEMPORAL_DISABLE_WRITE_ACTIONS` is enforced (405). Do not substitute them.
4. Confirm nothing regresses: HOPE already performs terminate/cancel/signal natively via
   `admin/harness/workflows`, behind RBAC and audit. That path is unaffected.

### Verification
- `curl -I` the deployed console → headers present.
- Load `/db-studio` → the iframe still renders (**this is the regression that matters**).
- `curl -X POST` a Temporal UI write action → **405**.
- Terminate a workflow through the console's own harness-ops screen → still works, still audited.
- `pnpm --filter @arcaai/admin-console build lint test`.

### Risks
| Risk | Mitigation |
|---|---|
| `frame-ancestors` breaks `db-studio` | Use `'self'`; make the db-studio load an explicit test step |
| A stricter CSP is later assumed to be in place | Document in the ticket that only `frame-ancestors` shipped |

---

## TASK-839 — Provider Probe Tenant Header Fix

| | |
|---|---|
| **Tier / Effort** | `sonnet` / **high** — the *fix* is one line-group; the *sweep* (which sibling call sites are affected) is the real deliverable |
| **Depends on** | nothing |
| **Owns** | `apps/api/src/modules/ai-model/ai-model-discovery.service.ts`, `apps/api/src/modules/ai-service-admin/ai-service-proxy.client.ts` |
| **Type** | `bugfix` |

### Requirement analysis
The AI services screens report `Unreachable: Request failed with status code 428` for engines they have
never contacted (F-1). Fixing this does not turn the badge green — it makes the *explanation* true. It is a
prerequisite for TASK-840/841 because without it there is no trustworthy signal that bring-up worked.

### Current state
`ai-model-discovery.service.ts:339-341` hand-rolls a header object containing only `Content-Type` and a
legacy `X-Service-Token`, omitting `X-Tenant-Id`. `apps/text` refuses in middleware at `auth.py:137`
(HTTP 428) because `/api/v1/providers/probe` is not in `EXEMPT_PATHS`. The gateway's catch at `:356-361`
copies `err.message` verbatim into every provider's `probes[].error` and answers **200**.
The service already reads `tenantId` from CLS 60 lines earlier, at `:279`.

### Implementation plan
1. **RED first.** Extend the existing axios spy in
   `modules/ai-model/__tests__/ai-model-discovery.controller.test.ts` (it currently ignores its third
   argument, `:35-36`) to assert the outgoing headers. Watch it fail.
2. Replace the hand-rolled object with `internalServiceHeaders({...})` from
   `packages/applications/src/common/internal-service-headers.ts:92-150`, copying the shape already used at
   `ai-inference.client.ts:114-128`. Pass the CLS `tenantId`; where a call is genuinely tenant-less, pass an
   explicit `tenantlessReason` — **never** an absent header (§3.2 rule 7).
3. **Latent second defect on the same line:** the legacy `TEXT_SERVICE_TOKEN` is no longer accepted by
   `apps/text` (`core/config.py:238-247`). Resolve the token through `SecretsService` in the same change, or
   this call becomes a 401 the moment text is properly tokenized.
4. **Do NOT add the path to `apps/text`'s `EXEMPT_PATHS`.** That papers over a caller bug and weakens a
   contract `test_task799_phase0.py:213-229` currently pins as correct.
5. Sweep: `ai-service-admin/ai-service-proxy.client.ts:104-107` has the identical omission for the
   Guardrail/NLP tiles. Verify whether those services' exempt lists mask it, and fix it the same way.
6. Grep the gateway for further hand-rolled internal-call header objects and record the census in the
   ticket README, even for sites you do not change.

### Verification
- New assertion on the axios third argument passes.
- `pnpm test:unit` for `apps/api`; `pnpm api:build`.
- Against the cluster, the engine screens show a genuine transport error (e.g. `connect ECONNREFUSED …`) —
  exactly what the existing fixture at `engine-screen.test.tsx:39` already expects.
  **Fixing production makes it match its fixtures.**

### Risks
| Risk | Mitigation |
|---|---|
| Sweep uncovers many sites and scope explodes | Fix the two named; **report** the rest as a census, open a follow-up |

---

## TASK-840 — MLflow Service Bring-Up

| | |
|---|---|
| **Tier / Effort** | `opus` / **medium** — multi-step cluster ops with real prerequisites; verdict acted on against a live environment |
| **Depends on** | TASK-839 (for a truthful readiness signal) |
| **Owns** | manifest repo `deployment/k8s/base/mlflow.yaml` + `overlays/dev`; cluster-op prerequisites |
| **Type** | `infrastructure` |

### Requirement analysis
Platform admin must manage the model registry, experiments and datasets through MLflow (OD-6: platform
admin only). MLflow is the **lowest-risk** of the three zeroed services — no GPU, no PVC — and goes first.

### Current state (F-2, F-3)
`replicas: 0` in Git with written rationale; Argo applied it faithfully and reports it **Healthy**.
Prerequisites never created: the `mlflow` database, the MinIO service account, and the `MLFLOW_*` keys in
`hope-secrets`. Image is real and digest-pinned (`ghcr.io/mlflow/mlflow@sha256:2c9c50ca…`).
Service DNS `hope-mlflow….svc:5000` exists. No Ingress. Platform runs MLflow **3.15.2**.

### Implementation plan
1. **Correct the manifest before scaling.** The prior research doc's MLflow manifest is *not deployable*:
   wrong image variant (**needs `-full`**), omits **`--allowed-hosts`** (mandatory — without it MLflow
   silently 403s `/metrics`), omits `mlflow db upgrade`, and combines proxied/direct artifact flags
   ambiguously. Fix all four.
2. Create the `mlflow` database on the existing Postgres 18 (backend store) and a MinIO service account +
   bucket for the artifact store. **Reuse existing datastores — introduce none.**
3. Seed `MLFLOW_*` keys into `hope-secrets` via `scripts/vault-seed-secrets.sh`, whose key list is
   **derived from the `vault-kv` descriptors** — add descriptors, never hand-edit the script.
4. Run `mlflow db upgrade` as an Argo PreSync job before first serve.
5. **Health probe must use the un-prefixed path.** `/health` and `/version` are never static-prefixed, and
   host validation exempts the exact path `/health` only — precisely what the gateway probe hits.
6. Set `replicas: 0 → 1` in the manifest repo. Argo auto-sync is **on** (prune/selfHeal off), so it
   propagates without a manual sync. **Do not `kubectl scale`** as the durable fix.
7. **PHI control:** MLflow 3 GenAI tracing captures **full payloads by default** — a leak vector in a PHI
   platform. Disable or explicitly scope it, and record the setting.
8. Housekeeping: remove the dead `hope-mlflow-migrate` patch.
9. Note: 3.15.2 postdates **Workspaces (3.10)** and **proxy-less presigned artifact transfer (3.15)** —
   the latter is the fix for the prior research doc's own "110× proxy" finding. Prefer presigned transfer.

### Verification
- Pod Ready 1/1; `/health` 200 through the gateway probe.
- `admin/ai-services/mlflow/status` reports reachable; the existing `features/mlflow` screen renders
  experiments and registered models (already built — F-18).
- Registry round-trip: register a model version, resolve `models:/name@alias`.
- Confirm GenAI tracing payload capture is off.

### Risks
| Risk | Mitigation |
|---|---|
| Wrong image variant ⇒ missing subcommands | Assert `-full` in manifest review |
| Missing `--allowed-hosts` ⇒ silent 403 on `/metrics` | Explicit verification step |
| MLflow ships **no auth** | Gateway-fronted only; never expose an Ingress (OD-6) |
| GenAI tracing captures PHI | Step 7 is mandatory |
| MLflow has weak native multi-tenancy | Platform-admin-only by OD-6; tenants never touch it directly |

---

## TASK-841 — LM Studio Service Bring-Up

| | |
|---|---|
| **Tier / Effort** | `opus` / **high** — a missing manifest must be authored, and several prior claims are stale |
| **Depends on** | TASK-839; TASK-842 (models bucket must be publishable) |
| **Owns** | manifest repo `deployment/k8s/base/lmstudio.yaml`, `out-of-band/`; `infrastructure/docker/lmstudio/` |
| **Type** | `infrastructure` |

### ⚠ Risk Accepted — mandatory section (OD-1)
LM Studio's Terms of Service, effective **2026-08-23**, forbid *"service bureau use… or
software-as-a-service."* HOPE is a commercial multi-tenant healthcare SaaS and therefore falls within the
prohibited category. The owner elected on **2026-09-01** to proceed and record the risk. This is a
**standing item to revisit with counsel**, not a closed question. Any future expansion of LM Studio's role
must re-surface it.

### Requirement analysis
"lmster" is LM Studio's own official headless daemon, **`llmster`** — already named that way in this
codebase. Platform admin (never tenant admin) configures the server URL and the S3/MinIO bucket URI from
which models are downloaded and managed. The server must speak the OpenAI-compatible API with streaming.
Per TASK-799 **D-6**, LM Studio is already platform-managed — the "tenant admin not allowed" requirement is
**already the law** and needs no new work.

### Current state — three stale claims corrected
1. TASK-824's *"the image has never been built"* comment is **stale**: `build-lmstudio` job **15666** and
   `verify-lmstudio-runtime` job **15667** both succeeded in pipeline **1048**.
2. The manifest's image path `registry.taphuynh.dev/hope/lmstudio:dev` is **not where CI publishes**
   (`$REGISTRY/$CI_PROJECT_PATH/lmstudio`), there is no overlay `images:` entry, and the tag is mutable.
3. Both the ticket and the kustomization assume an out-of-band `hope-lmstudio` Service *"currently carries
   the summarization path"* — **it does not exist in the namespace at all.**

Also missing: PVC `hope-models-cache`, Secret `hope-models-reader`, Job `hope-lmstudio-model-sync`.
`models.tsv` reads `SET-AT-PUBLISH`. `hope-lmstudio-config` is **orphaned** — synced, referenced by nothing.
The kustomization advertises a PVC, a Job and a third NetworkPolicy the file does not contain.

### Implementation plan
1. Create Secret `hope-models-reader` (TASK-832 R-2).
2. Run `out-of-band/hope-models-publish.yaml`; capture the printed versions (R-3).
3. Replace the four `SET-AT-PUBLISH` values in `models.tsv` with the captured versions.
4. Apply `out-of-band/lmstudio-model-sync.yaml` — it creates the PVC **and** runs the sync.
   **Do not re-attach it as a PreSync hook.**
5. Fix the image path in the manifest **and** add an overlay `images:` entry; confirm CI `promote-dev`
   writes the **digest**, not a mutable tag.
6. Reconcile the kustomization/file drift (PVC, Job, third NetworkPolicy).
7. **Author `out-of-band/lmstudio-service-cutover.yaml` — it does not exist and blocks Service creation.**
8. **Runtime selection trap:** the `full+cuda12` bundle ships both CPU and CUDA llama.cpp engines and
   **defaults to CPU unless explicitly told otherwise** via `lms runtime select`. The shipped Dockerfile
   already defends against this — keep that defence and assert it.
9. **Probes:** LM Studio exposes **no metrics endpoint, no headless auth, and returns 200 on every HTTP
   path.** A naive probe reports healthy regardless of state. Probe a path whose *body* proves a model is
   loaded (e.g. `/v1/models` with a non-empty list), never merely a 200.
10. `replicas: 0 → 1`. **Verify by pod IP first**, then cut the Service over (step 7).
11. Retire the orphaned `hope-lmstudio-config`.

### Model store note (informs TASK-845)
TASK-835 **measured** the S3-mount question rather than theorising it: mmap over an S3-backed FUSE mount
sustained **312–376 MB/s with 7–56 ms random page-ins** on a 3.35 GB GGUF — contradicting the usual folklore
that FUSE breaks mmap. The PVC-sync design remains correct on **latency** grounds, not feasibility grounds.

### Verification
- Pod Ready; `lms runtime` shows the **CUDA** engine selected, not CPU.
- `/v1/models` returns the five GGUF models from the PVC.
- A streaming `/v1/chat/completions` round-trip through the gateway.
- The engine screen (post-TASK-839) shows a truthful **reachable** state.

### Risks
| Risk | Mitigation |
|---|---|
| Silent CPU fallback | Step 8 assertion; verify via `lms runtime`, not throughput |
| Probe passes while broken | Step 9 body-assertion probe |
| VRAM contention — no MIG, no MPS, no isolation (F-4) | Measure free VRAM before scaling; account for any host LM Studio instance |
| Licensing | See Risk Accepted above |

---

## TASK-842 — MinIO Pin Hold & Straggler Completion

> ## 🔒 FROZEN — MinIO image version
>
> `minio/minio:RELEASE.2025-04-22T22-12-26Z` is **FROZEN BY OWNER DIRECTIVE**, reaffirmed 2026-09-01.
>
> **Do NOT change it to any other version — not newer, not older, not `latest`, not a fork, not AIStor —
> in any manifest, compose file, Helm value, test fixture, example, or document.** This is the last
> release carrying a full MinIO Console UI, which TASK-851 depends on. It is not a default to be
> "modernised", not a stale pin to be bumped, and not a finding to be re-raised.
>
> The only sanctioned work is bringing remaining `minio/minio:latest` stragglers **onto** this pin.
> Any dependency-update tooling or agent that proposes moving off it is wrong; reject the change.


| | |
|---|---|
| **Tier / Effort** | `sonnet` / **medium** for the pin; **`opus` / high** for the CVE exposure assessment — a verdict that is acted on, so do not downshift that stage |
| **Depends on** | nothing |
| **Owns** | manifest repo MinIO workload; `infrastructure/docker/` compose pins |
| **Type** | `infrastructure` |

### ⚠ Risk Accepted — mandatory section (OD-5)
The owner elected on **2026-09-01** to pin `minio/minio:RELEASE.2025-04-22T22-12-26Z` — the last release
carrying a full console UI — to preserve the embedded MinIO console required by TASK-851. This image
**predates the 2025-10-15 OSS release (a CVE fix) and roughly six months of fixes.** The compensating
control is OD-6: the console is reachable by platform admins only, same-origin, behind the BFF, never via
an Ingress.

### Current state (F-17)
`minio/minio` was **archived 2026-04-25** — *"THIS REPOSITORY IS NO LONGER MAINTAINED."* The console repo
404s. The OSS console was reduced to a bare object browser in **May 2025** by a repo **rename**
(`console` → `object-browser`), **not** a licence change — it has been AGPLv3 throughout. The last OSS
release (2025-10-15, a CVE fix) was **never published to Docker Hub**, so `minio/minio:latest` — what is
running — already predates it.

### Implementation plan
1. Pin `RELEASE.2025-04-22T22-12-26Z` **by digest as well as tag** in every manifest and in
   `infrastructure/docker/` compose files. A mutable tag on an archived upstream is a trap.
2. **Assess the CVE exposure** (the `opus` stage): identify the CVE(s) fixed in the 2025-10-15 release,
   determine whether they touch the **console** or the **server data path**, and record the finding. If a
   data-path CVE is reachable in our topology, **escalate to the owner** — OD-5 was decided on UI grounds
   and deserves revisiting on that evidence.
3. Record the AGPLv3 position. The iframe-vs-network-API distinction is the common industry reading but is
   **not legal advice** — flag it for counsel alongside OD-1.
4. Confirm MinIO is not exposed via Ingress and is reachable only in-cluster and through the BFF.
5. **Note for TASK-851:** MinIO's console cookie is named `token` at `Path=/`. Under a same-host sub-path
   proxy it would be sent to *every* path on that origin, including the BFF. HOPE is safe today because its
   session cookie is `hope_admin_session`, but the proxy must scope or strip `token` regardless.
6. ~~Strategic tracking item~~ — **CLOSED by OD-10.** The pin is frozen by owner directive. Do **not**
   explore AIStor, a fork, or migrating object storage as part of this ticket.

### Verification
- Deployed image digest matches the pin; console UI loads.
- `features/storage-browser` and all S3 API paths still work (bucket list, presigned URL, upload).
- `hope-models` bucket operations used by TASK-841 still function.

### Risks
| Risk | Mitigation |
|---|---|
| Pinned image carries an unpatched data-path CVE | Step 2; escalate on evidence |
| Archived upstream ⇒ no future fixes | Step 6 tracking item |
| Downgrade breaks existing bucket state | Verify against a non-production bucket first; check release notes between the running version and the pin — MinIO downgrades are not always safe |

---

# TRACK B — Provider consolidation

*This is the real work behind "the AI Platform group is chaos". Multi-week. Two owner reversals recorded
(OD-2, OD-3). **TASK-843 is on the critical path for Track D** (OD-4).*

---

## TASK-843 — AI Task Taxonomy Unification

| | |
|---|---|
| **Tier / Effort** | `opus` / **xhigh** — very high: one taxonomy must absorb three independent mechanisms without breaking live inference |
| **Depends on** | nothing technically; do it after Track A so the cluster is truthful |
| **Blocks** | **TASK-844, TASK-845, and all of Track D** (OD-4) |
| **Owns** | `packages/database/src/prisma/db_main/*.prisma`, `packages/domains/src/enums/`, the STT/TTS resolvers |
| **Type** | `refactor` (schema-bearing) |

### Requirement analysis
The product requires **one configuration per task**, across four tasks: **text generation, translation,
speech-to-text, text-to-speech**. Every downstream requirement — one default per task, promotion,
export/import, and every agent/STT/TTS node binding in Track D — presumes a single task taxonomy exists.

### Current state (F-9)
**Task keys cover text generation only.** The other three route through entirely separate mechanisms:

| Task | Current mechanism |
|---|---|
| text generation | `AiTaskDefault.taskKey` → `modelSlug` |
| translation | **no mechanism at all** |
| speech-to-text | `AsrPipeline` + `TenantSttConfig` |
| text-to-speech | `TenantTtsConfig` |

`SUPER_ADMIN_ONLY_TASK_PREFIXES` gates a subset of task keys imperatively (a 403 privilege boundary, §3.2
rule 6). Sarvam is seeded as `llm:sarvam` with **no LLM adapter** (F-19).

### The Azure translation problem — SETTLED (F-19, OD-8)
**Azure OpenAI has no text-translation endpoint.** `/audio/translations` is Whisper's audio→English-only
mode. Real text translation requires **Azure AI Translator** — a different resource, key and billing.
Three options, to be settled in this ticket and recorded as an owner decision:
- **(a)** Model translation as a *capability of text generation* (instruction-prompted). Works on every LLM
  provider, no new provider type, lower fidelity than a dedicated MT engine.
- **(b)** Add Azure AI Translator as a distinct provider with its own credential set. Highest fidelity,
  adds a provider whose shape is unlike the OpenAI-compatible ones.
- **(c)** Offer translation only on providers with a native endpoint (Sarvam does — with explicit `ml-IN`).
**RESOLVED by OD-8: remove Azure translation entirely.** Azure OpenAI covers text generation, STT and
TTS only. Translation is served exclusively by providers with a native endpoint — **Sarvam**, which has
one with explicit `ml-IN`. Do not add an Azure AI Translator provider. This removes a whole credential
shape from the schema.

### Implementation plan
1. Define the canonical task taxonomy as a first-class enum in `enums.prisma` **and** the mirrored domain
   enum. Cover the four tasks; leave the enum extensible (embeddings, guardrail classification, NER already
   exist elsewhere and must not be silently swallowed).
2. Author the migration against a **throwaway shadow database** (§3.3 rule 12), named
   `task_843_ai_task_taxonomy`. Never `pnpm db:migrate` against the dev DB.
3. Add `taskKind` to the tables that will carry provider bindings. Do **not** delete `AsrPipeline` /
   `TenantSttConfig` / `TenantTtsConfig` in this ticket — add the taxonomy alongside, migrate readers in
   TASK-844, retire in a later ticket. **Two-phase, so a mistake is recoverable.**
4. Backfill: every existing `AiTaskDefault` row gets `taskKind = TEXT_GENERATION`; every `AsrPipeline`/
   `TenantSttConfig` row maps to `SPEECH_TO_TEXT`; `TenantTtsConfig` to `TEXT_TO_SPEECH`.
   **Assert row counts before and after.**
5. Follow the hand-authored domain-layer workflow: `pnpm gen:model` only, then hand-author
   entity/factory/mapper/repository. **Never `pnpm gen:mapper`** (§3.3 rule 11). Register repositories in
   `CoreDatabaseModule`; update barrels by hand.
6. If any new model emits sys-events, add it to `ResourceType` in **both** `audit.prisma` (+ `ADD VALUE`
   migration) and the domain enum (§3.3 rule 13) — the TASK-366 failure mode.
7. Re-run `gen:model`, `gen:entity`, `gen:factory` `:check` variants — all three must report no drift and
   schema coverage OK.

### Verification
- `pnpm --filter @arcaai/database test`, `pnpm --filter @arcaai/domains build test`.
- `npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script` prints
  `-- This is an empty migration.`
- Backfill row-count assertions pass.
- **Live inference still works**: a text generation call and an STT call both succeed after migration.

### Risks
| Risk | Mitigation |
|---|---|
| Retiring the three mechanisms too early breaks STT/TTS | Two-phase (step 3) — add now, retire later |
| Enum churn breaks the dual-language parity gate | Update the Python contract package in the same change |
| Translation designed on a wrong assumption | Settle the Azure decision **before** coding |

---

## TASK-844 — AiRoutingPolicy Absorption & Provider Configuration Model

| | |
|---|---|
| **Tier / Effort** | `opus` / **xhigh** — data-preserving migration that reverses a standing owner decision and can stop day-1 inference if wrong |
| **Depends on** | TASK-843 |
| **Owns** | `AiRoutingPolicy`, `AiTaskDefault`, `AiProviderConnection`, `AiModel`, their services and resolvers |
| **Type** | `refactor` (schema-bearing) |

### ⚠ Owner reversal on record (OD-3)
TASK-816's owner decision that `AiTaskDefault` survives is **explicitly reversed** by OD-3, dated
2026-09-01. `AiTaskDefault` is absorbed into `AiRoutingPolicy` and retired. This ticket is the instrument
of that reversal and must say so in its README.

### Requirement analysis
- Many provider configurations may exist per task; **exactly one may be the platform default per task**.
  Setting a second must be refused, or must atomically unset the first.
- Tenant admins BYO-key their own configuration; the SYSTEM row is the fallback.
- LM Studio and MLflow/vLLM are **platform-admin only** — already satisfied by TASK-799 D-6.
- HuggingFace is **not** an inference provider (OD-2) — it is a model source. Do not model it here.
- An admin can **promote** a configuration from one tenant to another tenant they manage.
- **Export/import** selected configurations as JSON with **secrets masked and never fully exportable**.
- Each agent node in a workflow binds to exactly **one** provider configuration.

### Current state (F-6, F-7, F-8, F-10)
The unit does not exist as a row — it is a **string-joined chain** across `AiTaskDefault` → `AiModel` →
`AiProviderConnection`. `AiTaskDefault`'s `@@unique([tenantId, taskKey])` permits exactly one row per task,
so a second candidate has nowhere to live and no election is possible.
**`AiRoutingPolicy` is already shipped, migrated and admin-exposed, with ZERO runtime readers** — it
already models the ordered candidate chain required.
Resolution and credentials are already correct and must not regress: two-tier `[tenant, SYSTEM]` cascade
with no Global-tenant leakage; all credentials Vault-Transit ciphertext; no plaintext, no env fallback.

### Implementation plan
1. Extend `AiRoutingPolicy` to be the single ordered-candidate table: `(tenantId, taskKind, providerConnectionId,
   modelRef, priority, isDefault, enabled)`. Replace string joins with **real foreign keys**.
2. **Enforce one default per task in the database**, not only in a service: a PostgreSQL **partial unique
   index** on `(tenantId, taskKind) WHERE isDefault = true`. A service-level guard alone is the pattern that
   produced F-7. The only existing elect-one-of-many precedent is
   `AsrPipelineRepository.setDefaultForTenant:139-150` — service-level with no DB constraint; improve on it.
3. Election semantics: setting a new default **atomically unsets the previous** inside a transaction
   (`runInTransaction`), then broadcasts `ResourceUpdated`. Do not make the caller do two writes.
4. **Migrate `AiTaskDefault` → `AiRoutingPolicy`, preserving every row**, then retire `AiTaskDefault`.
5. Migrate the readers found in TASK-843 step 3 (`AsrPipeline`, `TenantSttConfig`, `TenantTtsConfig`) onto
   the unified table, then retire those mechanisms.
6. **Preserve the resolution cascade exactly**: request tenant → SYSTEM, widening only on absence, never the
   Global customer tenant `50000000-…`. Preserve `AiProviderConnection`'s three states — **no row** = no
   opinion (platform default applies), **enabled + keyed** = tenant wins, **disabled** = veto in both tiers.
7. **Funding stays derived**, never stamped: `row.tenantId === SYSTEM_TENANT_ID` decides BYOK vs CLOUD
   (§3.1 rule 4). A call site that stamps it mis-bills silently.
8. **Promotion**: copy a configuration from tenant A to tenant B where the actor administers both.
   Secrets are **not** copied — the target tenant must supply its own credential, or inherit SYSTEM's.
   Model this on the existing workflow-promotion precedent.
9. **Export/import**: export omits `encryptedApiKey` entirely and emits a `credentialRef` placeholder plus a
   masked hint (e.g. last 4). Import requires the operator to supply the secret. **A secret must not be
   reconstructable from any exported artifact** — assert this in a test, not just in review.
10. Provider field sets to model (from the capability research):
    - **Sarvam** — one `api-subscription-key` serves all four tasks; rate limits differ per endpoint, not per
      key. Only chat-completions returns a `usage` object, so **translate/STT/TTS metering must be
      self-computed** (character counts / audio duration).
    - **Azure OpenAI** — the unit is a **deployment** (one deployment binds one model), which makes "one
      configuration per task deployment" architecturally forced. Fields: endpoint, deployment name,
      api-version, key. Audio endpoints remain on `api-version=preview`.
    - **LM Studio / vLLM** — endpoint only, platform-managed, OpenAI-compatible.
11. Write the adapter Sarvam currently lacks (F-19) or explicitly defer it and mark the provider unusable
    for text generation until then. **Do not leave a seeded provider with no adapter.**
12. Delete the three **stale comments** claiming `*_API_KEY` env fallbacks that no longer exist (F-10) —
    they actively mislead.

### Verification
- Partial unique index rejects a second default at the **database** level (test it by raw insert, not only
  through the service).
- Migration preserves row counts; **the five GGUF SYSTEM selections still resolve** (see Risks).
- Cross-tenant read returns **404**, not 403; a disabled connection vetoes in both tiers.
- Export artifact contains no recoverable secret material — asserted by test.
- `pnpm --filter @arcaai/domains test`, `pnpm --filter @arcaai/applications test`, `pnpm test:e2e`.

### Risks
| Risk | Mitigation |
|---|---|
| **⚠ The SYSTEM `AiTaskDefault` rows are what select the five GGUF models on LM Studio today. Losing them stops day-1 inference.** | Treat as a **data-preserving migration with an explicit post-migration resolution test**, not a schema swap. Verify each of the five resolves before and after. |
| Reversing TASK-816 surprises a later reader | The reversal is recorded in §1 OD-3 and restated in this ticket |
| Cascade regression reintroduces Global-tenant leakage | Add a test asserting `50000000-…` never appears in a resolution path |
| Funding stamped rather than derived ⇒ silent mis-billing | Assert derivation in tests |

---

## TASK-845 — Unified AI Provider Console Screen

| | |
|---|---|
| **Tier / Effort** | `opus` / **high** for the information architecture (the verdict acted on); `sonnet` / **high** for component build |
| **Depends on** | TASK-843, TASK-844 |
| **Owns** | `apps/admin-console/src/features/ai-*`, the `ai-platform` nav domain |
| **Type** | `feature` / `refactor` |

### Requirement analysis
**One screen** manages all AI inference provider configurations, plus **one interface for the local model
store** in MinIO including download from HuggingFace (OD-2 makes this a *storage* feature, not a provider one).

### Current state (F-6, and the inventory)
14 routes carry `domain: 'ai-platform'`. Template conformance is **already good** — 17/17 use
`ScreenTemplate`, 15/17 use `DetailDrawer`; only `/tools-mcp` and `/rate-limits` hand-roll bespoke Dialogs.
**The chaos is information architecture, not component standards**: the surface is split by *backend table*
rather than by *user intent*, which is the direct consequence of F-6's string-joined chain.
Concretely: `/ai-task-defaults` and `/ai-configuration`'s Models tab are **the same controller and the same
Prisma model**, differing only by `tenantId`. `/ai-operations/reconciliation` is a **vendor billing
auditor** that never touches `AiModel` — it is filed in the wrong group. `/ai-model-defaults` is already a
`permanentRedirect` stub. There is **no model-store screen** — only the generic `/storage` browser and a
read-only filtered view inside each engine screen.

### Implementation plan
1. **Target IA — one screen, tabs by user intent, not by table:**
   - **Providers** — every provider configuration, filterable by task; the default badge per task.
   - **Tasks** — the four tasks, each showing its elected default and its ordered fallback chain.
   - **Model catalogue** — `AiModel`, the catalogue that configurations select from.
   - **Model store** — MinIO `hope-models` browser + **download from HuggingFace** (OD-2).
   - **Engines** — LM Studio / vLLM / MLflow health and runtime state (platform-admin only).
2. **Tenancy is a selector, not a route.** `/ai-task-defaults` and `/ai-configuration` collapse into one
   screen with a SYSTEM-vs-tenant control, matching the two-tier cascade the backend already implements.
3. **Move `/ai-operations/reconciliation` out of `ai-platform`** into Platform Ops. It is a FinOps tool.
4. **Retire `/ai-runtime-profiles` as a top-level screen.** `AiRuntimeProfile` is consumed at exactly one
   runtime call site (`TextRequestEnrichmentService.applyTextRuntimeProfile()`, caller-wins, fail-open) —
   surface it as a section of the provider configuration, not a peer screen.
5. Keep every retired route as a `redirect()` for one release with a comment naming the deleting release
   (`13-nextjs-apps.md` §Routing).
6. Add export/import UI over TASK-844's masked export. **The UI must never render a full secret**, and must
   state plainly that imports require re-supplying credentials.
7. **HuggingFace download** (model store tab): model the Hub flow — `huggingface_hub`, LFS, resumable
   transfer, disk space. **Gated models require a human to accept terms on the Hub per repo and cannot be
   automated** — surface that as an explicit, actionable error state, never a silent failure.
8. Fix the two `DetailDrawer` deviations (`/tools-mcp`, `/rate-limits`) while in the area — they are the
   only two component-standard violations on this surface.
9. Accessibility: axe at 0 violations, both themes, keyboard pass (§3.5 rule 23).

### Verification
- `pnpm --filter @arcaai/admin-console build lint test`.
- Runtime verification in a running `next dev` via the `next-dev-loop` skill — compiling is not working.
- Every retired route redirects; no dead links from `nav-config.ts`.
- axe 0 violations per tab, both themes.

### Risks
| Risk | Mitigation |
|---|---|
| A "one screen" with five tabs is just the old chaos in a tab bar | Tabs are by **user intent**; the merge only works because TASK-844 unified the model underneath. Do not attempt this screen before TASK-844. |
| Retiring routes breaks deep links | One-release `redirect()` per §Routing |
| Secret leaks via export UI | TASK-844 step 9 test is the gate |

---

# TRACK C — MCP connectors and tools

---

## TASK-846 — MCP Connector Tenant Scoping & Agent Tool Binding

| | |
|---|---|
| **Tier / Effort** | `sonnet` / **high** — moderate build, but it crosses a documented privilege boundary, so the authorization stage is `opus` / high |
| **Depends on** | nothing for the connector work; **TASK-847** for the node-descriptor half |
| **Owns** | `apps/api/src/modules/mcp-admin/`, `packages/applications/.../mcp-server-admin.service.ts`, `apps/admin-console/src/features/tools-mcp/` |
| **Type** | `feature` |

### ✅ Owner decision taken — OD-7 (2026-09-01)
**Tenant admins may configure MCP connectors and tools.** This **explicitly reverses**
`.claude/rules/05-nestjs-api.md:46`, which names "MCP writes" as a deliberate super-admin-only exception.
**`05-nestjs-api.md` must be amended in the same change**, or the codebase and its rules disagree.
Per **OD-11**, MCP tools are **per-tenant**.

### Requirement analysis
One screen manages MCP connectors (interfaces to external MCP services, tenant-configurable) and tools
(functions an agent can call). Agent nodes can be given tools.

### Current state (F-15)
More is built than the "chaos" framing suggests:
- A real `McpServer` Prisma model (`mcp-server.prisma:31-79`), a real gateway module
  (`modules/mcp-admin/mcp-admin.controller.ts`), and a real, **tested, full-CRUD** admin screen.
- A **genuine MCP protocol client** wrapping the official `mcp` Python SDK (`harness/tools/mcp_client.py`).
- Gated **four independent ways**: the `(global)` route group, a UI check (`tools-mcp-screen.tsx:66-91`),
  an imperative `assertSuperAdmin()` (`mcp-server-admin.service.ts:165-170`), and the platform-wide
  `HarnessPolicy.mcpToolsEnabled` switch.
- **Seeded tenant-admin roles already hold `manage:McpServer` in CASL** (`seed/01-policy.ts:224-225`) — the
  declarative grant exists and the imperative check overrides it.
- Tool execution runs **one hardcoded tool** (`validate_codes`), selected deterministically by workflow
  code, **never by an LLM**. `live-tool-registry.ts` explicitly documents that it is *not* model-initiated
  tool calling. `apps/text`'s Bedrock "tools" usage is a JSON-schema-forcing trick, not tool exposure.
- **`WorkflowNodeDescriptor` (`node-registry.ts:41-146`) has zero tool/MCP fields** — an agent node has
  nowhere to record which tools it may call.

### Implementation plan
1. Record the OQ-1 decision. Amend `05-nestjs-api.md`'s Imperative Privilege Checks table in the same change.
2. Relax `assertSuperAdmin()` to permit **own-tenant** writes while keeping cross-tenant writes at 404
   (404-over-403 for cross-tenant; 403 only for genuine privilege, §3.2 rule 6). Keep the `// AUTH-NOTE:`
   marker and update its text to describe the new rule.
3. Move or dual-render the screen so tenant admins reach it — it currently lives in `(global)` (tier 10–19).
   Per `13-nextjs-apps.md`, a shared-audience screen belongs in tier 20–29 and must work in both
   cross-tenant and tenant-scoped modes.
4. **`mcpToolsEnabled` becomes per-tenant (OD-11).** Resolve it on the standard tenant → SYSTEM
   cascade. A platform-wide emergency kill-switch may sit above it, but it is not the per-tenant control.
   Without this step, steps 2–3 still leave a silent blocker.
5. Credentials for an outbound connector (bearer/OAuth) are **secrets**: Vault-Transit ciphertext or a
   `credentialsRef`, never a plaintext DB column (§3.2 rule 8).
6. Add tool/MCP fields to `WorkflowNodeDescriptor` — **references only, never resolved endpoints or
   credentials** (§3.4 rule 16). Coordinate with TASK-847; the dual-language parity gate means the Python
   contract package changes in the same commit.
7. Build a **per-tenant tool allow-list**. In a PHI system a tenant-authored graph must not reach an
   arbitrary MCP server; the allow-list is the containment boundary.
8. Real model-initiated tool calling (the loop where an LLM chooses a tool) belongs to TASK-847/848 —
   **this ticket delivers the registry and the binding, not the loop.**

### Verification
- Tenant admin can CRUD own-tenant connectors; cross-tenant id → **404**; non-admin → **403**.
- `mcpToolsEnabled` off ⇒ connectors configurable but not invocable, with a clear UI state.
- Node descriptor parity test green in both languages.
- No credential in any DB column in plaintext — asserted by test.

### Risks
| Risk | Mitigation |
|---|---|
| Tenant-authored connector reaches an arbitrary host from inside the cluster | Step 7 allow-list + egress policy; treat as a PHI containment control, not a nicety |
| Rule file and code disagree | Step 1 amends the rule in the same change |

---

# TRACK D — Consultation Workflow Studio

*Gated on TASK-843 (OD-4). Do not start node work before the task taxonomy lands — STT/TTS nodes need
task-scoped provider configurations that do not exist yet.*

**The substrate is already built (F-11). Do not rebuild it.** A generic `WorkflowInterpreter` Temporal
workflow, a `@xyflow/react` canvas Studio with palette/drag-connect/typed validation/inspector/undo-redo/OCC
autosave, and immutable published versions with a DB trigger all exist. Track D **extends**; it does not
recreate.

---

## TASK-847 — Workflow Node Contract Extension

| | |
|---|---|
| **Tier / Effort** | `opus` / **high** — the contract is dual-language, parity-gated, and every later ticket depends on getting it right |
| **Depends on** | TASK-843, TASK-844 |
| **Owns** | `packages/workflow-contract/`, `packages/py-workflow-contract/`, the studio inspector |
| **Type** | `feature` |

### Requirement analysis
Eight node types with the contracts in the original requirement. Agent nodes bind to **one** provider
configuration, carry an instruction prompt, generation hyper-parameters, optional guardrail nodes on
input/output, and optional tools. Input/Output nodes carry tenant-defined JSON schemas.

### Current state (F-12)
50 node types exist, dual-language parity-gated. **Missing: Loop, Data, TTS, and any generic Agent.**
Agent exists only as ~13 fixed-purpose types; STT exists ×8 but all are placeholders.
`temperature`/`maxTokens`/`topP` exist; **`frequency_penalty`/`presence_penalty` do not.**
`WorkflowNodeDescriptor` has zero tool/MCP fields.

### Implementation plan
1. Add a **generic Agent node** whose behaviour is configuration, not type. The ~13 fixed-purpose types
   stay for compatibility; new work targets the generic node. Do not delete the fixed types in this ticket.
2. Add **Data** and **Loop** node types; promote **STT** from placeholder to real; add **TTS** (OD-4).
3. Add `frequencyPenalty` and `presencePenalty` to the hyper-parameter set. **Gate them by provider
   capability** — not every provider accepts them, and silently dropping a parameter the user set is worse
   than refusing it.
4. Add tool binding fields (coordinate with TASK-846) — **references only** (§3.4 rule 16).
5. **Ceiling vs value.** Platform admin sets ceilings; tenant sets values within them. vLLM **cannot enforce
   per-request ceilings** (`--override-generation-config` sets *defaults*; the caller wins) and per-tenant
   concurrency is not a vLLM concept at all. **Ceilings must be enforced in `apps/text` against a
   tenant → SYSTEM descriptor**, never at the engine.
6. **Loop bounds — the spec is missing one.** Ship `max_iterations`, `max_time` **and a
   `max_tokens_total` / cost ceiling**; 50 iterations on a large model is an unbounded invoice. Add a
   no-progress check. **`max_time` must be a workflow timer, never wall-clock** (§3.4 rule 14).
7. Edge validation, three tiers, and **only tier 1 blocks**:
   - **Tier 1 — kind check** (`text|object|audio|flag|stream<…>`), blocking via `isValidConnection`. Catches
     ~80% at zero cost.
   - **Tier 2 — shallow structural** (required props, one level of primitive types): **warning only, never
     blocking.** Skip `oneOf`/`allOf`/patterns entirely. *A validator that cries wolf is the most hated
     feature you can ship.*
   - **Tier 3 — runtime schema validation at node boundaries.** This is where correctness actually lives.
   - Escape hatch: when tier 2 warns, offer to insert a **Data node** — which is exactly what it is for.
8. Keep the dual-language parity gate green: TS and Python contract packages change together.

### Verification
- Node-registry parity test green; canonical-JSON fixture test green.
- A graph using every new node type compiles to a valid IR.
- A provider that rejects `presencePenalty` produces a clear validation error, not a silent drop.
- `pnpm --filter @arcaai/workflow-contract test`; harness contract tests.

### Risks
| Risk | Mitigation |
|---|---|
| Node schema stores a model id/endpoint/key ⇒ bypasses the cascade and BYOK funding | **The single most important review item in Track D.** References only; resolve in the activity; fail closed on a disabled connection |
| Over-strict validation makes the editor unusable | Tier 2 warns, never blocks |
| Fixed-purpose types and the generic node drift | Generic node is the target for new work; document the deprecation path |

---

## TASK-848 — Interpreter Loop Support & IR Versioning

| | |
|---|---|
| **Tier / Effort** | `opus` / **xhigh** (consider `fable` for the determinism/versioning design stage) — replay correctness is the hardest constraint in the program |
| **Depends on** | TASK-847 |
| **Owns** | `apps/harness/src/harness/temporal/interpreter/`, worker deployment config |
| **Type** | `feature` |

### Requirement analysis
The Loop node runs an agentic loop: a master/orchestrator agent plus sub-agents under its instruction,
bounded by iteration/time/cost.

### Current state (F-11)
`WorkflowInterpreter` (`interpreter/workflow.py:87`) already walks `config.stages` and dispatches through
`NODE_REGISTRY`. Its docstring bounds it: *"Linear stage walk + single-level fan-out with an all-settled
join. Nothing else (v1)."* Task queue `harness-task-queue`; replay-compat fixtures at
`tests/unit/temporal/test_replay_compat.py`.

### Architecture — settled, do not re-litigate
**One generic versioned interpreter workflow type per IR major version, receiving a compiled immutable
graph IR as workflow input; interpreter *code* changes handled by Worker Versioning `Pinned`; child
workflows only for LOOP sub-agents.**
The determinism argument: Temporal's constraint is on workflow **code**, not **data**. Passing the graph as
input puts it in `WorkflowExecutionStarted` — in history — so replay feeds back the identical graph plus
identical recorded activity results and emits the identical command sequence. This is a first-party pattern
(`temporalio/samples-python/dsl`). **A tenant edit becomes a data change, not a code change** — every
alternative turns a tenant edit into a deploy.
**"The graph cannot change mid-run" is a feature — hold that line.** For clinical work an auditable frozen
pipeline is correct; a run that silently changed mid-flight is a compliance problem.

### Implementation plan
1. Extend the interpreter beyond the v1 bound: iteration with a `continue_as_new` boundary at each loop
   iteration, so history does not grow without limit.
2. **Ship orchestrator-workers only.** Most named agentic patterns are already **graph shapes** — chaining
   is nodes in series, routing is conditional edges, sectioning/voting is fan-out + fan-in, ReAct is the
   Agent node's tools. The Loop node earns its existence only for **runtime-unknown step counts**.
   Evaluator-optimizer is phase 2: same skeleton, different termination predicate.
3. Sub-agents run as **child workflows**, giving each its own history and retry envelope.
4. `irVersion` dispatch so graph-language changes never require `workflow.patched()`.
5. **Worker Versioning `Pinned`** for interpreter code changes. Note the legacy Build-ID mechanism is being
   removed from Server around **March 2026** — do not build on it.
6. **Claim-check to MinIO from day 1.** Payload limits are 2 MB/payload and 4 MB/gRPC message; clinical
   transcripts exceed that. Retrofitting rewrites every activity signature.
7. Enforce the TASK-847 bounds, including the cost ceiling, inside the loop.
8. Extend `test_replay_compat` with histories generated from **real tenant graphs**, not synthetic ones.
   Graph-as-data does **not** protect against interpreter *code* changes — this test is the protection.

### Verification
- Replay-compat green against real-graph histories.
- A loop hitting `max_iterations`, `max_time` and the cost ceiling each terminates cleanly with a
  distinguishable reason.
- `continue_as_new` keeps history bounded across a long loop — measure it.
- `pnpm harness:test`.

### Risks
| Risk | Mitigation |
|---|---|
| Interpreter code change breaks in-flight runs | Worker Versioning `Pinned` + `irVersion` + real-graph replay fixtures |
| History explosion | `continue_as_new` per iteration; assert with a test |
| Payload limits hit by clinical transcripts | Claim-check from day 1, never retrofitted |

---

## TASK-849 — Two-Lane Streaming, Binary Audio & Realtime Debug Canvas

| | |
|---|---|
| **Tier / Effort** | `opus` / **xhigh** — OD-4 added binary audio transport, making this the largest ticket in the program |
| **Depends on** | TASK-847, TASK-848 |
| **Owns** | `apps/api/src/modules/streaming/`, harness activities, the studio debug surface |
| **Type** | `feature` |

### Current state (F-13)
**There is no streaming producer anywhere.** `/workflows/:slug/runs/:runId/stream` is a disclosed
**2-second poll bridge** (`workflow-stream.service.ts:16-43`); run detail polls at 5s.

### Implementation plan
1. **Two-lane split — do not route tokens through Temporal** (§3.4 rule 17):
   - **Token / STT / TTS deltas → Redis Streams** — already HOPE's proven pattern, with message-id resume.
   - **Control events** (`node.started/completed/failed`, `loop.iteration`, `guardrail.verdict`) **→ Temporal.**
   Temporal's Workflow Streams (Public Preview, June 2026) has a ceiling of **51,200 events / 50 MB** per run;
   day 1 takes **no Public Preview dependency**. Use a `@workflow.query` state snapshot + Redis mirror;
   adopt Workflow Streams at GA behind the gateway.
2. **Transport to the browser is SSE**, reusing the existing single-use stream tickets and
   `TenantOwnedResourceSseGuard`. Traffic is unidirectional; cancel/approve are POSTs → Signals.
   A WebSocket buys nothing and duplicates the auth surface. **Never put a JWT in a URL.**
3. Client contract: **snapshot-then-delta with `Last-Event-ID`**, re-snapshotting on a trimmed-id gap.
4. **Binary audio (OD-4).** STT nodes take an audio file or stream; TTS nodes emit one. This needs a
   transport distinct from text SSE and pulls on the existing vox audio pipeline and the STT Redis Streams
   path. **Reuse `apps/stt`'s existing streaming transport rather than inventing a second one** — that reuse
   is what makes OD-4 affordable.
5. Debug canvas affordances worth copying (design lessons only — see the licence table in F-20):
   green/red node outlines with per-node Input/Output/Error tabs; a **per-iteration drill-down for the Loop
   node** (`◀ 3/12 ▶`); per-node "inspect output"; agent tool-call printing.
6. **Replay/scrub of a completed run comes free** because control events are durable — a genuine
   differentiator over every prior-art tool. Build it.
7. **Accessibility: a canvas cannot pass WCAG 2.2 AA alone.** Budget the keyboard-navigable **outline view**
   as a first-class alternative (est. 3–5 days), not as a discovery at the axe gate.

### Verification
- Token stream survives a client disconnect/reconnect with `Last-Event-ID` and loses nothing.
- A run with 10k token deltas adds **no** proportional Temporal history — measured.
- Audio round-trip through an STT node and a TTS node.
- axe 0 violations on the debug surface; full keyboard pass via the outline view.

### Risks
| Risk | Mitigation |
|---|---|
| Tokens leak into Temporal history | Enforce the split **with a test**, not a convention |
| Binary audio doubles the transport surface | Step 4 reuse; refuse a second bespoke audio path |
| Canvas fails the a11y gate late | Step 7 budgeted up front |

---

## TASK-850 — Workflow Invocation Surfaces

| | |
|---|---|
| **Tier / Effort** | `opus` / **high** — auth, idempotency and money-affecting retry semantics |
| **Depends on** | TASK-848, TASK-849 |
| **Owns** | gateway workflow-run controller, `exposure-palette-policy.ts`, `packages/vox-node/`, `packages/agentic-sdk-v2/` |
| **Type** | `feature` |

### Current state (F-14)
**1 of 4 surfaces exists**, off by default, and
`EXPOSURE_ALLOWED_PALETTES = new Set(['summarization'])` (`exposure-palette-policy.ts:61`) **explicitly
refuses the `consultation` palette** — a consultation workflow cannot be REST-invoked today at all.
Verified **false**: the claim that TASK-806 widened palettes to a derived capability set. Multi-palette is
an **open question**, not settled work.

### Implementation plan
1. **One handler; all four surfaces converge on it.** `POST /api/v1/workflows/{slug}/runs` on the existing
   `UnifiedAuthGuard`, with a new `ConsultationWorkflow:execute` ability and a `workflows:execute` scope.
2. Lift `EXPOSURE_ALLOWED_PALETTES` to admit `consultation` — deliberately, with a test pinning which
   palettes are exposable.
3. **Idempotency uses Temporal natively:** `Idempotency-Key` → Workflow ID with
   `WorkflowIdConflictPolicy: UseExisting`, so a retried webhook **joins** the existing run rather than
   double-billing an LLM run.
4. Two response modes on one endpoint: streaming and blocking. Blocking gets a hard ~60s ceiling, then
   504 with "switch to streaming".
5. **Webhook** = the same handler + Stripe-style HMAC (`t=…,v1=…`), a 5-minute replay window and Redis
   dedup. **The signing secret lives in Vault, never a DB column** (§3.2 rule 8).
6. **Client disconnect never cancels the run** — the durable-execution advantage over every prior-art tool.
7. SDK surfaces: Vox (browser, API key) and Vox-node (API key **or** service account). Remember
   `workingTenantId` binds at **exchange** for service accounts, so `X-Tenant-Id` is never sent alongside one.
8. `packages/vox-node/src/resources/admin/**` is **generated** — never hand-edit. Regenerate all five
   artifacts together: `pnpm api:build && pnpm api:route-manifest && pnpm api:openapi && pnpm api:portal &&
   pnpm --filter @arcaai/vox-node gen:admin`.

### Verification
- All four surfaces reach the same handler; route-authz matrix green.
- A duplicate `Idempotency-Key` joins rather than starts a second run — asserted.
- Disconnect mid-stream; the run completes; reconnect replays from `Last-Event-ID`.
- `pnpm api:openapi:check`, `pnpm api:portal:check`, `gen:admin:check` all green.

### Risks
| Risk | Mitigation |
|---|---|
| Retried webhook double-bills an LLM run | Step 3 — `UseExisting`, not a fresh run |
| Palette policy widened too far | Test pins the exposable set |
| Generated SDK left behind ⇒ CI red | Step 8's five-artifact regeneration |

---

# TRACK E — Embedded platform consoles

---

## TASK-851 — Embedded MLflow, Temporal and MinIO Consoles

| | |
|---|---|
| **Tier / Effort** | `sonnet` / **medium** — the pattern already exists in-repo; the authorization stage is `opus` / high |
| **Depends on** | TASK-838 (CSP must allow `'self'`), TASK-840 (MLflow up), TASK-842 (MinIO pinned) |
| **Owns** | `apps/api/src/modules/` proxy modules, `apps/admin-console/src/features/` embed screens |
| **Type** | `feature` |

### ⚠ Access rule (OD-6)
**Platform admin (SUPER_ADMIN) only. Tenant admins are not eligible for any of the three.**
This is a **403 privilege boundary**, not the 404-over-403 cross-tenant posture (§3.2 rule 6). Each route
carries a `// AUTH-NOTE:` marker and a class- or handler-level decorator so the deny-by-default boot audit
stays green. Screens live in the `(global)` route group, tier 10–19.

**OD-6 is what makes this safe.** Temporal's ui-server performs **no namespace-level authorization at all**,
and MinIO's console performs none either. Embedding them would be indefensible if any tenant principal
could reach them; platform-admin-only removes that exposure.

### The pattern — already proven in this repo (F-18)
`features/db-studio` + `apps/api/src/modules/pstudio/`: a same-origin iframe at `/api/hope/admin/pstudio`,
the gateway serves the HTML behind `manage:PrismaStudio`, the shell posts back to
`window.location.pathname` so the cookie rides along, and **no token ever reaches the browser.** Copy it.

### Hard constraint — same-origin only
The session cookie is **host-only, `SameSite=Lax`** (`session.ts:88-96`). Any cross-origin embed —
**including a subdomain** — simply will not receive it. Traefik and subdomain patterns are eliminated
unless the cookie is widened, which for PHI is a regression to refuse.

### Per-GUI plan
**MLflow — the fast win. Do it first.**
- The `--static-prefix` REST bug was fixed in 3.12.0; we pin 3.15.2, so we are clear.
- MLflow emits **no CSP at all**, and `--x-frame-options NONE` is the *documented* iframe recipe.
- Proxy-header auth is the *documented* auth pattern.
- **`features/mlflow`'s `mlflow-screen.tsx` already renders a conditional iframe** the moment a live
  `X-Frame-Options` probe flips `embeddable`. **Enabling it is a deployment action, not a code change.**
- **Keep the health probe un-prefixed**: `/health` and `/version` are never static-prefixed and host
  validation exempts the exact path `/health` — which is what our probe hits.

**Temporal — embeddable, but keep the native screen as primary.**
- Sends `X-Frame-Options: SAMEORIGIN`, hardcoded via echo's `middleware.Secure()` — **no knob**. Same-origin
  framing therefore works.
- Sub-path support has regressed twice — 2.25.0 (CSP) and **2.45.3 (path duplication, Feb 2026)**, eight
  minors before our pinned 2.53.1. **Verify `TEMPORAL_UI_PUBLIC_PATH` against the pinned image before
  estimating.**
- `features/harness-ops` already provides list/detail/cancel/terminate/signal, **tenant-filtered and
  audited**. Embed as a platform-admin *diagnostic*; the native screen stays the operational surface.
- `TEMPORAL_DISABLE_WRITE_ACTIONS=true` from TASK-838 stays on — writes go through the native RBAC path.

**MinIO — embed the pinned console.**
- Pinned to `RELEASE.2025-04-22T22-12-26Z` by OD-5/TASK-842 precisely to retain the console.
- Sends `X-Frame-Options: DENY`, with known escapes including an STS deep-link whose upstream source reads
  `// Allow us to be iframed`. **Verify the chosen escape against the pinned image before committing.**
- **Cookie hazard:** MinIO's console cookie is named `token` at `Path=/`. Under a same-host sub-path proxy
  it is sent to *every* path on that origin, including the BFF. HOPE is safe today
  (`hope_admin_session`), but **the proxy must scope or strip `token` regardless** — this generalises to a
  rule for every future embed.
- AGPLv3: the iframe-vs-network-API distinction is the common industry reading, **not legal advice**.
  Flag to counsel with OD-1.

### Implementation plan
1. MLflow first — deployment action plus the `--x-frame-options NONE` flag and the AUTH-NOTE'd proxy route.
2. `curl -I` each upstream against its **pinned** image and record actual XFO/CSP values in the ticket
   **before** estimating the other two.
3. Gateway proxy module per GUI, modelled on `pstudio`: SUPER_ADMIN-gated, same-origin, credential
   server-side only, cookie scoping/stripping per the MinIO hazard.
4. Layout: the embed fills `ScreenTemplate`'s `contentMode="fill"` region. **One scroll container per panel**
   — never nest a second scroll area (§11 rules). The embedded GUIs will not follow HOPE's dark mode;
   accept the visual mismatch rather than injecting CSS into third-party frames.
5. Never expose any of the three via an Ingress.

### Verification
- Non-super-admin → **403** on all three; cross-tenant id → 404 where applicable.
- All three render inside the shell without a nested scrollbar war.
- No token or credential observable in browser storage or network from the client side.
- `db-studio` still works (shared CSP).

### Risks
| Risk | Mitigation |
|---|---|
| Temporal sub-path regression on the pinned image | Step 2 verification before estimating |
| MinIO `token` cookie collides with BFF paths | Step 3 scoping/stripping |
| AGPL exposure | Flag to counsel; network-API alternative already exists natively |
| Embeds drift from native screens | Native screens stay primary; embeds are diagnostics |

---

# TRACK F — Realtime clinical consultation

*The runtime exists. This track switches it on and makes its capabilities admin-configurable.*

---

## TASK-852 — Realtime Consultation Activation & Per-Node Capability Toggles

| | |
|---|---|
| **Tier / Effort** | `opus` / **high** for items 3–4 (a dual-runtime contract change); `sonnet` / **medium** for items 1–2 and 6–8 |
| **Depends on** | nothing — **this is independent of Tracks A–E and can start immediately** |
| **Owns** | `packages/workflow-contract/src/node-config-schemas.ts`, `apps/harness/.../interpreter/workflow.py`, `live-documentation.service.ts`, the seed |
| **Type** | `feature` / `bugfix` |

### Requirement analysis (OD-13)
Realtime clinical consultation with admin-configured realtime transcription, partial summarization and NER
extraction. **Do not build a realtime runtime — one exists** (F-21). This ticket activates it, makes the
per-capability toggle reachable, and stops the console misleading admins about which switch does what.

### Current state
See **F-21, F-22, F-23, F-24**. Three blockers, in order of severity:
- **E-1** — `consultation.realtime.graphExecutor.enabled` defaults `false`; no row seeded anywhere.
- **E-2** — TASK-798's `WorkflowAssignment` rows gate on `detectSubstrateExclusivityGate().present`.
  **Verified 2026-09-01: the probe now passes** (11 executable `workflow` refs in
  `loop-context-signal.service.ts`; TASK-795's marker is implemented at `governing-engine.ts:58,62`).
  **TASK-798's README claim that the flag is `false` is STALE.**
- **E-3** — the `enabled` toggle is implemented in the executor but undeclared in every node schema (F-22).

### Implementation plan
| # | Change | Kind | Days |
|---|---|---|---|
| 1 | Set `consultation.realtime.graphExecutor.enabled = true` at tenant scope via the existing registry write route (`settings-registry-write.controller.ts:106`). Every check passes: `global-kv`, `maxScope: tenant`, not `globalOnly`, not secret. **Safe alone** — with no tenant graph, `PLATFORM_REALTIME_LANE` reproduces the legacy sequence as a graph. | **[exists]** — zero code | 0.25 |
| 2 | Land the `WorkflowAssignment` rows (the gate now passes). Decide the `safe`/day-1 exclusion set. | **[wire-up]** | 0.5 |
| 3 | **Add `enabled: {type:'boolean', default:true}` to `NODE_RUNTIME_PROPERTIES`** so `withRuntimeProperties` folds it onto every node type. The executor already honours it; the Studio inspector already renders booleans as a `<Switch>` (`inspector/field-renderers.tsx:130-141`); `GET /admin/workflow-nodes` already serves `configSchema`. **Exclude `mandatory` nodes** — `consentGate`, `captureBinding`, `phiHop`, `persistDraft`, `finalizeAssurance`, `hitlGate`. *A consent gate an admin can switch off is a compliance defect.* | **[build]** | 0.75 |
| 4 | Honour `enabled` in `_dispatch_node` with `reason="disabled_by_config"`, beside the existing `realtime_lane`/`sandbox` skips. `CompiledNode.config` is already a free `dict[str, Any]`, so **no model change**. **Must ship with #3** — a toggle honoured by one runtime and ignored by the other is worse than no toggle. | **[build]** | 0.5 |
| 5 | Seed `agent.important_findings` into both ArcaAI graphs, instruction bound to a SYSTEM `PromptTemplate`. This is why TASK-806 §8 still records *"no important-information highlighted layer exists anywhere"* — the node is implemented, handled and on the DTO, but in no tenant graph. | **[build]** | 1.0 |
| 6 | "Realtime capabilities" read-out: lane source, definition slug + version, per-node enabled state. The data exists (`realtime-lane.ts:74-82`) but has no read API. | **[build]** | 1.5 |
| 7 | **Stop the console misleading admins (F-23).** Relabel the Pipeline Policy columns as *post-consultation*, and mark the `feature-flags` rows advisory. | **[build]** | 0.5 |
| 8 | Run one live end-to-end session — TASK-821 §9's named follow-up that never ran — then flip one node off and re-record. | **[wire-up]** | 1.0 |

**Core (1–4): 2.0 engineer-days.** Delivers realtime transcription + partial summarization + live NER from
a tenant-authored graph with a per-capability Studio switch. **Full slice (1–8): 6.0 engineer-days.**

### Why this needs no new invocation surface (and does not reopen C-8)
The session-bound entry point already exists and breaks **every link** of the C-8 chain:

| C-8 on `/workflows/:slug/invoke` | The recording path |
|---|---|
| `consultationId` arrives in caller-controlled `dto.input` | It is a **PATH param**, re-resolved by `verifyConsultationOwnership` + `@TenantOwnedResource` 404-over-403, then **frozen** into `session.{consultationId,tenantId}` at `start()`. No request field can name another consultation. |
| `sandbox: false`, so the external-write suppression never fires | The realtime executor **dispatches no Temporal activity at all** — in-process closures built from the frozen session. There is no payload to trust. |
| `consultation.persistDraft` reaches the shared activity | **`persistDraft` is `lane: 'durable'`** (`node-registry.ts:686`) and is **not** among the 7 realtime handlers; `buildRealtimeLane` filters it out. **Structurally unreachable.** |
| API-key-reachable; `paletteKey` is free text | Tenant-scoped clinical route behind `UnifiedAuthGuard` + abilities + `@RequiresConsent(AI_DOCUMENTATION)`. The graph comes from the server-side `WorkflowAssignment` cascade, never named by the caller. |

**The invariant to preserve:** *consultation identity comes from the URL and is re-resolved against the
caller's tenant — never from a caller-composed payload.* A future machine-to-machine entry uses a service
account on the same route (`workingTenantId` binds at exchange); **it does not widen the allow-list.**

### Verification
- With the flag on and no tenant graph: behaviour identical to today's legacy flush.
- With the assignment landed: live transcript, live entities and incremental summary all stream.
- Flip one node's `enabled` to false, republish, re-record → that capability stops, others continue,
  and the skip is **logged, not silent**.
- The same toggle is honoured by the durable interpreter (item 4).
- `pnpm --filter @arcaai/workflow-contract test`; `pnpm harness:test`.

### Risks
| Risk | Mitigation |
|---|---|
| Toggle honoured by one runtime, ignored by the other | Items 3 and 4 ship together — non-negotiable |
| An admin disables a consent or capture gate | `mandatory` nodes excluded from the toggle (item 3) |
| Published definitions are immutable, so a toggle means clone→flip→publish v(n+1) | Accepted for the fast-win. A runtime override overlay is a **second enforcement path** and needs an owner decision — deferred |
| Activation surfaces latent TASK-811 defects | Known: encrypt-failure silently loses edits; a persisted edit publishes no patch. Item 8's live session is where these show up |

---

## 5. Model / effort tier alignment

Per `14-multi-agent-worktrees.md` §1. The rules that make this table save money without costing quality:
**tier per stage, not per pipeline**; **never downshift the stage whose verdict you act on**; **effort is a
per-call dial, spent on every turn of the agent's loop**; **escalate on evidence, not on a hunch**; and
**cheaper tiers need tighter briefs** — ambiguity is what the expensive tiers are actually buying.

| Ticket | Stage | Tier | Effort | Why this tier |
|---|---|---|---|---|
| **838** Security headers | implement + verify | `sonnet` | medium | Mechanical edit, but "does CSP break db-studio" is a verdict acted on |
| **839** Probe fix | fix | `sonnet` | medium | One line-group, pattern already exists in-repo |
| | call-site census | `sonnet` | high | Breadth matters more than depth; the output is a list to act on |
| **840** MLflow bring-up | manifest correction | `opus` | medium | Four independent defects in the prior manifest; a wrong one fails silently |
| | prerequisites + PHI control | `opus` | medium | Live environment, irreversible-ish ops, PHI setting |
| **841** LM Studio bring-up | manifest authoring | `opus` | high | A missing manifest must be **authored**, and three prior claims are stale |
| | model publish + sync | `sonnet` | medium | Mechanical once the versions are captured |
| **842** MinIO pin | pin | `sonnet` | medium | Mechanical version/digest change |
| | **CVE exposure assessment** | **`opus`** | **high** | **A verdict acted on — could reverse OD-5. Never downshift this stage.** |
| **843** Task taxonomy | schema design | `opus` | xhigh | One taxonomy absorbing three mechanisms without breaking live inference |
| | backfill + migration | `opus` | high | Data-bearing, row-count-asserted |
| **844** Routing absorption | schema + election | `opus` | xhigh | Reverses an owner decision; a wrong migration stops day-1 inference |
| | export/import masking | `opus` | high | A secret-leak surface; the verdict is a security property |
| **845** Unified screen | information architecture | `opus` | high | The IA *is* the deliverable; getting it wrong reproduces the chaos in a tab bar |
| | component build | `sonnet` | high | Patterns (`ScreenTemplate`, `DetailDrawer`) already established |
| | a11y pass | `sonnet` | medium | Checklist-driven against a known standard |
| **846** MCP scoping | authorization change | `opus` | high | Crosses a documented privilege boundary in a PHI system |
| | screen + CRUD | `sonnet` | medium | The screen already exists and is tested |
| **847** Node contract | contract design | `opus` | high | Dual-language, parity-gated; every later ticket depends on it |
| | inspector forms | `sonnet` | medium | Repetitive form work against a settled schema |
| **848** Interpreter + IR | **determinism / versioning design** | **`opus` (consider `fable`)** | **xhigh** | **The hardest correctness constraint in the program; replay bugs surface in production, not in CI** |
| | loop implementation | `opus` | high | Temporal semantics, `continue_as_new` boundaries |
| **849** Streaming + audio | transport design | `opus` | xhigh | Two-lane split + binary audio; a wrong split poisons Temporal history |
| | debug canvas UI | `sonnet` | high | UI work against a settled event contract |
| | a11y outline view | `sonnet` | medium | Known standard, budgeted up front |
| **850** Invocation | auth + idempotency | `opus` | high | Money-affecting retry semantics; four credential classes |
| | SDK regeneration | `haiku` | default | Mechanical: run five generators, commit the artifacts |
| **851** Embedded consoles | authorization | `opus` | high | Three god-mode consoles in a PHI platform |
| | proxy + layout | `sonnet` | medium | `pstudio` is a working in-repo template to copy |
| | upstream header probe | `haiku` | default | Literally `curl -I` against three pinned images, record values |

**Worktree isolation** (`14-multi-agent-worktrees.md` §3): tickets that write to disjoint packages may run
in parallel worktrees. **The orchestrator alone owns** merges, branch switches, `pnpm install`,
`db:push`/`db:migrate`/`test:db:reset`, and all Docker/cluster operations. Never let a subagent reset the
database while a sibling runs integration tests. **Merge into the active branch before removing any
worktree** (§5) — never prune to tidy up.

**Read-only fan-out is free.** Exploration, inventory and review agents need no worktree; pick the cheapest
tier that reads accurately.

---

## 6. Sequencing and critical path

```
TASK-838 ─┐  (security, no dependencies — start immediately)
TASK-839 ─┼─→ TASK-840 (MLflow) ─→ TASK-851 (embeds)
TASK-842 ─┘   TASK-841 (LM Studio, needs 842's bucket)

TASK-843 (task taxonomy)  ← THE CRITICAL PATH NODE
   ├─→ TASK-844 (routing absorption) ─→ TASK-845 (unified screen)
   └─→ TASK-847 (node contract) ─→ TASK-848 (interpreter) ─→ TASK-849 (streaming) ─→ TASK-850 (invocation)

TASK-846 (MCP) — connector half is independent; node-descriptor half joins at TASK-847
```

**TASK-843 is the critical path.** It blocks both Track B and (because of OD-4) all of Track D. Nothing in
Track D should start before it lands, or STT/TTS nodes will be built against provider configurations that
do not exist.

**Recommended order of attack:**
1. **TASK-838** — hours, no decisions, closes a live hole where anyone reaching port 8233 can terminate a
   clinical workflow.
2. **TASK-839** — makes the console stop lying, so every later bring-up has a truthful signal.
3. **TASK-842 → TASK-840 → TASK-841** — the services come up, MLflow first (lowest risk).
4. **TASK-843** — unblock everything else.
5. Then Track B and Track D in parallel, and TASK-851 whenever MLflow is up.

**Realistic day-1 inference posture:** LM Studio serves the five GGUF models; MLflow comes up as the
registry/experiment plane; vLLM follows with **Qwen3-4B-AWQ** (already published, measured 241.8 MiB/s,
~7 concurrent sequences at 4k on one 16 GiB card) once `OPEN-823-TLS` clears. **GGUF-on-vLLM only as a
recorded risk acceptance** (F-5). The 20–40 concurrent target needs an A100/H100 — that is a **purchase,
not a flag**.

---

## 7. Open questions

**All open questions are resolved.** Round 1's answers are recorded as **OD-7 … OD-13** in §1.

| # | Question | Blocks | Status |
|---|---|---|---|
| ~~OQ-1~~ | Tenant-admin MCP connectors | TASK-846 | **RESOLVED — OD-7.** Yes; amend `05-nestjs-api.md` in the same change. |
| ~~OQ-2~~ | Azure translation approach | TASK-843 | **RESOLVED — OD-8.** Removed entirely; translation is Sarvam-only. |
| ~~OQ-3~~ | `nvidia.com/gpu.mode: "graphics"` | TASK-840, vLLM | **RESOLVED — OD-9.** GPU/CUDA is the target; graphics-mode is now a bring-up verification step, not a design question. |
| ~~OQ-4~~ | MinIO strategic direction | strategic | **RESOLVED — OD-10.** Pin frozen. TASK-842 step 6 is closed; do not pursue AIStor/fork/migration. |
| ~~OQ-5~~ | Fast-win for realtime clinical consultation | TASK-852 | **RESOLVED — OD-13.** The runtime already exists and is switched off. Activate, do not build. Core 2.0 engineer-days. |
| ~~OQ-6~~ | Scope of `mcpToolsEnabled` | TASK-846 | **RESOLVED — OD-11.** Per-tenant. |
| ~~OQ-7~~ | Stale worktree | housekeeping | **RESOLVED — OD-12. Done.** |

### Note on OQ-5 — what a "palette" is, and why `consultation` is refused

The original OQ-5 was posed in internal terms. Restated plainly:

A **palette** is a family of workflow node types. Every `WorkflowNodeDescriptor` in
`packages/workflow-contract/src/node-registry.ts` declares a `paletteKey`; the palettes are
`summarization`, `consultation`, `stt`, plus palette-agnostic nodes (`paletteKey: null` — `noop`,
`passthrough`, `core.start`, `core.end`) that belong to no palette and are always permitted.

`EXPOSURE_ALLOWED_PALETTES` (`exposure-palette-policy.ts:61`) governs **one specific thing**: which
palettes may be invoked through the **public exposure plane**, `POST /workflows/:slug/invoke`. It admits
`summarization` only, and the reasons are substantive, not arbitrary:

- **`consultation` is refused because of finding C-8, a real vulnerability.** The exposure route forwards
  caller-controlled `dto.input` verbatim into `InterpreterInput.payload` with `sandbox: false`. The
  interpreter's external-write suppression reads `if inp.sandbox and spec.external_write:` — it fires
  **only in sandbox**, so it does not apply here. Four of the consultation palette's thirteen nodes declare
  `externalWrite`, and `consultation.persistDraft` reaches **the same activity the real consultation
  workflow uses**. A caller could therefore write real `ContextItem` rows into **any** live consultation by
  supplying its `consultationId` / `externalPatientId`. The route is API-key-reachable by design.
- The gate deliberately resolves the palette of every **node type actually present**, from two independent
  sources — not the declared `paletteKey` — because nothing in `validate()` or `compile()` requires a
  graph's nodes to belong to its declared palette. Keying on the declared value would leave C-8 open to a
  one-word edit.
- **`stt` is refused because it is not a product on that plane**: every `stt` interpreter node is a
  registry-parity **placeholder** returning `DEGRADED` (`interpreter/nodes/stt_placeholder.py`). The real
  artifact is the `AsrPipeline` compiled at publish time. Exposing it would promise transcription and
  silently deliver nothing.

**Therefore the fast-win must not lift this allow-list.** A realtime clinical consultation does not need the
public exposure plane at all — it needs a **session-bound entry point where `consultationId` comes from
server-side session state and never from caller payload**. That is what makes it safe where the exposure
plane is not, and it is the shape OD-13 will specify.


## 8. Implementation Summary

Not started. This document is the plan of record produced on 2026-09-01 from an eleven-agent parallel
investigation. **No repository or cluster change has been made** beyond the creation of this file.

---

## 9. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Program opened. Eleven-agent investigation completed; findings F-1 … F-20 recorded. Owner decisions OD-1 … OD-6 taken. Fourteen child tickets (TASK-838 … TASK-851) specified across five tracks with tier/effort alignment. Seven open questions raised. |
