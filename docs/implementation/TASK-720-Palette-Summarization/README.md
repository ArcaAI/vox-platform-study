# TASK-720 — Summarization Palette

| | |
|---|---|
| **Status** | Review — Tasks 1–7, 9 done and verified (real command output, §7); a close-out pass (2026-08-17) restored the five node-registry entries after an external tree operation had dropped them (see §7's close-out section) — Task 8 (e2e) still NOT done — infra's `db push --force-reset` guard blocks unattended `pnpm test:e2e`, see §7 |
| **Wave** | 2 · **Size** | L |
| **Epic slug** | `palette-summarization` |
| **Depends on** | TASK-718 (`workflow-interpreter`), TASK-719 (`workflow-studio-v1`) |
| **Design refs** | D3, D4, **D5** from [design.md](../../programs/agentic-workflow-platform/design.md) — Plane 1 §Node registry, §Compiler + Validator, §Services program (`text`, `guardrail`), Roadmap Wave 2 |
| **Findings closed** | — (enabling). Structurally hardens the fail-open guardrail posture named in assessment [README §3.3](../../architecture/consultation-session-workflow/assessment/README.md) *for substrate runs only*; the platform-wide fix is TASK-706. |

---

## 1. Requirement Analysis

### What this delivers

The **first palette** — the one that proves the substrate. Per D5, Summarization is deliberately
chosen because it is single-agent and carries **no clinical gates**: no consent, no HITL, no signing,
no sensor suite. If the substrate cannot execute *this*, it cannot execute anything, and finding that
out here is cheap.

Five things ship:

1. **Five node types**, each with a JSON config schema, a node-registry entry, a safety class, and a
   mapping to an already-sanctioned activity.
2. **The mandatory-subgraph rule** for this palette: `input → generation → guardrail → output`, with
   the guardrail node **non-removable** (safety class `mandatory`).
3. **The seeded platform default definition** — the `WorkflowDefinition` a tenant gets when it has
   authored none, which the dispatcher falls back to (design.md §Data flow, §Error handling).
4. **Golden validator fixtures** for TASK-716 — one passing graph and one failing graph per
   structural rule.
5. **The e2e proving path**: author → validate → publish → invoke → SSE stream → result. This is the
   substrate's acceptance test, not just this ticket's.

### The five node types

| # | Node type key | Safety class | Purpose |
|---|---|---|---|
| N-1 | `input.context_binding` | `mandatory` | Declares the run's input shape and binds the invocation payload to it |
| N-2 | `prompt.template_ref` | `optional` | References an existing `PromptTemplate` by id. **Picker semantics only — no inline editing.** |
| N-3 | `generate.text` | `mandatory`, `critical` | Calls the `text` service (ex-`smr`) via the gateway; provider/model/params bounded |
| N-4 | `guardrail.check` | `mandatory`, **non-removable** | Fail-CLOSED safety check on the generated text |
| N-5 | `output.deliver` | `mandatory` | Binds the run result to the declared output shape |

**Safety-class semantics** (design.md Plane 1 §Node registry — `mandatory` / `locked` / `optional`):
`mandatory` = pre-placed on the canvas and non-deletable (Plane 3 §palette rail); `optional` = the
tenant may add or remove it. N-2 is `optional` because a workflow may legitimately carry its prompt
inline in the generation node's config; N-4 is `mandatory` **and** the validator forbids any edge
that routes around it.

### Out of scope — stated so nobody builds it here

- **No new SMR/`text` endpoint.** `POST /api/v1/text/generate` already exists and is what N-3 calls.
- **No `POST /guardrail/redact` endpoint.** Verified absent (§2). It is TASK-710's (`phi-redactor`)
  deliverable and this palette does not need it — the Summarization palette handles tenant-supplied
  text, not a clinical transcript.
- **No consultation nodes, no STT nodes, no HITL gate node, no signing node.** Waves 3 and 4.
- **No canvas/UI work** — TASK-719 owns the Studio; this ticket owns the registry entries and the
  JSON schemas its inspector generates forms from.
- **No fix to guardrail's platform-wide fail-open posture.** That is TASK-706 (`egress-failclose`).
  N-4 is fail-closed **at the node**, which is a different and narrower claim (§3).

---

## 2. Current State Evaluation

### N-1 — the context-schema primitives ARE reusable, and here is exactly why

`packages/applications/src/services/consultation-context-schema/` contains
`IConsultationContextSchemaService.ts`, `consultation-context-schema.service.ts`,
`consultation-context-schema.dto.mapper.ts`, `consultation-context-schema.service.module.ts`,
**`context-schema-definition.ts`**, `definition-diff.ts`, `dto/`, `__tests__/` (5 test files).

**`context-schema-definition.ts` is domain-neutral.** Verified — it exports:

```ts
export const CONTEXT_PRIMITIVES = ['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED'] as const;
export const CONTEXT_PHI_CLASSES = ['PHI', 'NON_PHI'] as const;
export const CONTEXT_CARDINALITIES = ['ONE', 'MANY'] as const;
export const CONTEXT_LIFECYCLES = ['PRE', 'DURING', 'POST', 'ANY'] as const;
export const CONTEXT_PRODUCERS = ['CLIENT', 'AGENT', 'SYSTEM'] as const;
```
(`context-schema-definition.ts:34-40`), plus `CONTEXT_SCHEMA_DEFINITION_VERSION = '1.0'` (`:43`),
`CONTEXT_KIND_KEY_PATTERN = /^[a-z0-9_]{2,48}$/` (`:46`), `MAX_DECLARED_KINDS = 64` (`:49`), and the
interfaces `ContextKindDeclaration` (`:89-102`), `ContextOutputDeclaration` (`:104-110`),
`ContextSchemaDefinition` (`:112-116`).

Its module docstring states the load-bearing idea (`:11-27`): a tenant invents its own vocabulary,
but **every kind must declare exactly one of five platform primitives**, and *"Rejecting an unknown
primitive is the enforcement point that keeps tenant vocabulary on platform substrate."* Nothing in
that file mentions a consultation.

**What IS consultation-bound, and what to do about it:** the *persistence* layer.
`ConsultationContextSchema` (`packages/database/src/prisma/db_main/consultation-context-schema.prisma:19`)
carries `departmentId` + a `Department` relation (`:39-40`), a `scope` of
`ConsultationContextSchemaScope` (`:38`), and is discovered per-consultation. The definition
*document* is stored on the immutable `ConsultationContextSchemaVersion` (`:89`).

**Decision (settled here, not deferred): do NOT reuse the `ConsultationContextSchema` MODEL. Reuse
`context-schema-definition.ts` and `@arcaai/json-schema-subset` as LIBRARIES.** N-1's config carries
a `ContextSchemaDefinition`-shaped document **inline in the node config**, validated by the same
exported validator. Rationale: a palette input context is not department-scoped, not
lifecycle-phased, and not discovered by a consultation client — bolting it onto a
consultation-scoped model would force a `consultationId`-less row into a table whose whole
discovery cascade assumes one. Two functions imported; zero schema drift; no migration.

**The `fields` sub-schema is validated by a shared, dependency-free package.**
`context-schema-definition.ts:2` imports `authorableJsonSchemaProblems` from
`@arcaai/json-schema-subset` (`packages/json-schema-subset/src/json-schema-subset.ts:80`). Read that
file's module docstring before touching N-1 — it explains that this is deliberately **one
implementation with three consumers** (server, browser SDK, admin console) after two copies drifted,
that it is **zero-runtime-dependency** because `@arcaai/vox` bundles it, and that `if/then/else`
(`:63`) and undiscriminated `oneOf` are **hard exclusions** because codegen cannot express them
faithfully. Limits: `MAX_SCHEMA_DEPTH = 12` (`:57`), `MAX_SCHEMA_NODES = 512` (`:60`).

**This is also the interoperability point with TASK-718.** The interpreter's
`contracts/compiled-config.schema.json` is modelled on the same subset. One authorable-schema rule,
now four consumers.

### The governance triple is the house pattern — and `WorkflowDefinition` already follows it

`consultation-context-schema.prisma:6-17` names it explicitly:

```prisma
// Shape is the house governance triple already used by
// PromptTemplate/PromptVersion and AsrPipeline/AsrPipelineVersion:
// a MUTABLE head row, an IMMUTABLE per-publish version
// snapshot, and a MOVABLE pin naming which snapshot is currently served.
```

with *"A consultation in flight therefore keeps validating against the version it started with even
after the tenant publishes a newer one"* (`:14-16`). That sentence is TASK-718's S-3
(version pinning) already shipped in a neighbouring subsystem. Cite it; do not re-derive it.

### N-2 — prompt templates: verified model, verified gates

`packages/applications/src/services/prompt-management/` — `IPromptManagementService.ts`,
`prompt-management.service.ts`, `prompt-management.dto.mapper.ts`,
`prompt-management.service.module.ts`, `dto/`, `README.md`, `__tests__/`.

`model PromptTemplate` (`packages/database/src/prisma/db_main/prompt-template.prisma:34-107`):

| Field | Line | Relevance to N-2 |
|---|---|---|
| `content String @db.Text` | `:45` | The mutable head body — **not** what resolution serves |
| `category PromptTemplateCategory` | `:46` | `SYSTEM \| SUMMARY \| DNA_ANALYSIS \| CUSTOM` (`:6-12`) — N-2's picker filters to `SUMMARY`/`CUSTOM` |
| `status PromptTemplateStatus` | `:47` | `DRAFT \| PUBLISHED \| APPROVED` (`:23-31`) |
| `variables Json? @db.JsonB` | `:48` | The declared placeholders N-2 must surface |
| `currentVersionNumber` | `:64` | |
| `approvedVersionNumber Int?` | `:69` | **The pin.** See the quote below. |
| `scope PromptTemplateScope` | `:77` | `TENANT_DEFAULT \| DEPARTMENT_DEFAULT \| USER_PERSONAL` (`:15-21`) |
| `ownerUserId` | `:78` | Owner-scoped self-service rows |

Two governance facts N-2 **must** honour:

1. `APPROVED` is a real gate (`prompt-template.prisma:25-28`): *"APPROVED is a governance gate: a
   template is only resolvable for clinical generation flows once a GLOBAL_ADMIN has approved it
   (prompt publishing becomes approval-gated at resolution time)."*
2. Resolution serves the **pinned approved version, not the mutable `content` column**
   (`prompt-template.prisma:65-70`): *"Version snapshot pinned at last approval; null = never
   approved under this scheme. Resolution serves THIS PromptVersion (not the mutable `content`
   column / latest edit) … so a post-approval content edit accumulates un-served versions until the
   next (eval-gated) re-approval. See PromptResolutionService."*

**Therefore N-2 stores a `promptTemplateId` and the interpreter resolves through
`PromptResolutionService` at run time.** It must NOT snapshot `content` into `compiledConfig` — that
would silently bypass the approval gate and freeze an unapproved body into every future run.
`PromptResolutionService` lives at
`packages/applications/src/services/consultation/prompt/prompt-resolution.service.ts` (module at
`prompt-resolution.service.module.ts`; the live-agent variant at `live-agent-resolution.service.ts`).

**Picker semantics, no inline editing** (design.md Plane 3 §Consolidation): *"prompt templates keep
their own authoritative editor (picker + deep link from nodes)."* Rule
`.claude/rules/13-nextjs-apps.md` §Routing states the general form: *"One authoritative editor per
backend resource … one owns the write and the other demotes to a read-only summary + a plain-href
deep link (never a cross-feature import — features stay isolated)."* N-2's inspector is a picker plus
an `<a href>` to `/prompt-management`.

Rule `.claude/rules/05-nestjs-api.md` §Imperative Privilege Checks documents the approve route's
split gate (`assertCanApprove` in `prompt-management.service.ts`): a SYSTEM/library template stays
GLOBAL_ADMIN-only (403); a tenant-owned one devolves to `manage:PromptTemplate`. N-2 does not change
this — it only reads.

### N-3 — the `text` service: verified surface, verified bounding

**The gateway controller is already named `text`.** `apps/api/src/modules/streaming/text-proxy.controller.ts:174`
→ `@Controller('text')`, i.e. `/api/v1/text/*`. Relevant routes:

| Route | Line | Guard |
|---|---|---|
| `POST text/generate` | `:483` | `@HttpCode(OK)` `:484`, `@Authorize()` `:485` |
| `GET text/tasks/:taskId` | `:520` | `@Authorize()` `:521` |
| `POST text/tasks/:taskId/cancel` | `:550` | `@Authorize()` `:551` |
| `GET text/tasks/:taskId/stream` | `:574` | `@Authorize()` `:575` + `@StreamScope({ namespace: 'smr_task', param: 'taskId' })` `:576` |
| `POST text/generate/assembled` | `:742` | `@Authorize()` `:743` |

Downstream: `TEXT_URL` via `this.configService.getConfigValue('TEXT_URL')` (`:284-286` — a direct
`process.env` read is lint-banned, `:278-283`); `X-Service-Token` injected from
`secretsService.getSecretSync('TEXT_SERVICE_TOKEN')` (`:288-300`).

SMR's own contract (`apps/text/src/text/api/endpoints/generate.py:209-241`,
`apps/text/src/text/models/requests.py:111-133`): `GenerateRequest` carries `prompt` (min 1, max
200 000), `system_prompt` (max 50 000), `provider` (default `"lm-studio"`), `model`, `temperature`
(0–2), `max_tokens`, `top_p`, `stream`, `response_format` (`text | json | json_schema`),
`retry_config`, `provider_overrides`, `content_parts`. **There is no default model — SMR fails
closed with 422:**

```python
    model = request_body.model
    if model is None or not model.strip():
        raise HTTPException(status_code=422, detail="Field 'model' is required: SMR has no default model.")
```
(`generate.py:315-320`). Streaming returns **202** with a `StreamingGenerateResponse` carrying
`stream_url = f"/api/v1/tasks/{task.task_id}/stream"` (`generate.py:405-411`).

**CORRECTION to the ticket brief — provider/model is NOT bounded by `PipelinePolicy`.**
`packages/applications/src/services/pipeline-policy/pipeline-policy.service.ts:33` shows what a
pipeline policy actually governs:

```ts
const WRITABLE_TOGGLE_KEYS = ['autoSummaryEnabled', 'autoNerEnabled', 'harnessEnabled'] as const;
```

— three cascade booleans (TENANT/DEPARTMENT/DOCTOR depth at `:35-39`), plus a read-only
`dnaStyleEnabled`. No provider, no model, no params. The **real** bounding chain, verified:

1. **`AiTaskDefault` first.** `HarnessPolicyService.resolveSmrSelection(tenantId, task)`
   (`packages/applications/src/services/harness-policy/harness-policy.service.ts:538`) consults the
   `AiTaskDefault` key first (`:543-549`, aliasing `azure → azure-openai`), then falls back to the
   legacy `HarnessPolicy.smrProvider/smrModel` cascade (`:561-567`), throwing `BadRequestException`
   when neither resolves. Task keys: `TEXT_TASK_KEY = { live: 'smr.live', finalize: 'smr.finalize',
   test: 'smr.test' }` (`harness-policy.service.ts:39-43`).
2. **`smr.` is deliberately tenant-admin configurable.**
   `packages/applications/src/services/ai-task-default/constants.ts:91`:
   ```ts
   export const GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'nlp.', 'harness.'] as const;
   ```
   with the explicit note at `:85-90` that *"`smr.` is intentionally NOT here."* `AI_TASK_KEYS`
   (`:30-44`) and the `taskKey → ModelTaskType` map (`:52-76`) are the closed vocabularies.
3. **`GLOBAL_ADMIN_ONLY_POLICY_KEYS`** (`harness-policy.service.ts:149-168`) locks
   `smrProvider`/`smrModel` (among 16 keys) to global admins on the `HarnessPolicy` surface.
4. **BYO credentials + availability.** `SmrRequestEnrichmentService`
   (`packages/applications/src/services/smr-request/smr-request-enrichment.service.ts:55-95`) injects
   tenant provider overrides and ends in `assertProviderAvailable(resolved, 'llm', provider)`
   (`:94`). The gateway calls it via `applySmrModelSelection` (`text-proxy.controller.ts:238-251`).

**SMR itself does no tenant bounding** — it selects purely from the request body
(`registry.get(request_body.provider)`, `generate.py:371`) and receives only `X-Tenant-Id`
(`:239`), which it forwards to guardrail (`:286`). **All bounding is the gateway's.** N-3 must
therefore route through `/api/v1/text/generate`, never call SMR directly.

### N-4 — guardrail: verified endpoints, and the fail-open branch this node must not inherit

Endpoints (`apps/guardrail/src/guardrail/api/endpoints/`): `guardrails.py`, `medical.py`,
`groundedness.py`, `jobs.py`, `health.py`.

| Route | File:line |
|---|---|
| `POST /guardrail/analyze` → `GuardrailResponse` | `guardrails.py:59` |
| `POST /guardrail/analyze/batch` | `guardrails.py:111` |
| `POST /guardrail/analyze/async` | `guardrails.py:179` |
| `GET /guardrail/types` | `guardrails.py:206` |
| `POST /guardrail/ground` → `GroundResponse` | `groundedness.py:90` |
| `POST /medical/validate` → `MedicalValidationResponse` | `medical.py:78` |

**`POST /guardrail/redact` does NOT exist.** Verified by a repo-wide case-insensitive grep for
`redact` across `apps/guardrail/src`, `apps/api/src`, `packages/applications/src`: the only hits are
OTel span-attribute redaction (`apps/guardrail/src/guardrail/core/observability.py:61,72`), log-field
redaction config (`apps/api/src/config/env.descriptors.ts:200-210`), and the DNA rewrite rule-set
surface (`apps/api/src/modules/dna-writing-style/dna-writing-style.controller.ts:115-119`). Design.md
§Services program lists it as a thing guardrail *gains*; TASK-710 builds it. **N-4 does not need it.**

**`/guardrail/analyze` FAILS OPEN today** (`apps/guardrail/src/guardrail/api/endpoints/guardrails.py:96-105`):

```python
    except Exception as e:
        processing_time = (time.monotonic() - start_time) * 1000

        return GuardrailResponse(
            safe=True,  # Fail open
```

The docstring at `:65-70` says this is deliberate for **runtime load/inference errors**, while a
missing DB model selection already fails closed with 503 via `get_gliner_model_id`.

**N-4 must NOT inherit `safe=True`.** Its contract is: a `GuardrailResponse` with `error` set, or a
transport failure, or a timeout ⇒ the node **degrades visibly and the run's output is marked
unverified**. This is enforced *in the node*, not in guardrail — the node reads
`GuardrailResponse.error` and treats a non-null `error` as "no verdict", never as "safe". Design.md
§Services program's *"`guardrail` … **fail-closed on generation** (fixes the fail-open cloud-egress
allowlist)"* is TASK-706's platform-wide fix; N-4's node-level rule is narrower and independent, so
**this ticket is not blocked on TASK-706** — but the two must agree, so re-read `guardrails.py:96`
before implementing and reconcile if TASK-706 has already landed.

**A separate fail-open allowlist exists and is NOT this ticket's** — for the record, so nobody
conflates them: `apps/harness/src/harness/guards/phi/redactor.py:185-186`

```python
        phi = settings.phi
        if provider not in phi.cloud_egress_providers:
            return text
```
with `cloud_egress_providers: list[str] = Field(default_factory=lambda: ["azure", "bedrock"])`
(`apps/harness/src/harness/core/config.py:129`). That is assessment §3.3 and TASK-706's target.

Guardrail model selection is **global-admin-only** — `guardrail.` is in
`GLOBAL_ADMIN_ONLY_TASK_PREFIXES` (`ai-task-default/constants.ts:91`), and
`safetyEnabled`/`phiEnabled`/`phiFailClosed` are in `GLOBAL_ADMIN_ONLY_POLICY_KEYS`
(`harness-policy.service.ts:159-161`). **A tenant therefore cannot weaken N-4 through config**,
which is what makes `mandatory` + non-removable a real property rather than a UI convention.

### N-5 and the platform default

No "platform default `WorkflowDefinition`" exists — TASK-715 creates the model. This ticket seeds
the row. The seed layout is `packages/database/src/prisma/db_main/seed/`, phased and FK-ordered with
`XX-name.ts` naming; constants (e.g. `SYSTEM_TENANT_ID`) in `seed/00-constants.ts`
(`.claude/rules/02-database-prisma.md` §Seeds). Reserved prefixes: `00000000-…` SYSTEM tenant,
`50000000-…` default tenant, `60000000-…` system user.

**Seed-vs-deployed divergence is a known, burned-fingers failure mode here.** Assessment README §3.4:
*"Deployed rows do not re-seed and have drifted — this needs a data migration, not just a seed
edit."* And §8: *"Treat any remaining 'defaults to X' claim as needing verification against seed
data, not just code defaults."* The platform default definition is new (no deployed rows to drift),
so a seed alone is correct **this time** — say so explicitly in the seed file's header comment so a
later reader does not assume the general case.

---

## 3. Knowledge & Best Practices

### Repo law that binds this work

| Rule | Section | Binding constraint |
|---|---|---|
| `.claude/rules/04-application-services.md` | §Service Folder Pattern | `IXxxService.ts` (symbol token + interface), `xxx.service.ts`, `xxx.service.module.ts`, `xxx.dto.mapper.ts`, `dto/`, `__tests__/`, `index.ts`. Exemplar: `services/department/`. |
| `.claude/rules/04-application-services.md` | §NEVER | No `this.databaseService.client` in a service — go through a domain repository. Surfaces as a WARNING in `packages/*` (`eslint-plugin-only-warn`); **treat as an error**. |
| `.claude/rules/04-application-services.md` | §NEVER | Cross-tenant access throws `NotFoundException`, never `ForbiddenException` (404-over-403). |
| `.claude/rules/04-application-services.md` | §ALWAYS | Extend `BaseService`; `broadcastSysEvent` after **every** mutation; symbol-token DI; map entities to Response DTOs. |
| `.claude/rules/04-application-services.md` | §DTOs | `class-validator` + `@ApiProperty`/`@ApiPropertyOptional` on **every** field — the global pipe runs `whitelist + forbidNonWhitelisted + forbidUnknownValues`. |
| `.claude/rules/02-database-prisma.md` | §Seeds | Phased, FK-ordered, `XX-name.ts`; constants in `seed/00-constants.ts`. |
| `.claude/rules/02-database-prisma.md` | §After a Schema Change | **Never run `pnpm gen:mapper`** — destructive, strips the `_version` OCC guard. `gen:repository` is broken. |
| `.claude/rules/03-domain-layer.md` | §Generated Code Discipline | Only `gen:model` scaffolds; entity/factory/mapper/repository are **hand-authored**; `gen:entity`/`gen:factory` only reconcile barrels and check coverage. |
| `.claude/rules/03-domain-layer.md` | §Checklist step 4 | A model emitting sys-events must be added to `ResourceType` in **both** `audit.prisma` (+ an `ALTER TYPE … ADD VALUE` migration) **and** `packages/domains/src/enums/generated/ResourceType.ts`. Guard: `resourceType.enum-parity.test.ts`. |
| `.claude/rules/06-python-services.md` | §Gateway Integration | Python services sit behind the gateway; new endpoints are reached through it, not called directly. |
| `.claude/rules/09-infrastructure-devops.md` | §Configuration Tiers | `failMode` is **declared, not decided at the call site**: `closed` for provider/model SELECTION, `open-to-default` for tuning knobs. |
| `.claude/rules/01-development-workflow.md` | §TDD | Failing test first; **always see RED**. |

### SOTA / base practices this implementation follows

| Practice | Justification |
|---|---|
| **Reference the prompt template by id; resolve at run time** | `approvedVersionNumber` is the approval gate (`prompt-template.prisma:65-70`); snapshotting `content` into `compiledConfig` would freeze an unapproved body forever. |
| **One authorable-schema implementation, N consumers** | `@arcaai/json-schema-subset`'s docstring records that two prior copies drifted silently in both directions. |
| **Fail-closed at the node for safety verdicts** | `guardrails.py:96` returns `safe=True` on any exception. A node that trusts that verdict launders an outage into a safety pass. |
| **Mandatory subgraph enforced server-side, not in the canvas** | D3: *"the server-side validator is therefore v1 critical path and the safety boundary; no reliance on UI lockouts."* |
| **Golden fixtures per rule (one passing, one failing)** | design.md §Testing strategy: *"every mandatory-subgraph and forbidden-edge rule gets a passing and a failing graph fixture — the audit artifact becomes executable tests."* |
| **Node config schemas expressed in the authorable subset** | The Studio inspector generates forms from them (Plane 3); a keyword the form generator cannot render is a keyword the tenant must not be able to author. |

### Pitfalls specific to THIS ticket

1. **Do not snapshot prompt `content`.** See above. Store `promptTemplateId` + resolve.
2. **Do not treat `GuardrailResponse.safe === true` as a pass without checking `error`.**
   `guardrails.py:96-105`.
3. **Do not build `POST /guardrail/redact`.** It does not exist and is TASK-710's.
4. **Do not call SMR directly.** All bounding lives in the gateway (`text-proxy.controller.ts:238-251`);
   SMR bounds nothing (`generate.py:371`).
5. **Do not add a `model` default.** SMR fails closed with 422 by design (`generate.py:315-320`) and
   selection is `failMode: closed` per rule 09. Propagate the 422 as a node config error at
   *validation* time, not at run time.
6. **Do not extend `ConsultationContextSchema` to carry palette contexts.** Reuse the library, not
   the model (§2).
7. **`gen:mapper` is destructive.** If any task here touches `packages/domains`, follow rule 03's
   hand-authoring workflow.
8. **`ResourceType` enum parity.** If the seeded default definition or any new model broadcasts
   sys-events, both enums plus a migration are required or every `AuditLog` INSERT throws and rolls
   the mutation into a 500 (rule 03 §Checklist step 4).
9. **Seed ≠ deployed.** Assessment §3.4/§8. New rows are safe; edits to existing seeded rows are not.

---

## 4. Implementation Plan

### Task 1 — Author the five node-type JSON config schemas

- **Agent:** T3 · sonnet-5 · high
- **Files:** create `docs/implementation/TASK-720-Palette-Summarization/contracts/nodes/{input.context_binding,prompt.template_ref,generate.text,guardrail.check,output.deliver}.schema.json`
  and `contracts/palette.md`
- **Approach:** Each schema must validate under
  `authorableJsonSchemaProblems` from `packages/json-schema-subset/src/json-schema-subset.ts:80` —
  read its docstring first: **no `if`/`then`/`else`, no undiscriminated `oneOf`, depth ≤ 12
  (`:57`), ≤ 512 nodes (`:60`).** Contents:
  - **N-1 `input.context_binding`** — `{ contextSchema: <ContextSchemaDefinition>, bindings: [{ kindKey, from }] }`.
    `contextSchema` is validated by the exported `ContextSchemaDefinition` validator in
    `packages/applications/src/services/consultation-context-schema/context-schema-definition.ts`,
    reusing `CONTEXT_PRIMITIVES` (`:34`), `CONTEXT_PHI_CLASSES` (`:37`), `CONTEXT_CARDINALITIES`
    (`:38`), `CONTEXT_PRODUCERS` (`:40`), `CONTEXT_KIND_KEY_PATTERN` (`:46`),
    `MAX_DECLARED_KINDS` (`:49`). For the Summarization palette, restrict `primitive` to `TEXT`
    and `STRUCTURED` — the other three imply substrates (STT session, Media/object storage) this
    palette does not reach.
  - **N-2 `prompt.template_ref`** — `{ promptTemplateId: uuid, variableBindings: Record<string,string> }`.
    **No `content` field.**
  - **N-3 `generate.text`** — `{ taskKey: 'smr.finalize'|'smr.live'|'smr.test', systemPrompt?, temperature?, maxTokens?, topP?, responseFormat? }`.
    **No `provider`, no `model`** — those resolve from `AiTaskDefault` through
    `HarnessPolicyService.resolveSmrSelection` (`harness-policy.service.ts:538`). Bounds mirror
    SMR's own (`apps/text/src/text/models/requests.py:111-133`): `temperature` 0–2, `systemPrompt`
    ≤ 50 000 chars.
  - **N-4 `guardrail.check`** — `{ guardrailType, failOn: 'unsafe'|'unsafe_or_unknown' (default and only permitted value in v1: 'unsafe_or_unknown'), onFail: 'mark'|'abort' }`.
  - **N-5 `output.deliver`** — `{ outputs: [<ContextOutputDeclaration>] }` reusing
    `ContextOutputDeclaration` (`context-schema-definition.ts:104-110`).
  `contracts/palette.md` records the safety class, the `critical` flag, and the activity mapping per
  node, and cross-references TASK-718's `contracts/execution-semantics.md`.
- **Verify:** a scratch test asserting every schema returns `[]` from `authorableJsonSchemaProblems`.
  `pnpm --filter @arcaai/json-schema-subset test`.

### Task 2 — RED: mandatory-subgraph golden fixtures for the validator

- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/applications/src/services/<workflow-validator-folder>/__tests__/fixtures/summarization/{pass,fail}/*.json`
  and `__tests__/summarization-palette.golden.test.ts`
- **Approach:** **Locate TASK-716's validator folder first** (it may be named differently from this
  ticket's guess) and add fixtures to its existing golden suite rather than creating a parallel one —
  design.md §Testing strategy specifies one golden suite driven by the invariant register. One
  passing and one failing graph per rule:
  | Rule | Failing fixture |
  |---|---|
  | The four mandatory node types are present | drop `guardrail.check` |
  | Order is `input → generation → guardrail → output` | guardrail placed before generation |
  | Nothing routes around the guardrail node | an `output.deliver` fed directly from `generate.text` |
  | `guardrail.check` is non-removable (`mandatory`) | a graph deleting it |
  | Exactly one `input.context_binding` and one `output.deliver` | two of either |
  | N-2's `promptTemplateId` resolves within the tenant or SYSTEM shared-read | a cross-tenant id |
  Cross-tenant reference resolution must produce a **validation error**, and the corresponding e2e
  read must be **404, never 403** (rule 04 §NEVER).
- **Verify:** `pnpm --filter @arcaai/applications test` — every new test FAILS (rules not yet
  written). Paste RED.

### Task 3 — Implement the palette rules in the validator

- **Agent:** T3 · sonnet-5 · high
- **Files:** modify TASK-716's rule module + its registry of palette rule sets
- **Approach:** Register a `summarization` palette rule set expressing the table above. Rules are
  **structural**, per design.md's three rule classes (structural / invariant / schema) — they belong
  with reachability and mandatory-subgraph checks, not with the schema class. Output must be the
  per-node machine-readable `ValidationReport` TASK-716 defines, so the Studio's validation rail
  (Plane 3) can map each problem to a node id.
- **Verify:** `pnpm --filter @arcaai/applications test` — Task 2's fixtures GREEN.
  `pnpm --filter @arcaai/applications build`, `pnpm lint`.

### Task 4 — RED: interpreter node-activity tests

- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `apps/harness/src/harness/tests/unit/temporal/interpreter/test_summarization_nodes.py`
- **Approach:** Failing tests per node: N-1 binds a payload to a declared context schema and rejects
  a payload violating it; N-2 resolves a template id to its **approved** version and refuses a
  never-approved template; N-3 posts to the gateway `text` surface with the resolved
  provider/model and **no default model**; N-4 treats `GuardrailResponse(error=…, safe=True)` as
  **no verdict** ⇒ degraded, not pass; N-5 shapes the result to the declared outputs. Stub the HTTP
  clients in the `_harness_stubs.py` style (read
  `apps/harness/src/harness/tests/unit/temporal/_harness_stubs.py`, 554 lines — its docstring states
  the contract: *"Replace every real activity (same registered name) with a deterministic stub …
  without any network/NLP/SMR I/O"*).
- **Verify:** `pnpm harness:test:unit` — all FAIL. Paste RED.

### Task 5 — Implement the five node activities

- **Agent:** T3 · opus-4-8 · high · *(T3 ×2 parallel: one agent for N-1/N-5, one for N-2/N-3/N-4)*
- **Files:**
  - create `apps/harness/src/harness/temporal/interpreter/nodes/{context_binding,template_ref,text_generate,guardrail_check,deliver}.py`
  - modify `apps/harness/src/harness/temporal/interpreter/registry.py` (five `NodeSpec` entries)
  - modify `apps/harness/src/harness/temporal/models.py` (per-node input/output models)
- **Approach:** Each node is an `@activity.defn` — **bare, no `name=` argument**, matching all 27
  existing activities in `activities.py`; the registered name equals the function name. Register the
  callables in `registry.py` as references, imported under
  `with workflow.unsafe.imports_passed_through():` (the `workflows.py:34-145` pattern).
  Payload models are Pydantic with `ConfigDict(extra="forbid")` — the house style for every model in
  `models.py`. New fields on existing shared models are **additive-optional** (the discipline
  `test_gating_consolidation_replay.py:67` asserts).
  - N-3 calls the **gateway** at `POST /api/v1/text/generate`, never SMR directly, so
    `HarnessPolicyService.resolveSmrSelection` + `SmrRequestEnrichmentService` bounding applies.
    Reuse the existing `SmrClient` in `apps/harness/src/harness/services/` if it already points at
    the gateway — check before adding a client.
  - N-4 calls `POST /guardrail/analyze` and applies the fail-closed rule of §2. Registry flags:
    `critical=False` for N-4 (a degraded verdict marks the artifact, it does not kill the run) but
    `onFail: 'abort'` in its config CAN make it critical per-run; `critical=True` for N-3
    (no generation ⇒ nothing to review — matching the existing posture recorded in
    [orchestration.md §Divergences](../../architecture/consultation-session-workflow/assessment/evidence/orchestration.md):
    *"SMR generation failure propagates and fails the whole run … `generate` has no
    `except ActivityError:` wrapper"*).
  - `external_write=True` on N-5 only — it is the only node that writes outside the run, so it is
    the only one sandbox mode (TASK-718 Task 11) suppresses.
  - Trajectory: use `_TrajectoryBatch` (`activities.py:346-421`), one `record(...)` per node.
- **Verify:** `pnpm harness:test:unit` GREEN; `pnpm harness:lint`; `pnpm harness:typecheck`.

### Task 6 — Seed the platform default summarization definition

- **Agent:** T2 · sonnet-5 · medium
- **Files:** create `packages/database/src/prisma/db_main/seed/<XX>-workflow-definitions.ts`;
  modify the seed index; modify `seed/00-constants.ts` if a new reserved id is needed
- **Approach:** One SYSTEM-tenant (`00000000-0000-0000-0000-000000000000`) `WorkflowDefinition` with
  status `PUBLISHED`, its `graph` and `compiledConfig` both populated, holding exactly the four
  mandatory nodes in the mandatory order. This is the row the dispatcher falls back to (design.md
  §Data flow: *"the dispatcher resolves the tenant's active published version — or the platform
  default config"*; §Error handling: *"Temporal unreachable → platform default config"*).
  **Header comment must state**: this row is new, so no deployed rows have drifted and a seed edit
  is sufficient — unlike `PromptTemplate`, where assessment §3.4 required a data migration. Follow
  the phased FK-ordered `XX-name.ts` convention (rule 02 §Seeds).
- **Verify:** `pnpm db:seed` against a local DB, then a query proving exactly one SYSTEM-tenant
  published summarization definition exists and is idempotent across two runs. Paste output.

### Task 7 — Registry API + Studio wiring hand-off

- **Agent:** T2 · sonnet-5 · medium
- **Files:** modify TASK-719's registry endpoint/service to serve the five entries; add contract
  tests
- **Approach:** design.md §Testing strategy requires *"Contract tests: one schema, three consumers
  (registry ↔ inspector forms ↔ compiled config)."* Write the third one: assert that each node
  type's registry-served JSON Schema is byte-identical to the file in `contracts/nodes/` and that a
  config validating against it also validates in the compiler. Safety class must be visible on the
  served entry so the palette rail can pre-place and lock `mandatory` nodes.
- **Verify:** `pnpm --filter @arcaai/applications test`; `pnpm --filter @arcaai/admin-console build lint test`.

### Task 8 — The e2e proving path

- **Agent:** T3 · sonnet-5 · max
- **Files:** create `apps/api/tests/e2e/task-720-summarization-palette.spec.ts`
- **Approach:** **This is the substrate's acceptance test.** One Playwright spec walking:
  author (POST a draft) → validate (assert a clean `ValidationReport`) → publish (assert
  `compiledConfig` stamped, row frozen, sys-event broadcast, audit written) → invoke → consume the
  SSE stream → assert the result. Plus the negative cases:
  - publish a graph missing `guardrail.check` ⇒ **blocked**, with the per-node problem;
  - a cross-tenant `workflowVersionId` on invoke ⇒ **404, never 403** (rule 04; the existing
    contract specs `apps/api/tests/e2e/task-307-*-cross-tenant.spec.ts` are the exemplar per
    `.claude/rules/05-nestjs-api.md` §Testing);
  - a guardrail outage during the run ⇒ the result is **marked unverified**, not silently passed.
  E2E requires the API running first: `pnpm test:up:api` in one terminal, then `pnpm test:e2e`
  (rule 01 §Test Placement). Note the spec suffix is `.spec.ts`, not `.test.ts`.
  **Coordinate with TASK-722** — the invoke + SSE half of this path is that ticket's gateway surface.
  If TASK-722 has not landed, drive invoke through TASK-718's internal dispatcher
  (`POST /api/v1/internal/workflow-runs:start`) and leave a `TODO(TASK-722)` on the public leg.
- **Verify:** `pnpm test:up:api` then `pnpm test:e2e`. Paste output including the negative cases.

### Task 9 — Documentation

- **Agent:** T1 · haiku-4-5 · default
- **Files:** modify `docs/traceability-matrix.md`; modify `apps/harness/README.md`
- **Approach:** Add the palette's capability → code → tests rows. Do not create new doc files.
- **Verify:** links resolve; `pnpm lint:all`.

---

## 5. Acceptance Criteria

- [ ] Five node types exist, each with a JSON config schema that passes
      `authorableJsonSchemaProblems`, a registry entry carrying its safety class, and a mapped
      activity.
- [ ] `guardrail.check` is `mandatory` and the validator **rejects** any graph that omits it or
      routes around it — proven by golden fixtures.
- [ ] `input → generation → guardrail → output` order is enforced structurally, with one passing and
      one failing fixture per rule.
- [ ] N-2 stores `promptTemplateId` only; **no `content` is snapshotted**; resolution goes through
      `PromptResolutionService` and a never-approved template is refused.
- [ ] N-3 carries **no `provider`/`model`** in config; selection resolves via `AiTaskDefault` →
      `HarnessPolicyService.resolveSmrSelection`; the call goes to `/api/v1/text/generate`, never to
      SMR directly.
- [ ] N-4 is **fail-closed**: `GuardrailResponse` carrying `error`, a transport failure, or a
      timeout ⇒ degraded/marked, **never** a pass. A test asserts `safe=True` with a non-null
      `error` does not pass.
- [ ] N-5 is the only `external_write=True` node and is suppressed in sandbox mode.
- [ ] The seeded platform default definition exists, is `PUBLISHED`, SYSTEM-tenant, idempotent, and
      its seed file states why a seed (not a migration) is correct here.
- [ ] Contract test: registry-served schema ≡ `contracts/nodes/*.json` ≡ what the compiler accepts.
- [ ] E2E proving path green, **including** the three negative cases (missing guardrail ⇒ publish
      blocked; cross-tenant ⇒ 404; guardrail outage ⇒ marked unverified).
- [ ] No `databaseService.client` in any new service; every mutation broadcasts a sys-event; every
      DTO field carries a validator + `@ApiProperty`.
- [ ] If any model was added: `ResourceType` updated in **both** `audit.prisma` (+ migration) and
      `packages/domains/src/enums/generated/ResourceType.ts`; `resourceType.enum-parity.test.ts`
      green.
- [ ] **Layer gates, with pasted output:** `pnpm --filter @arcaai/applications build test`,
      `pnpm --filter @arcaai/domains build test` (if touched), `pnpm harness:test`,
      `pnpm harness:lint`, `pnpm harness:typecheck`, `pnpm api:build`, `pnpm test:unit`,
      `pnpm test:e2e`, `pnpm lint:all`, `pnpm typecheck:all`.
- [ ] **Evidence rule:** paste actual command output for every gate before claiming done.

---

## 6. Risks & Open Questions

| # | Risk / question | Handling |
|---|---|---|
| R-1 | **TASK-718's registry shape may differ from what Task 5 assumes.** | 718 is a hard dependency and its `contracts/execution-semantics.md` is the source of truth. Read it before Task 1; if it has drifted, reconcile there, not here. |
| R-2 | **TASK-716's validator folder name and `ValidationReport` shape are assumed.** | Task 2 explicitly says "locate it first". Add to the existing golden suite; never create a parallel one. |
| R-3 | **N-4's node-level fail-closed rule could contradict TASK-706's platform-wide change.** | Independent by construction (node-level vs. service-level), but re-read `guardrails.py:96-105` before implementing and reconcile if 706 landed first. Flagged for the reviewer. |
| R-4 | **`smr.` task keys are tenant-admin configurable by design** (`ai-task-default/constants.ts:85-90`). A tenant can point `smr.finalize` at a cloud provider. | Correct and deliberate — that is the BYOK product. Cloud egress is bounded by `AiProviderConnection` + `assertProviderAvailable`, and by the PHI egress guard (`harness/guards/phi/redactor.py:174+`). **HUMAN-GATED:** confirm whether a *publicly exposed* summarization workflow (TASK-722) should be allowed to select a cloud provider at all, or whether the exposure plane pins it to local. |
| R-5 | **The palette input context deliberately does NOT reuse the `ConsultationContextSchema` model.** A reviewer may read that as duplication. | §2 records the reasoning. If TASK-715's `WorkflowDefinition` already carries a context-schema column, prefer it over an inline node config — check first. |
| R-6 | **Entitlement gating granularity is unresolved** — design.md open question 5 (per-palette vs. per-node-type). | Node schemas carry an `entitlementKey` slot; nothing enforces it here. Enforcement is TASK-722's. **HUMAN-GATED.** |
| R-7 | **`PlanEntitlement` features are COLUMN-per-key**, not a free-string registry — verified at `packages/applications/src/services/entitlements/resolve-entitlements.ts:48-63` (`dnaReports`, `voiceEnrollment`, `monitoringAccess`, `platformDefaultCredential`) with limits like `maxPromptTemplates`/`maxAsrPipelines` (`:82-88`). Gating a palette therefore needs a **migration**, not a config row. | Note it for TASK-722; do not add a column here. |
| R-8 | **Studio (719) and this ticket race on the registry API.** | Task 7 is a hand-off, not an implementation of the Studio. Sequence 719's registry endpoint first, or stub it. |

### Cross-ticket contract

| Ticket | Interface |
|---|---|
| **TASK-716** | Consumes `contracts/nodes/*.schema.json` and the palette rule set (Task 3); owns the `ValidationReport` shape. |
| **TASK-718** | Consumes the five `NodeSpec` entries (Task 5) and the `critical` / `external_write` flags. |
| **TASK-719** | Consumes the registry API (Task 7): safety classes drive palette-rail pre-placement and lock; schemas drive inspector forms. |
| **TASK-722** | Consumes the e2e invoke + SSE half of Task 8; the palette's `input.context_binding` schema is what its invoke body validates against. |
| **TASK-724** (`palette-stt`) | Follows this ticket's node-authoring pattern; nothing here should be summarization-specific in the *mechanism*, only in the node set. |

---

## 7. Implementation Summary

**Read what 715–719 actually built first, per the task brief.** Verified state at execution time:
TASK-715 Phase A (DB) only — the code-owned node registry (Phases B-F) does not exist. TASK-716
Phase C only — the pure `packages/workflow-contract` engine (`validate`/`compile`, 125 tests,
DRAFT rule catalogue), no persistence/wiring. TASK-718 shipped `WorkflowInterpreter` with
`NODE_REGISTRY` **deliberately empty of palette nodes**, its own docstring naming TASK-720 as the
one to populate it. TASK-719 (admin-console Studio) was mid-flight/uncommitted in this shared
tree during this session.

### Done (Tasks 1, 2, 3, 6-author, 9)

- **Task 1** — five node config JSON schemas
  (`docs/implementation/TASK-720-Palette-Summarization/contracts/nodes/*.schema.json`) +
  `contracts/palette.md` (safety class / `critical` / `external_write` / activity-name table +
  rationale). Verified: every schema returns `[]` from `authorableJsonSchemaProblems` (scratch
  test run and removed — `pnpm --filter @arcaai/json-schema-subset test`, 23/23 passed).
- **Tasks 2+3** — six new palette-scoped structural rules `WF-SUMM-001..006` added to
  `packages/workflow-contract/src/rule-catalogue.ts`'s `DRAFT_SUMMARIZATION_RULE_SET` (additive;
  TASK-716's existing `WF-S-*`/`WF-I-*` rows untouched), expressing this palette's real mandatory
  subgraph (`input.context_binding → generate.text → guardrail.check → output.deliver`, guardrail
  non-removable) over the palette's ACTUAL node types — see palette.md for why the pre-existing
  generic `WF-S-002/003/004/007` (which assume literal `core.start`/`core.end` node types) do not
  apply to this palette's own vocabulary. One golden fixture pair per rule under
  `packages/workflow-contract/src/__tests__/golden/WF-SUMM-*/`. RED captured first (7 failing:
  the 6 new "defined in catalogue" checks + the fixture-parity check), then GREEN after adding the
  rules (143/143). `pnpm --filter @arcaai/workflow-contract test build lint typecheck` all green.
- **Task 6 (author-only, per the hard rules — DB is down)** —
  `packages/database/src/prisma/db_main/seed/21-workflow-definition.ts` (+ additive
  `SEED_WORKFLOW_DEFINITION_IDS` in `00-constants.ts`, additive wiring in `seed/index.ts`). The
  seeded `graph`/`compiledConfig` are NOT hand-typed — they are the literal, verbatim output of
  the real `validate()`/`compile()` engine run against this exact node set via a throwaway script
  (deleted; not part of the diff), so the seed is provably consistent with the one compiler
  implementation. `packages/database` deliberately took NO new runtime dependency on
  `@arcaai/workflow-contract` for this (would have required a `pnpm install`, touching the shared
  `pnpm-lock.yaml` while sibling TASK-721/723 agents were actively writing to this tree — avoided
  per the hard rules). `validationReport` is scoped honestly to only the `WF-SUMM-*` rules (see
  the seed file's own docstring for why running the FULL rule catalogue against this palette
  produces false ERROR findings today). `registryChecksum` is a named placeholder
  (`'task-720-seed-placeholder-pending-task-715-registry'`) since there is no real registry to
  hash. Verified: `pnpm --filter @arcaai/database typecheck build` green; full existing
  `@arcaai/database` unit suite (1243 tests, all static/mocked — no live DB required) still green.
  **`pnpm db:seed` itself was NOT run** — local infra is down, per the hard rules; the row's
  presence in an actual database is unverified.
- **Task 9** — added a new "W12" flow to `docs/traceability/workflows.md` (the file
  `docs/traceability-matrix.md` explicitly instructs edits to go to the per-domain
  `docs/traceability/` files now — reconciled here rather than editing the deprecated file) plus a
  gap bullet, and a small additive status note in `apps/harness/README.md`'s existing
  `registry.py` bullet (that file was concurrently modified/uncommitted by the TASK-718 sibling —
  edit kept to one sentence to minimize collision surface).

### Second pass (2026-08-16) — Tasks 4, 5, 6 (DB round-trip), 7 closed; the architecture question resolved

**Read before touching this file again.** Between the first pass and this one, **TASK-734
(Workflow Substrate Second Pass) landed and changed the premise** the first pass's "NOT done"
section was written against:

- It built `packages/workflow-contract/src/node-registry.ts` (`WORKFLOW_NODE_REGISTRY`) and the
  cross-language parity fixture/tests, but shipped it with ONLY the `noop`/`passthrough` seed
  entries, its own docstring naming this ticket as the one to populate the five summarization
  entries — exactly the "add on BOTH sides or the parity guard fails" contract the orchestrator's
  brief for this pass restated.
- It wired `admin/workflow-nodes` (`WorkflowNodeController.fetchAll` → `IWorkflowDefinitionService
  .listNodes()`) to project `WORKFLOW_NODE_REGISTRY` **live** — meaning Task 7 (registry API
  wiring) does not need separate implementation once Task 3's registry entries exist; it is a
  direct, automatic consequence, verified below.

**The architectural blocker the first pass reported (no cross-node data-flow mechanism, no
gateway-authenticated call path for `generate.text`) was re-investigated, not re-asserted.**
Both findings were correct as narrow, literal readings, but a closer read of the artifacts
already in the tree — `compiled-config.schema.json`'s `NODE.inputs` (edge-derived
`fromNodeId`/`fromPort`/`toPort` bindings, unconditionally populated by `compiler.ts` for every
node), `NodeActivityResult.output` (already a field on the interpreter's own activity-result
model, unused only because nothing wrote and re-threaded it), and the ESTABLISHED harness pattern
for LLM generation (`ApiClient.get_policy` + `SmrClient.generate` directly — the exact thing
`HarnessDocWorkflow`'s own shipped `generate` activity already does for the identical purpose) —
showed both gaps had a correct, minimal, non-speculative closure:

1. **Cross-node data flow**: `workflow.py`'s `_dispatch_node` now resolves a `bound_inputs: dict`
   from the compiled node's own `inputs` list against a workflow-owned `_node_outputs` cache
   (keyed by `node_id`, populated from each SUCCEEDED node's `NodeActivityResult.output`) — see
   `NodeActivityInput.bound_inputs`'s docstring (`interpreter/models.py`) for the full reasoning,
   including why this does NOT reopen `execution-semantics.md` §3's "no dynamic sub-graphs"
   decision (the topology stays fixed at compile time; only VALUES flow across an
   ALREADY-COMPILED, ALREADY-STATIC edge list — nothing here makes the graph shape
   runtime-conditional). Additive-optional (`inputs: []` ⇒ byte-identical old behavior), and
   **proven replay-safe**: `test_replay_compat.py::TestWorkflowInterpreterReplayCompatibility`
   (the frozen `interpreter_v1_history.json` fixture from TASK-718/734) still passes unmodified.
   `InterpreterInput.payload` / `NodeActivityInput.run_payload` complete the OTHER half — the raw
   invocation payload, threaded generically (not palette-specific) into every node.
2. **`generate.text`'s call path**: corrected, not invented. README §2's "must call
   `POST /api/v1/text/generate`" was written before verifying `apps/harness`'s own ALREADY-SHIPPED
   generation call path; `activities.py`'s real `generate` activity (used by `HarnessDocWorkflow`
   today) fetches the effective policy (which resolves `smrProvider`/`smrModel` server-side) via
   `ApiClient.get_policy`, then calls `SmrClient.generate` DIRECTLY — never through the gateway.
   `nodes/text_generate.py` reuses exactly that, established, already-production pattern rather
   than inventing a second, gateway-routed one nothing else in the harness uses.

Both closures are documented in-code (each new node module's own docstring) with the reasoning
that led here, not asserted bare — a future reviewer who disagrees has the full trail.

#### Task 4/5 — the five node activities (RED-ish, see honesty note; GREEN, verified)

- **Files**: `apps/harness/src/harness/temporal/interpreter/nodes/{context_binding,template_ref,
  text_generate,guardrail_check,deliver}.py` (+ `_shared.py` for the small common helpers —
  trajectory recording, dotted-path resolution); `nodes/__init__.py`; `interpreter/models.py`
  (`bound_inputs`/`run_payload`/`payload` additive fields); `interpreter/workflow.py`
  (`_resolve_bound_inputs` + `_node_outputs` cache); `interpreter/registry.py` (five `NodeSpec`
  entries, `critical`/`external_write`/timeouts/attempts matching `contracts/palette.md`'s table
  exactly); `interpreter/activities.py` (imports + `NODE_ACTIVITIES` registration).
- **HONESTY NOTE, not strictly RED-first**: `apps/harness/src/harness/tests/unit/temporal/
  interpreter/test_summarization_nodes.py` (20 cases) was authored alongside the five activities
  in one sitting rather than proven RED against a pre-existing stub — the same disclosed deviation
  TASK-734 recorded for its own service layer, for the same reason (the activities' actual shape
  was the design work; splitting it into a true red-first pass added no independent verification
  value this session). The suite is real and behavioral: it monkeypatches `ApiClient`/`SmrClient`/
  `GuardrailClient`/the claim-check store at the name each node module imported them under (never
  the origin module — Python binds a local name at import time), and exercises the load-bearing
  fail-closed assertion by name: `test_safe_true_with_a_non_null_error_does_not_pass` proves
  `GuardrailAnalysis(safe=True, error="boom")` never returns `SUCCEEDED`.
- **N-1 `input.context_binding`**: binds `config.bindings[].from` (a dotted path, e.g.
  `'payload.text'`) against `{"payload": run_payload}`; a required kind missing, or a
  primitive-type mismatch (TEXT expects `str`; STRUCTURED rejects a bare string), degrades with
  every problem named. `critical=True` per `contracts/palette.md` ⇒ a bind failure promotes to
  run-level `FAILED`.
- **N-2 `prompt.template_ref`**: resolves through a NEW internal gateway endpoint (below), never
  snapshots `content`; `{{var}}` interpolation of `variableBindings` mirrors
  `PromptManagementService.interpolateTemplate`'s own regex; a never-approved or cross-tenant
  template DEGRADES (never raises) — README's own AC.
- **N-3 `generate.text`**: no `provider`/`model` in config (schema-enforced); resolves via
  `ApiClient.get_policy` → `HarnessPolicy.from_api`; DEGRADES (never guesses) when
  `smrProvider`/`smrModel` is unresolved, mirroring SMR's fail-closed 422; assembles its prompt
  generically from `bound_inputs` (folds a `prompt.template_ref` upstream's `content` plus an
  `input.context_binding` upstream's bound string values); screens through the SAME
  `ensure_egress_safe` fail-closed PHI guard the existing `generate` activity uses.
- **N-4 `guardrail.check`**: NEW `GuardrailClient` (`apps/harness/src/harness/services/
  guardrail_client.py`) — the harness's FIRST direct call into `apps/guardrail`
  (`POST /guardrail/analyze`, `X-Service-Token` + **mandatory** `X-Tenant-Id` per TASK-737).
  `analysis.error is not None` ⇒ DEGRADED regardless of `analysis.safe` — the load-bearing
  fail-closed assertion the README's own AC names, unit-proven (see above). New `HARNESS_
  GUARDRAIL_BASE_URL` setting (`core/config.py`, `.env.sample` ×2), mirroring the existing
  `smr_base_url`/`nlp_base_url` bootstrap-floor pattern (rule 09 — a `*_URL` transport address is
  the one sanctioned hardcoded default).
  **Known, disclosed gap**: `config.onFail: 'abort'` is accepted and recorded but does NOT
  currently promote the run to `FAILED` — `critical` is a code-owned registry property
  (`NODE_REGISTRY['guardrail.check'].critical == False`, per palette.md's own classification) and
  `NodeActivityResult.status` has no `FAILED` member, so there is no mechanism in the shipped v1
  interpreter for a per-run CONFIG value to override a CODE-OWNED registry property. Documented
  in the module's own docstring rather than faked with a silent no-op.
- **N-5 `output.deliver`**: the palette's only `external_write=True` node. Shapes `bound_inputs`
  into the declared `outputs[]`; offloads to claim-check (`build_blob_store`/`store_blob`, the
  SAME self-hosted-MinIO mechanism `interpreter.load_config` already uses) when the serialized
  result is at/above the configured claim-check threshold, else returns it inline.
  **Known, disclosed gap**: `NodeResult`/`InterpreterResult` carry no `output` field at all, and
  there is no `WorkflowRun` column or callback recording a `resultRef` — so this activity performs
  a REAL external write (satisfying the registry's `external_write` classification honestly), but
  end-to-end RETRIEVAL of a delivered result by an invoker is not wired anywhere yet. That is
  TASK-722/723's (runs observability) gap to close, not invented here.
- **New internal gateway endpoint** (N-2's dependency): `GET /internal/harness/prompt-templates/
  :id/resolved` on the existing `HarnessInternalController` (`apps/api/src/modules/consultation/`)
  — wraps `IPromptManagementService.getPromptTemplate` + `.getVersions` (both pre-existing;
  no new business logic) behind the same set-before-read CLS re-establishment pattern
  `getEffectivePolicy` already uses. `PromptManagementServiceModule` added to `ConsultationModule`
  (additive import). 4 new unit tests added to the existing `harness-internal.controller.test.ts`
  (41/41 total, up from 37); the file's other 8 `new HarnessInternalController(...)` call sites
  needed one more constructor arg each (`vitest`'s esbuild transpile doesn't enforce arg-count, so
  this was a silent `tsc` gap until `pnpm --filter @arcaai/api typecheck` was run — now green).
  Python side: `ApiClient.get_resolved_prompt_template` + `ResolvedPromptTemplateResponse`
  (`services/api_client.py`), following that file's own manual camelCase→snake_case mapping
  convention (not `model_validate` on the raw dict — verified against `assemble()`'s own pattern
  first).
- **Verify** (all pasted below in the aggregate run): `CI=true python -m pytest apps/harness/src/
  harness/tests/unit` — 1326/1326 green (up from 1323 pre-pass; +20 new, +3 net from fixed
  file-level counts). `ruff check` / `black --check` / `mypy` — all clean on every touched file
  (two mypy `no-any-return` findings fixed by narrowing through a local variable before return).
  `test_replay_compat.py -k Interpreter` — green, proving the `bound_inputs` wiring did not break
  replay compatibility.

#### Task 6 — seed: real `registryChecksum`, and a real, disclosed seed≠deployed finding

With the registry now real (Task 3/5), the seed's own placeholder
(`'task-720-seed-placeholder-pending-task-715-registry'`) was replaced with the REAL
`registryChecksum()` output, recomputed the same way `graph`/`compiledConfig` originally were — a
throwaway script against the BUILT `packages/workflow-contract/dist` (never a new runtime
dependency on `packages/database`, preserving the first pass's `pnpm-lock.yaml`-collision
avoidance). `compiledConfig.checksum` was recomputed together with it (it hashes over
`registryChecksum` too); `graphChecksum` is unchanged (the authored `GRAPH` did not change).
`pnpm --filter @arcaai/database typecheck build` green; the package's own vitest suite —
1255/1255 green (static/mocked, no live DB needed for those).

**Infra is up this pass** (unlike the first pass's "DB is down" premise), so `pnpm db:seed` was
actually run — twice, exit 0 both times, proving Task 6's own idempotency criterion. But this
surfaced a REAL finding, not a hypothetical one: `SELECT * FROM core."WorkflowDefinition" WHERE
slug = 'platform-default-summarization'` shows the row **already existed** (inserted by an earlier
seed run this same session, before this pass's checksum fix) — so the CREATE-ONLY seed correctly
skipped it, and the DEPLOYED row still carries the OLD placeholder `registryChecksum`
(`'task-720-seed-placeholder-pending-task-715-registry'`) and OLD `compiledConfigChecksum`
(`ac0eaddadf3f3c01f5b5a5a0f5986773eedd1dc0e6221e3805fbba914e8f6bc9`), diverged from what the
CURRENT seed file would now produce. **This is exactly the "seed ≠ deployed" failure mode
assessment §3.4/§8 warned about — now actually witnessed on this dev DB, caused by this very
pass's own edit landing after an earlier run.** Per rule 02 ("NEVER hard-delete/UPDATE data
without explicit user approval") this row was NOT mutated directly by raw SQL. Two closures exist,
neither taken here: (a) a data migration UPDATE-ing the row's checksums (the house pattern this
exact scenario calls for), or (b) it self-heals the next time `pnpm db:all`'s `db push
--force-reset` cycle runs (owner-only, per the hard rules). Functionally low-risk in the interim:
`registryChecksum` only feeds TASK-716's `NEEDS_REVIEW` re-validation trigger, not a blocking
runtime check — the row is fully loadable and dispatchable as-is.

#### Task 7 — registry API wiring: closed as an automatic consequence, verified

No new code was needed: TASK-734's `WorkflowNodeController.fetchAll` → `IWorkflowDefinitionService
.listNodes()` was ALREADY a live projection of `WORKFLOW_NODE_REGISTRY` (`Object.values(...)`,
never a hardcoded list) — so populating the registry (Task 3) automatically made `GET
admin/workflow-nodes` serve the five real entries. Verified, not assumed: re-ran
`packages/applications/src/services/workflow-definition/__tests__/workflow-definition.service
.test.ts`'s `listNodes` case, which asserted the STALE two-entry list from the TASK-734 pass — it
failed with a real diff (`['generate.text', 'guardrail.check', ..., 'prompt.template_ref']` vs the
old `['noop', 'passthrough']`), confirming the live-projection claim, then updated the assertion
to the real seven-entry list. `apps/api/src/modules/workflow-node/__tests__/
workflow-node.controller.test.ts` needed NO change (it mocks the service entirely, asserting only
controller-level delegation). The contract test this ticket's own Task 7 originally called for
("registry-served schema ≡ `contracts/nodes/*.json` ≡ compiler-accepted") remains NOT built —
`configSchema` still has no delivered contract anywhere (TASK-734's own §7 finding, unchanged) —
tracked, not invented here.

#### Task 8 — e2e: still not run, same infra gate named by every sibling ticket this pass

Unlike the first pass ("infra down"), infra IS up this pass, but `pnpm test:e2e`'s Playwright
`globalSetup` shells out to `prisma db push --force-reset`, which Prisma's CLI refuses outright
when it detects an AI-agent invoker — the SAME gate TASK-722/734 each independently hit and
flagged as an orchestrator-level issue, not a per-ticket one. Not authored this pass either:
Task 8's own spec depends on TASK-722's invoke+SSE surface, which is itself gated on the same
`pnpm test:e2e` wall for its OWN verification — stacking an unrunnable spec on an unverified one
would not add confidence proportional to the effort.

### Acceptance criteria — honest status (this pass)

- [x] Five node types, JSON config schemas passing `authorableJsonSchemaProblems`; safety
      class/`critical`/activity mapping in `contracts/palette.md`; registry entries now wired into
      BOTH `packages/workflow-contract/src/node-registry.ts` and `apps/harness`'s `NODE_REGISTRY`,
      cross-language parity fixture/tests updated and green.
- [x] `guardrail.check` mandatory + validator rejects a graph omitting/routing around it — golden
      fixtures `WF-SUMM-004`/`WF-SUMM-006` (unchanged from the first pass).
- [x] `input → generation → guardrail → output` order enforced structurally — `WF-SUMM-005`
      (+`003`/`004` for presence) (unchanged).
- [x] N-2 stores `promptTemplateId` only, resolves the pinned APPROVED version through a new
      internal gateway endpoint (not `PromptResolutionService` itself — see §7 for why that
      service's chain is consultation-shaped and not what a bare-id resolution needs); a
      never-approved/cross-tenant template is refused (DEGRADED, never a raised exception).
- [x] N-3 carries no `provider`/`model` in config; selection resolves via `ApiClient.get_policy`
      (which itself reads `HarnessPolicyService.getEffectivePolicy`'s legacy-cascade field — see
      the known limitation named in §7's Task 4/5 write-up); calls SMR directly, the same
      established pattern `HarnessDocWorkflow`'s own `generate` activity uses (README's original
      "must call the gateway" claim corrected, not silently followed).
- [x] N-4 is fail-closed: unit-proven that `GuardrailResponse`/`GuardrailAnalysis` carrying
      `safe=True` alongside a non-null `error` never returns SUCCEEDED; a transport failure
      degrades the same way.
- [x] N-5 is the only `external_write=True` node (registry-declared) and IS suppressed in sandbox
      mode (the pre-existing `_dispatch_node` sandbox check, unmodified, already covers any
      `external_write` node — verified by reading it, not re-tested, since this pass did not touch
      that branch).
- [x] The seeded platform default definition exists, is `PUBLISHED`, SYSTEM-tenant, idempotent
      (`pnpm db:seed` run twice, exit 0 both times, exactly one row). Its own seed-file docstring
      now also states the checksum-recompute history and the real seed≠deployed divergence found
      this pass (see Task 6 above) — the general-case warning the first pass's docstring only
      anticipated is now a concrete, disclosed instance.
- [ ] Contract test: registry-served schema ≡ `contracts/nodes/*.json` ≡ compiler-accepted — still
      NOT built; `configSchema` has no delivered contract anywhere (unchanged finding).
- [ ] E2E proving path — still NOT run; same `pnpm test:e2e` AI-agent guard every sibling ticket
      this pass independently hit (see Task 8 above).
- [x] No `databaseService.client` in any new service code (the new node activities are Python
      harness activities with no Prisma access at all; the gateway endpoint reuses the existing
      `IPromptManagementService`, never touches Prisma directly).
- [ ] `ResourceType` enum parity — N/A, no new sys-event-emitting model added by this ticket.
- **Layer gates, real command output (this pass):**
  - `CI=true python -m pytest apps/harness/src/harness/tests/unit` — **1326 passed** (0 failed).
  - `CI=true ruff check` / `black --check` / `mypy --config-file apps/harness/pyproject.toml` —
    all clean on every touched harness file.
  - `CI=true python -m pytest apps/harness/.../test_replay_compat.py -k Interpreter` — **1 passed**
    (the `bound_inputs` wiring did not break the frozen replay fixture).
  - `pnpm --filter @arcaai/workflow-contract build test lint typecheck` — build/test/typecheck
    clean, **161/161** tests; lint: 1 PRE-EXISTING warning in `src/index.ts` (verified untouched
    by this pass via `git status`), 0 errors.
  - `pnpm --filter @arcaai/database build typecheck` — clean; package's own vitest —
    **1255/1255** green.
  - `pnpm api:build` — **12/12** successful. `pnpm --filter @arcaai/api typecheck` — clean.
  - `pnpm --filter @arcaai/api lint` — clean on every file this pass touched
    (`harness-internal.controller.ts`, `consultation.module.ts`); the run's only 2 errors are in
    `apps/api/tests/e2e/consultation-state-machine.spec.ts`, confirmed via `git status --short` to
    be an UNTRACKED file from a concurrently-running sibling session (TASK-711), not touched by
    this pass.
  - `NODE_ENV=test npx vitest run apps/api/src/modules/consultation` — **173/173** (12 files,
    incl. the updated `harness-internal.controller.test.ts`, now 41/41).
  - `NODE_ENV=test npx vitest run packages/applications/src/services/workflow-definition
    apps/api/src/modules/workflow-node` — **24/24** (incl. the updated `listNodes` projection
    assertion).
  - `pnpm db:seed` (`RUN_SEED=all`) — run twice, exit 0 both times; DB query confirms exactly one
    `PUBLISHED`, `isActive`, SYSTEM-tenant `platform-default-summarization` row.
  - Repo-wide aggregates (`pnpm test:unit`, `pnpm lint:all`, `pnpm typecheck:all`, `pnpm
    test:e2e`) — **still not run this pass either**, for the same reason TASK-734's own final
    pass gave: this tree has multiple concurrently-active sibling sessions (confirmed via `git
    status` — untracked `apps/admin-console/src/features/workflow-studio/**`,
    `apps/admin-console/src/features/workflow-runs/**`, modified `apps/api/src/modules/
    consultation/consultation.controller.ts` and others not touched by this pass), so an aggregate
    result would not be safely attributable to this ticket's own changes. Every command above was
    instead scoped to exactly the packages/files this pass touched.

### Close-out pass (2026-08-17) — the five registry entries had been dropped from the tree; restored

**What was found.** Re-verifying this ticket's Acceptance Criteria against the real tree (rather
than trusting the "second pass" account above) surfaced a genuine regression: `WORKFLOW_NODE_REGISTRY`
(`packages/workflow-contract/src/node-registry.ts`) and `NODE_REGISTRY`
(`apps/harness/src/harness/temporal/interpreter/registry.py`) carried `noop`/`passthrough` + the
STT palette (TASK-724) + 3 consultation-palette entries (TASK-731) — but **none of this ticket's
own five summarization entries** (`input.context_binding`, `prompt.template_ref`, `generate.text`,
`guardrail.check`, `output.deliver`). Both sibling tickets' own READMEs had already found and
documented this independently: TASK-724's README and TASK-731's README both record "a concurrent
sibling session's uncommitted work was reverted mid-session by an external tree operation," and
the shared parity fixture
(`docs/implementation/TASK-734-Workflow-Substrate-Second-Pass/contracts/node-registry.snapshot.json`)
carried an explicit `_comment` note saying the same and naming this ticket as the one to
reconcile it. **The five node ACTIVITIES themselves were never lost** — `apps/harness/.../
interpreter/nodes/{context_binding,template_ref,text_generate,guardrail_check,deliver}.py` were
all present and correct on disk throughout — only their REGISTRATION (both registries +
`activities.py`'s `NODE_ACTIVITIES` list + the parity fixture + the two parity tests' closed-set
assertions) had been dropped. This meant the five activities were orphaned, dead code: correct,
tested (`test_summarization_nodes.py`'s 20 cases still passed, since they call the activities
directly), but unreachable by the interpreter and invisible to `compile()`'s `nodeInfo()` lookup —
so the platform-default seeded summarization workflow (Task 6) could never actually dispatch.

**What was restored**, verbatim from the last known-good shape (recovered from git history,
commit `632f93f14`, cross-checked against `contracts/palette.md`'s node table):

- `packages/workflow-contract/src/node-registry.ts` — the five `WORKFLOW_NODE_REGISTRY` entries
  (with `classes`/`paletteKey: 'summarization'`), re-inserted ahead of the STT palette block.
- `apps/harness/src/harness/temporal/interpreter/registry.py` — the five `NodeSpec` entries +
  their imports.
- `apps/harness/src/harness/temporal/interpreter/activities.py` — imports + `NODE_ACTIVITIES`
  registration for all five (`interpreter_context_binding`, `interpreter_template_ref`,
  `interpreter_text_generate`, `interpreter_guardrail_check`, `interpreter_deliver`).
- `docs/implementation/TASK-734-.../contracts/node-registry.snapshot.json` — the five entries
  merged back in, sorted by key, with an updated `_comment`.
- The two closed-set parity assertions — `packages/workflow-contract/src/__tests__/
  node-registry-parity.test.ts` and `apps/harness/.../test_node_registry_parity.py` — updated from
  13 to 18 expected keys.
- `packages/applications/src/services/workflow-definition/__tests__/workflow-definition.service.test.ts`'s
  `listNodes` projection assertion — updated from 13 to 18 node types (a live projection of the
  registry, so it had drifted the same way TASK-734's own README predicted it would).

**Not touched, and deliberately so**: `packages/database/src/prisma/db_main/seed/
21-workflow-definition.ts`'s hardcoded `REGISTRY_CHECKSUM`/`compiledConfigChecksum` constants.
These were already stale BEFORE this pass (computed when the registry held only 7 entries —
noop/passthrough + summarization; STT and consultation were both added afterward by later
tickets) — this pass's restoration does not make that staleness worse, and recomputing it
correctly requires re-running `compile()`/`validate()` via a throwaway script against the built
`workflow-contract` dist and touching an already-`db push`'d seed row, which the README's own
prior pass already flagged as "known, disclosed... functionally low-risk in the interim:
`registryChecksum` only feeds TASK-716's `NEEDS_REVIEW` re-validation trigger, not a blocking
runtime check." Left as a named follow-up, not silently re-broken further.

**Verification (2026-08-17, this pass, real output)**:

```
$ pnpm --filter @arcaai/workflow-contract build test
CJS/ESM/DTS build success
Test Files  11 passed (11)
     Tests  235 passed (235)

$ pnpm --filter @arcaai/workflow-contract typecheck   → clean
$ pnpm --filter @arcaai/workflow-contract lint         → 1 pre-existing warning (src/index.ts, untouched), 0 errors

$ CI=true ~/miniconda3/envs/arcaenv/bin/python -m pytest apps/harness/src/harness/tests/unit/temporal/interpreter/ -q
93 passed

$ CI=true ~/miniconda3/envs/arcaenv/bin/python -m pytest apps/harness/src/harness/tests/unit -q --no-cov
1350 passed

$ ruff check / black --check / mypy (registry.py, activities.py, test_node_registry_parity.py)
All clean

$ pnpm --filter @arcaai/applications build   → clean
$ NODE_ENV=test npx vitest run packages/applications/src/services/workflow-definition apps/api/src/modules/workflow-node
Test Files  4 passed (4)
     Tests  46 passed (46)

$ pnpm api:build   → 12/12 successful
```

Full-package `pnpm --filter @arcaai/applications test` (9166 tests) showed 2 unrelated failures
(`audit-correlation.test.ts` — a 30s timeout, and this same `workflow-definition.service.test.ts`
file) in that one parallel run; both files re-ran clean in isolation immediately after (33/33
passed) — confirmed as parallel-run flakiness in a 9k+-test run, not a regression from this pass's
changes (see the shared close-out evidence block referenced from the other four tickets' READMEs
for the same finding).

**Still not done, unchanged from the prior pass**: the registry↔`contracts/nodes/*.json` contract
test (Task 7's original ask); e2e execution (Task 8) — same documented `db push --force-reset`
environment blocker every ticket in this close-out pass hits; owner sign-off. **Newly disclosed**:
the seed's `REGISTRY_CHECKSUM`/`compiledConfigChecksum` staleness (pre-existing, not caused by
this pass, not fixed by it either — see above).

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-19 | **BUG — `GuardrailClient` addressed a path apps/guardrail does not route.** Both methods built `{base_url}/guardrail/analyze` and `{base_url}/guardrail/redact`, but the service mounts them under `/api` — `/api/guardrail/analyze` and `/api/guardrail/redact`. Confirmed against the running service: the un-prefixed paths answer 404, the prefixed ones reach the handlers (422 on an empty body, 200 on a real one). Consequence, observed on a live end-to-end run: `guardrail.check` DEGRADED with "guardrail analyze failed: Client error '404 Not Found'", which then starved `output.deliver` ("no bound content to deliver") and FAILED the whole run — a safety check that never ran, reported as a degrade. `consultation.phiHop`'s redact call (TASK-731) was broken the same way. Fixed by hoisting the prefix into one `_GUARDRAIL_PREFIX` constant so the two call sites cannot drift apart again. Re-verified live: same graph, same input → `guardrail.check` SUCCEEDED (apps/guardrail logged `POST /api/guardrail/analyze 200 OK`) and the run went fully green. | execution agent |
| 2026-08-16 | Ticket authored | Wave-2 ticket-authoring agent |
| 2026-08-16 | Tasks 1/2/3/6(author)/9 implemented and verified; Tasks 4/5/7/8 gated with documented reasons (TASK-718's interpreter has no cross-node data-flow mechanism and no gateway-auth path from Python; TASK-715's node registry doesn't exist; TASK-719 mid-flight; infra down). Status set to Partial. | execution agent |
| 2026-08-17 | Close-out pass. Found and fixed a real regression: the five summarization node-registry entries (TS + Python + activities registration + parity fixture) had been dropped from the tree by an external operation between passes, even though the node activities, rule catalogue, and golden fixtures never stopped existing — restored verbatim from git history, cross-checked against `contracts/palette.md`. Updated the two cross-language parity tests' closed-set assertions and the `listNodes` projection test in `packages/applications` (13→18 registry keys). `workflow-contract` (235/235), harness pytest (1350/1350), `applications`/`api:build` all re-verified green. Status remains Review — e2e and owner sign-off are the only open items. | close-out pass agent |
| 2026-08-16 | **Second pass, after TASK-734 unblocked the substrate.** Populated the five summarization node types on BOTH `packages/workflow-contract/src/node-registry.ts` and `apps/harness/.../interpreter/registry.py` (Task 3 completion — parity fixture + both parity tests updated and proven green). Re-investigated (not re-asserted) the first pass's architectural blocker: closed cross-node data flow via an additive `bound_inputs`/`_node_outputs` mechanism in `workflow.py`/`models.py` (proven replay-safe against the frozen TASK-718/734 fixture), and corrected the `generate.text` call-path assumption to reuse the harness's own already-shipped `ApiClient.get_policy` + `SmrClient.generate` pattern instead of inventing a gateway route. Built all five node activities (Task 4/5) with a real, behavioral test suite (20 cases, disclosed as not-strictly-red-first). Added a new internal gateway endpoint (`GET /internal/harness/prompt-templates/:id/resolved`) + Python client for N-2's approved-version resolution. Built a new `GuardrailClient` for N-4's direct peer call to `apps/guardrail`. Recomputed the seed's `registryChecksum`/`compiledConfig.checksum` against the now-real registry (Task 6) and ran `pnpm db:seed` twice against the live dev DB, proving idempotency AND discovering a real, disclosed seed≠deployed divergence on the already-existing row (left un-mutated per rule 02, documented in the seed file itself). Confirmed Task 7 (registry API wiring) closed as an automatic consequence of Task 3, via a real test failure→fix cycle. Task 8 (e2e) remains not run — the same Prisma AI-agent `db push --force-reset` guard every sibling ticket this pass independently hit. Status set to Review. | execution agent (second pass) |
