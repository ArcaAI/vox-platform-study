# Release note — `ALL-2.2.0`

| | | | |
|---|---|---|---|
| **Train** | `ALL-2.2.0` (platform-wide) | **Tagged** | 2026-09-11 (`f4f88f1d6`) |
| **Previous** | `ALL-2.1.0` (2026-08-14, `81195848d`) | **Span** | 1,257 first-parent commits · 40 migrations |
| **Status** | Tagged. Release note pending publication in the admin console. | **SDK family** | `@arcaai/*` 3.1.0 → 3.2.0 (own tags: `SDK-3.1.0`, `SDK-3.2.0`) |

> **How to use this file.** Per [versioning.md](../versioning.md) §3, CI creates a DRAFT
> `ChangelogEntry` on an `ALL-` tag, pre-filled from `feat` + breaking-change commits, and a
> super admin edits it into plain language before publishing. **This file is the source text
> for that edit** — written for the person doing it, not for the machine. The tag is the
> version; nothing here derives from a `package.json`.

> **This note absorbs two earlier drafts.** `ALL-3.0.0.md` (drafted 2026-08-18) and
> `ALL-4.0.0.md` (drafted 2026-09-07, "working name only") were both written against trains
> that were never tagged, while the train that *was* tagged had no note at all. Their content
> is merged here under the real tag, and both files are now superseded stubs. This retires the
> `R1`/`ALL-4.0.0` placeholder naming that TASK-859 OD-2 left open **for the removals that have
> already landed**; `R2`–`R4` are still unnamed.

**Scope.** Everything between `ALL-2.1.0` and `ALL-2.2.0`: the API-plane hardening group
(TASK-754…768), the AI platform consolidation program (TASK-859…865), wave 3a's configuration
retirement (TASK-879…883, 887, 888), the settings-registry governance pass (TASK-870), the
agent / prompt / context journeys (TASK-890), the workflow studio redesign (TASK-893), and the
agent-platform and clinical-loop work that followed (TASK-930…951).

---

## 1. What a tenant gets

**One place to build what the AI does, and it is theirs.** A tenant admin builds and publishes
**Agents** (an instruction, a model, parameters, tools, a pinned context schema) and
**Workflows**, tests a DRAFT agent on a bench before publishing it, and picks a model from a
catalogue that shows what is usable right now rather than everything the platform knows about.

**Your content is your own copy, not a shared platform row.** Agents, agent assignments,
prompts, workflows and context schemas are **cloned into the tenant at creation** and can be
edited — which was never possible while the row was shared. Configuration (models, provider
connections, routing policy, roles, harness policy) still cascades tenant → platform default.
When something has not been provisioned the platform now says so by name instead of quietly
serving its own row — see §3.2.

**Bring your own provider, and declare your own models.** A tenant's `AiProviderConnection` can
DECLARE which models it serves (`PUT /admin/providers/{service}/{provider}/models`); those become
tenant-owned catalogue rows carrying their provenance. A declaration that would shadow a platform
model slug is refused with a named error rather than silently winning.

**Readiness, at that point in time.** The catalogue and `GET /admin/ai-services/readiness` show
whether each engine and cloud provider is answering, with the timestamp of the observation and a
"probe now" refresh. Readiness is advisory at publish and fail-closed at run time — a model that
dies between the probe and the call still fails the call.

**Guardrails: platform-managed, with an accountable opt-out.** Safety screening stays a platform
decision. A tenant may turn a screening gate OFF for one agent, one workflow or one node — never
ON over a platform switch, and there is no fail-open. Every opt-out is named in a publish WARNING,
recorded per call in the usage ledger, and visible as a skipped step on the run, so "which tenants
ran without a consent gate, and how often" is one query.

**Spend you can attribute.** Every inference path is metered, including ones that were free
(agent invocations, the realtime lane, the agent and prompt test benches). Ledger rows carry a
`trigger` — `AGENT_INVOCATION | AGENT_TEST | PROMPT_TEST | WORKFLOW_RUN | CONSULTATION` — so a
doubled bill is attributed to an activity rather than guessed at. **Every seeded allowance is
`null` (unlimited)**, so nothing starts refusing work on upgrade; the rows are the visible change.

**The clinical loop, end to end.** A consultation walks `OPEN → PRIMED → RECORDING → DRAINING →
PENDING_REVIEW → SIGNED` with live transcription, PII and medical entity extraction, an
incremental pre-summary, key-point extraction and a human review decision. Three changes a
clinician will actually feel:

- **A partial-summary turn now ADDS to the note instead of rewriting it**, so a work note typed
  mid-consultation survives the next turn.
- **Finalize applies the clinician's own DNA writing style.**
- **Clinical vocabulary recall** — a lexicon stage on the streaming worker, added after a live
  trial in which "ceftriaxone" was consistently missed. Decode geometry is now a measured,
  range-validated per-model profile rather than one global guess.

**Twenty-two ArcaAI department note shapes**, a core-palette workflow library, and a General
Medicine consultation summary template ship with the seed.

## 2. What a developer gets

**`@arcaai/vox-node` (server, zero runtime dependencies)**

- `hope.agents.*` — list, get, invoke (blocking or SSE), synthesize, transcribe. **Selection is a
  `slug`**, never a model, provider or pipeline id. `NAMED_ENTITY_RECOGNITION` is an agent task.
- `hope.workflows.{run, runAndWait, runAndStream, schema, reviews}` — start a run, follow it, read
  the run-input shape without reading the graph, and answer a human-review gate.
  `transport: 'socket'` is available; **SSE stays the default because it is the only lane that
  resumes.**
- `hope.consultations.*` + `hope.stt.*` + `RealtimeSttSocket` — a machine identity can drive a
  consultation end to end from a server (SDK 3.2.0 / TASK-933). `open()` takes a REQUIRED
  `clinicianUserId` for a service-account caller: a machine is never recorded as the clinician.
- `signWebhookTrigger` — the outbound half of the pair for `POST /hooks/workflows/{hookId}`.
- `hope.admin.*` regenerated: **49 administration areas over 423 routes**, service-account only.

**`@arcaai/vox` (browser) is business-plane only.** Its 25 admin hook families and every
admin-bearing endpoint constant are **gone**, and the client throws `AdminPlaneRefusedError`
before the network call. Management moved to `hope.admin.*` with a service account, or to the
admin console.

**The browser never runs a model.** VAD, denoise, diarization, ASR and NER are server-side
decisions made by the tenant's published Agents. Selection is `agentSlug`, never a pipeline or
engine id; `pipelineId` is deprecated and removed in R4.

**One prompt-template grammar.** Six rendering flavours collapsed into one, held to a single
committed fixture. `{{a.b.c}}` with one `default("…")` filter; `{{{{` escapes; **exactly one
pass**, so a substituted value can never smuggle a placeholder into the prompt. An unresolved
variable is a **400 naming the path**, on every renderer.

## 3. Breaking changes

### 3.1 The admin plane no longer accepts API keys

`/api/v1/admin/*` is **JWT or service-account only**. 65 controllers / 386 handlers previously
accepted a tenant API key carrying an `admin:*` scope; they now return **403** to any key,
including one holding `'*'`. All 56 `admin:*` scopes and the 3 `webhook:*` scopes are **reserved**,
not deleted — they remain the vocabulary the service-account credential uses.

*What to do:* move admin automation to a **service account**. There is no supported API-key path
to administration. The admin console is unaffected — it has always used a session JWT through its
BFF proxy.

### 3.2 Content is no longer read from the platform tier at run time

An unprovisioned tenant used to fall through to the platform row. It now gets a named,
fail-closed **503**:

| Code | Raised when | Remedy |
|---|---|---|
| `AGENT_NOT_ASSIGNED` | no agent assigned for the task in this tenant | assign one, or re-sync |
| `PROMPT_DEFAULT_NOT_PROVISIONED` | no clone of the platform default prompt | re-sync |
| `LEGACY_CONTEXT_SCHEMA_MISSING` | no pinned clone of the platform legacy context schema | re-sync |

Re-sync is `POST /admin/tenants/{id}/reference-set/sync`, and it also runs at tenant creation.
**Deliberately 503, not 404** — the agent is not missing; the tenant's opinion about which agent
serves the task is.

> **Operator note.** Dev and test were backfilled and verified before the switch was flipped.
> **Run the sync for every tenant in any other environment before deploying this train.**

### 3.3 Business-plane URIs are normalized

Every retired path answered **308** with a `Location` header for one release and is now a 404.
308 specifically: a 301/302 would let a client rewrite POST→GET and drop the body.

| Retired | New |
|---|---|
| `user/me/{preferences,settings,departments}` | `users/me/{…}` |
| `tenant`, `tenant/me/config` | `tenants/me`, `tenants/me/config` |
| `tenant/me/context-schema` | `tenants/me/context-schema` |
| `billing/me/{invoices,spend}` | `tenants/me/{invoices,spend}` |
| `usage/me/{summary,burndown}` | `tenants/me/usage-{summary,burndown}` |
| `entitlements/me` | `tenants/me/entitlements` |
| `voice-profile` | `voice-profiles` |
| `rbac/check{,/bulk,/my-permissions}` | `users/me/permission-checks`, `users/:id/permission-checks` |
| `ai/guardrail/analyze` | `safety-checks` |
| `ai/nlp/*` | `text-analyses/*` |
| `text/*` | `text-generations/*` |

**The two-alias split is the part to tell integrators.** `/users/me/**` is USER-scoped and
`/tenants/me/**` is TENANT-scoped. Under an API key, `users/me` resolves to the key's **bound
user** and `tenants/me` to the key's **tenant**. Folding both under one alias would have stated
something false about ownership. `speech/*` and the frozen v1 compat surfaces are untouched.

### 3.4 Downstream-unreachable now answers 503, not 400

| Cause | Was | Now |
|---|---|---|
| Transport failure (`ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, `ECONNRESET`, DNS) | 400 / opaque 500 | **503** + `Retry-After` |
| Upstream returned 5xx | 400 / opaque 500 | **502** (deliberately no `Retry-After`) |

The split lets alerting separate "dependency down" from "dependency erroring" on status alone.
**No client-facing error body contains a host, port, IP, internal service name or stack any
more** — the operator still gets all of it in the log, keyed by the `correlationId` the client
already receives.

*What to do:* treat 503 as retryable with backoff and 502 as not. A 400 now means what it says.

### 3.5 Prompt `variables` is a typed ARRAY, not a map

`{ [name]: { type, required } }` becomes
`[{ name, type, required, default?, description?, source? }]`, `type ∈ string | number | boolean |
date | json`. **There is no read-side normaliser** and the validation pipe rejects the old shape.
Seeds were converted in the same change. *What to do:* send the array form.

### 3.6 Smaller removals that change a response

- **`includeTemplates` on `GET /admin/agents` is removed**, not deprecated. Nest ignores an
  undeclared query key, so a caller still sending it gets exactly what it got while the parameter
  was accepted-and-ignored — the tenant's own copies, each stamped `sourceTenantId = SYSTEM`.
- **The browser SDK's admin surface is gone** (§2). A MAJOR for `@arcaai/vox`, already recorded in
  that package's changelog.
- **Platform-tier settings reads now answer 403, not 404.** `GET /admin/settings/:id` and
  `GET /admin/settings/tenant/:tenantId` on a SYSTEM-tier row match the write side. The platform
  tier is the one place 404-over-403 does not apply — it has no existence to hide, since its keys
  are declared in the settings registry and rendered by name in the catalog. A row owned by
  another *customer* tenant still answers 404.

## 4. New credential class: service accounts

A third class, separate from user JWTs and tenant API keys.

- **Issued by a SUPER_ADMIN only**, with its own `svc:*` scope namespace and short-lived bearer
  tokens (two-slot rotation, revocation effective within one request).
- **`workingTenantId` binds at EXCHANGE, not per request** — so `X-Tenant-Id` is never sent
  alongside it. This is the one place API-key intuition misleads.
- **Deny-by-default everywhere else.** A route that does not declare `@RequiredSvcScopes` refuses
  a service account, so nothing is reachable by accident.
- **It now reaches the realtime consultation plane** (TASK-933), reversing the earlier limit that
  said a service account could create a stream session but not drive it. `hope.admin.*` remains
  service-account-only and an API key can never reach `/admin/*`.

## 5. Security fixes

- **Same-tenant live-session hijack (`/ws/stt/stream`)** — any authenticated user in a tenant who
  learned another user's `sessionId` could mint a ticket and have the live audio and transcript
  transplanted onto their socket, orphaning the clinician silently. Stream bindings now carry an
  owner; a rebind whose ticket user is not the incumbent is refused.
- **API-key minting had no privilege ceiling** — a tenant admin could mint a key carrying
  `admin:*` or `'*'`. Minting now refuses any scope whose implied ability the caller does not
  itself hold.
- **CSWSH on the TTS gateway** — `/ws/tts/stream` had no `Origin` check at all. It now has the
  same fail-closed check as the STT gateway. Browsers exempt WebSockets from CORS entirely, so
  this is the one surface the HTTP CORS gate cannot cover.
- **Dependency modernization and security patch** (TASK-936), including the Next.js August 2026
  security release — the console is at **16.3.4 or above**, which closes an unauthenticated RCE in
  the Image Optimization API (GHSA-2xp9-vwfh-vxw4, CVSS 9.5).

## 6. Operational

**A fresh deploy can now be logged into.** `RUN_SEED="safe"` produced **zero users** and there is
no registration route — a fresh deploy had no way in. Two env-driven, create-only bootstrap phases
provision the first platform super-admin and the first tenant admin. Both no-op when unset,
hard-error when half-set, refuse well-known passwords, and never log the password.

A tenant-bound **service account is seeded for the ArcaAI tenant**. Its authority reconciles on
re-seed; its credential never does, so a rotated secret survives. Outside dev/test the seeded
verifier is inert by construction — 32 random bytes for which no preimage was ever generated — and
is replaced by one `rotate` call.

**Platform-wide feature availability.** A handful of console screens are gated by a
tenant → SYSTEM `Feature Availability` setting edited on `/features`, failing closed (absent,
`false`, loading and error all hide the screen). This is a console visibility decision only — the
backend route stays ability-gated exactly as before.

## 7. Removals

The [deprecation register](../deprecation-register.md) is authoritative. Landed in this train:

- `AiTaskDefault` (table, service, routes, scope, domain trio) and the whole `models.*` descriptor
  family; `AiRuntimeProfile`; `TenantTtsConfig`; `PipelinePolicy` / `PipelinePolicyChange`;
  `ProviderReconciliationRun`; `HarnessPolicy.textProvider` / `textModel`.
- `AiModel.downloadStatus`, `downloadedAt`, `fileSizeMb` and free-text `localPath`, plus the
  `AiModelDownloadStatus` enum type — `localPath` is DERIVED from `bucketPrefix`.
- The per-tenant clone of the model catalogue and the Global-tenant settings clone.
- Dozens of configuration descriptors across `tts.*`, `stt.*`, `models.*`, `pipeline.*` and
  `nlp.logging.*` (wave 3a). The settings registry went 341 → 209 keys.
- `PromptVersion.syntax` and every single-brace shim, the flat prompt-variable form,
  `workflowPublishProblems`, `provisionTenantModelCatalog`, `provisionTenantConfigs`, and the
  browser SDK's admin hooks.

Still deprecated with a window (**R4**): `AsrPipeline` / `AsrPipelineVersion` and
`TranscriptionJob.pipelineId`, `TenantSttConfig`, the `stt` / `summarization` / `consultation` /
`agentic` node palettes, the four browser client-AI packages, and the console redirect stubs.
**Executing the register is TASK-901**, not this release.

## 8. Migrations

**40 migrations** entered the ledger between `ALL-2.1.0` and `ALL-2.2.0`
(`packages/database/src/prisma/db_main/migrations/`). Applied to dev and test;
`prisma migrate diff` printed the empty migration. Production applies through the k3s
`db-migrate` PreSync Job (`pnpm db:migrate:deploy`), unchanged.

The last twelve, which carry the agent/workflow/context work:

```
20260904120000_task_864_workflow_v2
20260904150000_task_861_transcription_job_agent_version
20260905192057_task_870_wave3a_schema_retirement
20260905202432_task_888_tenant_tts_config_retirement
20260905213331_task_886_tenant_guardrail_policy
20260905214307_task_884_agent_provenance_and_assignment_selector
20260906101622_task_890_context_schema_byo_model_provenance
20260907101216_task_891_workflow_assignment_selector
20260907182330_task_930_agent_task_ner
20260909020000_task_932_global_setting_tenant_key_unique
20260910053048_task_941_soft_retire_stale_text_routing_rows
20260911120000_task_950_user_profile_staff_id
```

## 9. Upgrade checklist

1. **Re-sync every tenant's reference set** (`POST /admin/tenants/{id}/reference-set/sync`) before
   traffic reaches the new build — §3.2 turns a silent fallback into a 503.
2. Move any admin automation off API keys onto a **service account** (§3.1, §4), or onto a human
   JWT.
3. Repoint retired business-plane URIs (§3.3) — the `308` shims have expired.
4. Re-test error handling: downstream failure is 503/502, not 400 (§3.4).
5. Convert any client that posts prompt `variables` to the typed array form (§3.5).
6. Move anything that used `@arcaai/vox`'s admin hooks onto `hope.admin.*` or the console (§2).
7. Set `BOOTSTRAP_SUPER_ADMIN_*` and `BOOTSTRAP_TENANT_ADMIN_*` before first boot of a new
   environment, or you will have a configured platform nobody can sign in to.
8. Rotate the seeded service account's secret in any non-dev environment before use.
9. Expect ledger rows on paths that were previously free. Check the plan ceilings you intend to
   set **before** you set one — every seeded allowance is currently `null`.

## 10. Known gaps carried into this release

- **The outbound guardrail screen can reject long clinical output as toxic.** A 945-token clinical
  JSON key-points completion was blocked with `response_toxicity`, a false positive: the SYSTEM
  `TenantGuardrailPolicy` carries no threshold for that check, so the classifier's own default
  decides. Two mitigations exist today — a platform admin tunes or disables `response_toxicity` in
  the SYSTEM policy, and a tenant admin opts the node out — but the threshold is a tuning decision
  nobody has made yet.
- **The `socket` protocol is unreachable with an API key.** `POST /auth/stream-ticket` is
  `@ForbidApiKey()`, so the socket lane a published workflow advertises can only be opened with an
  admin JWT. HTTP, SSE and the webhook plane are unaffected.
- **A realtime STT session is not metered.** Batch transcription writes `AUDIO_SECOND`; the
  streaming lane writes nothing. Agent invocations, workflow runs, consultations and both benches
  are metered.
- **`resultRef` is null on a DEGRADED workflow run**, even when the nodes before the degraded one
  succeeded — the successful payload is visible per node on the run, not through the result.
- **A tenant admin cannot manage its own custom roles.** `Role` and `Policy` have no `tenantId`
  column and CASL conditions run in shadow mode, so the grant cannot be constrained from a seed.
- **Every seeded tenant has `plan = NULL`** — unlimited quotas, but a cloud provider without a
  tenant key returns 403. Local engines are unaffected, so day-1 works.
- **Mandatory node presence is advisory at publish** — deleting a mandatory clinical guard node
  publishes 200 with the ERROR merely recorded (TASK-904).
- **Some tickets in the 930–951 window are still `Review` or `In Progress`** at the tag
  (TASK-930, 933, 938, 939, 943, 946, 948, 949, 950, 951). Their merged code ships; their
  remaining owner checks are tracked in their own READMEs.
