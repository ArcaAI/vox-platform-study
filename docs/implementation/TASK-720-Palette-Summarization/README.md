# TASK-720 — Summarization Palette

| | |
|---|---|
| **Status** | Pending |
| **Wave** | 2 · **Size** | L |
| **Epic slug** | `palette-summarization` |
| **Depends on** | TASK-718 (`workflow-interpreter`), TASK-719 (`workflow-studio-v1`) |
| **Design refs** | D3, D4, **D5** from [design.md](../../architecture/agentic-workflow-platform/design.md) — Plane 1 §Node registry, §Compiler + Validator, §Services program (`text`, `guardrail`), Roadmap Wave 2 |
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

**The gateway controller is already named `text`.** `apps/api/src/modules/streaming/smr-proxy.controller.ts:174`
→ `@Controller('text')`, i.e. `/api/v1/text/*`. Relevant routes:

| Route | Line | Guard |
|---|---|---|
| `POST text/generate` | `:483` | `@HttpCode(OK)` `:484`, `@Authorize()` `:485` |
| `GET text/tasks/:taskId` | `:520` | `@Authorize()` `:521` |
| `POST text/tasks/:taskId/cancel` | `:550` | `@Authorize()` `:551` |
| `GET text/tasks/:taskId/stream` | `:574` | `@Authorize()` `:575` + `@StreamScope({ namespace: 'smr_task', param: 'taskId' })` `:576` |
| `POST text/generate/assembled` | `:742` | `@Authorize()` `:743` |

Downstream: `SMR_URL` via `this.configService.getConfigValue('SMR_URL')` (`:284-286` — a direct
`process.env` read is lint-banned, `:278-283`); `X-Service-Token` injected from
`secretsService.getSecretSync('SMR_SERVICE_TOKEN')` (`:288-300`).

SMR's own contract (`apps/smr/src/smr/api/endpoints/generate.py:209-241`,
`apps/smr/src/smr/models/requests.py:111-133`): `GenerateRequest` carries `prompt` (min 1, max
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
   when neither resolves. Task keys: `SMR_TASK_KEY = { live: 'smr.live', finalize: 'smr.finalize',
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
   (`:94`). The gateway calls it via `applySmrModelSelection` (`smr-proxy.controller.ts:238-251`).

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
4. **Do not call SMR directly.** All bounding lives in the gateway (`smr-proxy.controller.ts:238-251`);
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
    SMR's own (`apps/smr/src/smr/models/requests.py:111-133`): `temperature` 0–2, `systemPrompt`
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

_(Empty at authoring — filled during execution.)_

## 8. Change History

| Date | Change | By |
|---|---|---|
| 2026-08-16 | Ticket authored | Wave-2 ticket-authoring agent |
