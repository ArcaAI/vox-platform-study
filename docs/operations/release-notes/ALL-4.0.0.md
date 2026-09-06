# Release note — `ALL-4.0.0` (working name)

| | | | |
|---|---|---|---|
| **Train** | `ALL-4.0.0` (platform-wide) — **working name only** | **Date** | drafted 2026-09-07 |
| **Status** | **Draft — R1 tag to be named by the owner (TASK-859 OD-2)** | **SDK family** | `@arcaai/*` 3.0.0 (unchanged) |

> **How to use this file.** Per [versioning.md](../versioning.md) §3, CI creates a DRAFT
> `ChangelogEntry` on an `ALL-` tag, pre-filled from `feat` + breaking-change commits, and a
> global admin edits it into plain language before publishing. **This file is the source text
> for that edit** — written for the person doing it, not for the machine. The tag is the version;
> nothing here is derived from a `package.json`.

> **Two naming facts to settle before this ships.**
> 1. **`ALL-4.0.0` is a placeholder.** The deprecation register calls the first removal release
>    `R1` and TASK-859 OD-2 — "name the removal-release tags" — is still open. Rename this file
>    and the register's `Remove in` cells together, in one commit.
> 2. **`ALL-3.0.0` is itself still an untagged draft.** If it never gets its own tag, R1 and
>    `ALL-3.0.0` collapse into ONE train and this file must absorb
>    [`ALL-3.0.0.md`](./ALL-3.0.0.md) rather than follow it. That is an owner call, not a
>    documentation one.

**Scope.** Everything merged onto `dev-2.2` after `ALL-3.0.0` was drafted (2026-08-18) — the AI
platform consolidation program (TASK-859..865), wave 3a's configuration retirement
(TASK-879..883, 887, 888), the settings-registry governance pass (TASK-870), and the agent /
prompt / context journeys (TASK-890). The per-surface detail lives in
[`apps/api/CHANGELOG.md`](../../../apps/api/CHANGELOG.md),
[`packages/agentic-sdk-v2/CHANGELOG.md`](../../../packages/agentic-sdk-v2/CHANGELOG.md) and
[`packages/vox-node/CHANGELOG.md`](../../../packages/vox-node/CHANGELOG.md); this file is the
plain-language layer over them.

---

## 1. What a tenant gets

**One place to build what the AI does, and it is theirs.** A tenant admin builds and publishes
**Agents** (an instruction, a model, parameters, tools, a pinned context schema) and
**Workflows**, tests a DRAFT agent on a bench before publishing it, and picks a model from a
catalogue that shows what is actually usable right now rather than everything the platform knows
about.

**Your content is your own copy, not a shared platform row.** Agents, agent assignments,
prompts, workflows and context schemas are **cloned into the tenant at creation** and can be
edited — which was never possible while the row was shared. Configuration (models, provider
connections, routing policy, roles, harness policy) still cascades tenant → platform default.
When something has not been provisioned, the platform now says so by name instead of quietly
serving its own row: see §3.

**Bring your own provider, and declare your own models.** A tenant's `AiProviderConnection` can
now DECLARE which models it serves (`PUT /admin/providers/{service}/{provider}/models`); those
become tenant-owned catalogue rows carrying their provenance. A declaration that would shadow a
platform model slug is refused with a named error rather than silently winning.

**Readiness, at that point in time.** The catalogue and the new
`GET /admin/ai-services/readiness` show whether each engine and cloud provider is answering, with
the timestamp of the observation and a "probe now" refresh. Readiness is advisory at publish and
fail-closed at run time — a model that dies between the probe and the call still fails the call.

**Guardrails: platform-managed, with an accountable opt-out.** Safety screening stays a platform
decision. A tenant may now turn a screening gate OFF for one agent, one workflow or one node —
never ON over a platform switch, and there is no fail-open. Every opt-out is named in a publish
WARNING, recorded per call in the usage ledger, and visible as a skipped step on the run, so
"which tenants ran without a consent gate, and how often" is one query.

**Spend you can attribute.** Every inference path is now metered, including ones that were free
(agent invocations, the realtime lane, the agent and prompt test benches). Ledger rows carry a
`trigger` — `AGENT_INVOCATION | AGENT_TEST | PROMPT_TEST | WORKFLOW_RUN | CONSULTATION` — so a
doubled bill can be attributed to an activity instead of guessed at. **Every seeded allowance is
`null` (unlimited)**, so nothing starts refusing work on upgrade; the rows are the visible change.

## 2. What a developer gets

**`@arcaai/vox-node` (server, zero runtime dependencies)**

- `hope.agents.*` — list, get, invoke (blocking or SSE), synthesize, transcribe. **Selection is a
  `slug`**, never a model, provider or pipeline id.
- `hope.workflows.{run, runAndWait, runAndStream, schema, reviews}` — start a run, follow it,
  read the run-input shape without reading the graph, and answer a human-review gate.
- `signWebhookTrigger` — the outbound half of the webhook pair, for the public
  `POST /hooks/workflows/{hookId}`.
- `hope.admin.*` regenerated: **49 administration areas over 429 routes**, service-account only.

**`@arcaai/vox` (browser) is business-plane only.** Its 25 admin hook families and every
admin-bearing endpoint constant are **gone**, and the client now throws `AdminPlaneRefusedError`
before the network call. Management moved to `hope.admin.*` with a service account, or to the
admin console. Zero first-party consumers imported the removed hooks, and no API-key integration
could ever have reached those routes (`@ForbidApiKey()` on every one).

**One prompt-template grammar.** Six rendering flavours collapsed into one
(`packages/workflow-contract/src/template.ts` plus its hand-written Python mirror), held to a
single committed fixture (`tests/contracts/prompt-template.fixture.json`). `{{a.b.c}}` with one
`default("…")` filter; `{{{{` escapes; a single brace is literal; **exactly one pass**, so a
substituted value can never smuggle a placeholder into the prompt. An unresolved variable is a
**400 naming the path**, on every renderer — the realtime and durable lanes no longer disagree
about the same node.

## 3. Breaking changes

### 3.1 Prompt `variables` is a typed ARRAY, not a map (TASK-890, OD-K)

`{ [name]: { type, required } }` becomes
`[{ name, type, required, default?, description?, source? }]`, `type ∈ string | number | boolean
| date | json`. **There is no read-side normaliser** and the validation pipe rejects the old
shape. Seeds were converted in the same change. *What to do:* send the array form.

### 3.2 Content is no longer read from the platform tier at run time (TASK-890, OD-M)

An unprovisioned tenant used to fall through to the platform row. It now gets a named,
fail-closed **503**:

| Code | Raised when | Remedy |
|---|---|---|
| `AGENT_NOT_ASSIGNED` | no agent is assigned for the task in this tenant | assign one, or re-sync |
| `PROMPT_DEFAULT_NOT_PROVISIONED` | no clone of the platform default prompt the chain falls back to | re-sync |
| `LEGACY_CONTEXT_SCHEMA_MISSING` | no pinned clone of the platform legacy context schema | re-sync |

Re-sync is `POST /admin/tenants/{id}/reference-set/sync`, and it also runs at tenant creation.
**Deliberately 503, not 404** — the agent is not missing; the tenant's opinion about which agent
serves the task is.

*Operator note:* every tenant on the dev and test databases was backfilled and verified before
the switch was flipped (proof #9 — every tenant carries every kind, zero zeros). **Run the sync
for every tenant in any other environment before deploying this train.**

### 3.3 `includeTemplates` on `GET /admin/agents` is removed

Removed, not deprecated. Nest ignores an undeclared query key, so a caller still sending it gets
exactly what it got while the parameter was accepted-and-ignored — the tenant's own copies, each
stamped `sourceTenantId = SYSTEM`.

### 3.4 The browser SDK's admin surface is gone

See §2. This is a MAJOR for `@arcaai/vox` and is already recorded in that package's changelog.

### 3.5 Carried forward from the `ALL-3.0.0` draft

If R1 absorbs `ALL-3.0.0` (see the header), its four breaking changes come with it: the admin
plane is JWT-only, business-plane URIs are normalized (the `308` shims expire), downstream
failure answers `503`/`502` instead of `400`, and service accounts arrive as a third credential
class. Read [`ALL-3.0.0.md`](./ALL-3.0.0.md) as part of this note until that is decided.

## 4. Removals that land with this release

The [deprecation register](../deprecation-register.md) is authoritative. What is already gone on
`dev-2.2`:

- `AiTaskDefault` (table, service, routes, scope, domain trio) and the whole `models.*` descriptor
  family; `AiRuntimeProfile`; `TenantTtsConfig`; `PipelinePolicy` / `PipelinePolicyChange`;
  `ProviderReconciliationRun`; `HarnessPolicy.textProvider` / `textModel`.
- `AiModel.downloadStatus`, `downloadedAt`, `fileSizeMb` and free-text `localPath`, plus the
  `AiModelDownloadStatus` enum type — `localPath` is now DERIVED from `bucketPrefix`.
- The per-tenant clone of the model catalogue and the Global-tenant settings clone.
- Dozens of configuration descriptors across `tts.*`, `stt.*`, `models.*`, `pipeline.*`,
  `nlp.logging.*` and the frontend/entitlement columns behind them (wave 3a — the register's
  "Removed outright in wave 3a" table is the itemised list).
- From TASK-890 specifically, removed outright with **no** register row (OD-K):
  `PromptVersion.syntax` and every single-brace shim, the flat prompt-variable form,
  `workflowPublishProblems`, `provisionTenantModelCatalog`, `provisionTenantConfigs`, and the
  browser SDK's admin hooks.

Still deprecated with a window (**R4**): `AsrPipeline` / `AsrPipelineVersion` and
`TranscriptionJob.pipelineId`, `TenantSttConfig`, the `stt` / `summarization` / `consultation` /
`agentic` node palettes, the four browser client-AI packages, and the console redirect stubs.
**Executing the register is TASK-901**, not this release.

## 5. Migrations

**28 migrations are in the ledger since `ALL-3.0.0`** (`packages/database/src/prisma/db_main/migrations/`),
14 of them in the consolidation program itself:

```
20260901051803_task_843_ai_task_taxonomy
20260901061912_task_844_ai_routing_policy_absorption
20260902090000_task_855_ai_model_source_uri_fix
20260903120000_task_858_reown_system_catchall_soap
20260903203353_task_862_provider_consolidation
20260904090000_task_860_model_registry
20260904120000_task_863_agent
20260904120000_task_864_workflow_v2
20260904150000_task_861_transcription_job_agent_version
20260905192057_task_870_wave3a_schema_retirement
20260905202432_task_888_tenant_tts_config_retirement
20260905213331_task_886_tenant_guardrail_policy
20260905214307_task_884_agent_provenance_and_assignment_selector
20260906101622_task_890_context_schema_byo_model_provenance
```

The last one is TASK-890's only schema change: the `wireModelId` data step, the context-schema pin
on `Agent`, `AiModel.sourceConnectionId` + its `Restrict` FK, the provenance pair on
`PromptTemplate` / `WorkflowDefinition`, the four dropped `AiModel` download columns and
`DROP TYPE AiModelDownloadStatus`. **Applied to dev and test; `prisma migrate diff` printed the
empty migration.** Production applies through the k3s `db-migrate` PreSync Job
(`pnpm db:migrate:deploy`), unchanged.

## 6. Upgrade checklist

1. **Re-sync every tenant's reference set** (`POST /admin/tenants/{id}/reference-set/sync`) before
   traffic reaches the new build — §3.2 is the one change that turns a silent fallback into a 503.
2. Convert any client that posts prompt `variables` to the typed array form (§3.1).
3. Move anything that used `@arcaai/vox`'s admin hooks onto `@arcaai/vox-node`'s `hope.admin.*`
   with a service account, or onto the console (§3.4).
4. Expect ledger rows on paths that were previously free. Check the plan ceilings you intend to
   set BEFORE you set one — every seeded allowance is currently `null`.
5. If `ALL-3.0.0` never shipped separately, run its checklist too (retired URIs, 503/502 error
   handling, bootstrap admin env vars, rotate the seeded service-account secret).

## 7. Owner questions still open

None blocks the release; each carries a recommendation already written down.

| # | Question | Where |
|---|---|---|
| OD-2 | **Name the removal-release tags** (`R1`..`R4`), and decide whether R1 absorbs the untagged `ALL-3.0.0` | TASK-859 §5; the register's header |
| Q-1 / Q-6 | Mandatory node **presence** is advisory at publish — deleting a mandatory clinical guard node publishes 200 with the ERROR merely recorded. Promote the consultation rule set out of DRAFT, or make presence a blocking publish code (TASK-904) | TASK-890 §6.4 |
| Q-2 | `svc:admin:agent:manage` is missing from the seeded service account, so that credential class is unproven for all 21 `admin/agents` routes (TASK-907) | TASK-890 §6.4 |
| Q-3 | `PATCH admin/tenants/configs/:key` addresses a SYSTEM row by a key that is not tenant-qualified (privilege hole closed; addressing still ambiguous) | TASK-890 §6.4 |
| Q-4 | A reserved-tenant entitlement override succeeds and does nothing — refuse it with a named 409 instead | TASK-890 §6.4 |
| Q-5 | `wireModelId` has no Postgres CHECK; a direct SQL insert can leave a cloud row unroutable (TASK-899) | TASK-890 §6.4 |
| Q-7 | Azure `deploymentName` is optional on a BYO model declaration, so a declared model can be unroutable at run time | TASK-890 §6.4 |
| Q-8 | No self-scoped department prompt-config READ exists; the SDK's dead read was removed (TASK-908) | TASK-890 §6.4 |
| Q-9 | Two platform workflow templates can never be provisioned — they pin platform-owned catalogue rows, so the clone is correctly refused and every tenant is provisioned without them (TASK-909) | TASK-890 §6.4 |

## 8. Known gaps carried into this release

- **`usable` in the model catalogue follows bucket inventory, not runtime reachability.** A model
  whose weights resolve from a local HF cache rather than the platform bucket is reported
  unusable. Under investigation with the readiness sweep.
- **Six harness replay tests fail** (`task-355`) and are pre-existing by construction.
- **Four admin-console e2e specs and two Studio a11y findings are stale/known** (TASK-911,
  TASK-912); they predate this work and need a live stack to run.
- The `publish-sdk` CI job still calls Changesets, which is not initialized — SDK versions remain
  hand-maintained (carried from `ALL-3.0.0`).
