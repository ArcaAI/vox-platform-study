# TASK-844 — AiRoutingPolicy Absorption & Provider Configuration Model

| Field | Value |
|---|---|
| **Status** | `Review` — complete in worktree `worktree-agent-a943d6e57acb47e59`, NOT merged |
| **Type** | `refactor` (schema-bearing) |
| **Parent program** | [TASK-837](../TASK-837-AI-Platform-Consolidation-Program/README.md) §4 |
| **Depends on** | TASK-843 (phase 1, merged as `d3d448a4f`) |
| **Blocks** | TASK-845 (the unified console screen) |
| **Target branch** | `dev-2.2` (orchestrator merges) |
| **Migration** | `20260901061912_task_844_ai_routing_policy_absorption` |
| **Date** | 2026-09-01 |

---

## ⚠ Owner reversal on record — OD-3 (2026-09-01)

**TASK-816's owner decision that `AiTaskDefault` survives is explicitly reversed.**
`AiTaskDefault` is absorbed into `AiRoutingPolicy` and retired. **This ticket is the
instrument of that reversal.** The reversal is recorded in the program document §1 (OD-3),
restated here, and restated a third time in the schema itself — on the RETIRED banner at the
top of `ai-task-default.prisma` and in the header of `ai-routing-policy.prisma` — so a reader
who arrives at any one of those three places learns it without having to find the other two.

---

## 1. Requirement Analysis

The product requires a **provider configuration** to be a first-class thing an administrator
can create, order, elect, promote between tenants, and export. Concretely:

| Requirement | Where it landed |
|---|---|
| Many provider configurations per task | The re-grain: one row = one configuration (§3.1) |
| **Exactly one may be the platform default per task** | A PostgreSQL **partial unique index** (§3.2) |
| Setting a second must be refused, or atomically unset the first | `setDefault` in one `runInTransaction` (§3.3) |
| Tenant admins BYO-key; the SYSTEM row is the fallback | Cascade preserved unchanged (§3.5) |
| Promote a configuration from one tenant to another | `promote` — **without the credential** (§3.6) |
| Export/import as JSON with secrets masked and never fully exportable | `exportConfigurations` / `importConfigurations` (§3.7) |
| Each agent node binds to exactly ONE provider configuration | The row is now addressable by id, which is what makes that binding possible for Track D |

---

## 2. Current State Evaluation

### 2.1 The facts this was built on

**F-6 — the provider-configuration unit did not exist as a row.** It was a chain joined by
**strings, not foreign keys**: `AiTaskDefault (taskKey → modelSlug)` ⋈ `AiModel (slug →
provider)` ⋈ `AiProviderConnection (service + provider)`. Nothing could name a configuration,
report on it, or constrain it.

**F-7 — "one default per task" was structurally impossible.** `AiTaskDefault` carried
`@@unique([tenantId, taskKey])` — exactly one row per task. There was nowhere to put a second
candidate and therefore no election to hold.

**F-8 — `AiRoutingPolicy` was shipped, migrated, admin-exposed, and had ZERO runtime readers.**
Confirmed against the dev DB: **zero rows** as well. That is what made an in-place re-grain
safe rather than reckless — there was no behaviour to break and no data to lose.

**F-26 — `taskKind` is COARSER than `taskKey`.** The program document's original design called
for a partial unique index on `(tenantId, taskKind)`. That would have been a data-losing bug;
see §3.2.

### 2.2 What the old grain was

TASK-818 shipped `AiRoutingPolicy` as **one row per authored POLICY REVISION**, keyed
`@@unique([tenantId, taskKey, policyVersion])`, with the entire ordered candidate chain buried
in a `candidatesJson` array. That grain cannot satisfy the requirement: a JSON array element
cannot carry a foreign key, cannot be indexed, cannot be promoted between tenants row-by-row,
and cannot be constrained to "exactly one default".

---

## 3. Implementation

### 3.1 The re-grain — one row is ONE PROVIDER CONFIGURATION

The ordered chain is now the **SET of rows** sharing `(tenantId, taskKey)`, ordered by
`priority` ascending, with exactly one carrying `isDefault`.

Columns added to `AiRoutingPolicy`:

| Column | Shape | Why |
|---|---|---|
| `providerConnectionId` | `String?` → **FK** `AiProviderConnection.id`, `ON DELETE RESTRICT` | Replaces the `(service, provider)` string join |
| `modelId` | `String?` → **FK** `AiModel.id`, `ON DELETE RESTRICT` | Replaces `AiTaskDefault.modelSlug`'s by-slug reference |
| `modelRef` | `String?` | The provider-side model id on the wire (Azure DEPLOYMENT, GGUF id) when it differs from the catalogue slug |
| `isDefault` | `Boolean @default(false)` | The election |
| `enabled` | `Boolean @default(true)` | Park a candidate without destroying it |
| `residency` / `baaCovered` | `String?` / `Boolean?` | Promoted OUT of the JSON candidate; the §3A.4 gates read them, and a gate input in unindexed JSON cannot be reported on or constrained |
| `configJson` | `Json?` | Absorbed verbatim from `AiTaskDefault.configJson` |
| `displayName` | `String?` | What an admin sees in the picker; what an export artifact is identified by |

Changed: `candidatesJson` is now **nullable and deprecated** — retained only so a pre-844
revision stays readable, never written, never read by the resolver. `@@unique([tenantId,
taskKey, policyVersion])` is **dropped**: it was correct at the old grain and is wrong at this
one, because many rows now legitimately share `(tenantId, taskKey)`.

Both FKs deliberately carry no tenant column, because a TENANT row must be able to bind a
SYSTEM catalogue model — that inheritance *is* the two-tier cascade. Tenancy is enforced by the
tenant-scope extension and the service, not by the FK.

### 3.2 ⚠ The election keys on `taskKey`, NOT `taskKind` (F-26)

```sql
CREATE UNIQUE INDEX "AiRoutingPolicy_tenant_task_default_unique"
ON "core"."AiRoutingPolicy" ("tenantId", "taskKey")
WHERE "isDefault" = true AND "resourceStatus" != 'DELETED';
```

`taskKind` is deliberately coarser than `taskKey`. **Measured on the real seeded data, four
distinct kinds each hold more than one elected default:**

```
      taskKind       | defaults_for_this_kind |                        keys
---------------------+------------------------+----------------------------------------------------
 TEXT_GENERATION     |                      4 | harness.judge, text.finalize, text.live, text.test
 TEXT_CLASSIFICATION |                      2 | nlp.classification, nlp.diagnosis
 CONTENT_SAFETY      |                      2 | guardrail.safety, guardrail.validate
 PII_DETECTION       |                      2 | guardrail.pii, guardrail.pii.spans
```

A `(tenantId, taskKind)` index would have made every one of those pairs **mutually exclusive** —
a tenant could not hold a default for both `text.live` and `text.finalize`, nor for both
`nlp.ner` and `guardrail.pii` (same `TOKEN_CLASSIFICATION` shape, different models, different
governance). **The election is per SELECTION, not per kind.**

Two further details that are load-bearing:

- **`resourceStatus != 'DELETED'`** is what makes soft delete work. Without it the first
  deletion would permanently occupy the slot and block re-election. Proven in §5.
- **It is in the DATABASE, not only the service.** A service-level guard alone is precisely
  what produced F-7. Prisma's DSL supports neither partial nor filtered unique indexes, so it is
  hand-written — the same mechanism and predicate shape as
  `WorkflowDefinition_tenant_slug_active_unique` (TASK-734), this repo's precedent for that gap.
  **Verified: it causes no `migrate diff` drift** (§5).

### 3.3 Election semantics — atomic, idempotent, and refusing the incoherent

`setDefault(id, tenantId, expectedVersion)` runs `clearDefaultFor` and then the set **inside one
`runInTransaction`**, in that order. Both halves matter:

- **One transaction**, because model selection is `failMode: closed`. Two writes would leave a
  window in which the selection has NO default, and that window is an outage rather than a
  degraded state.
- **Clear before set**, because the partial unique index is evaluated at statement end. The
  reverse order would put two rows at `isDefault = true` at exactly that moment. A test asserts
  the invocation order rather than merely the outcome.
- **Concurrency is settled by the database**, not by the service: two administrators electing
  different rows cannot both win — one commits, the other is refused.

Re-electing the current default is a **no-op that still returns 200** and does not bump
`_version`: this is an idempotent administrative assertion ("make this the default"), not a
toggle. Electing a **disabled** candidate is refused (400) — a default the resolver then skips
is a default that defaults to nothing, and it must look misconfigured rather than configured.

`isDefault` is deliberately **absent from the create and update bodies**. Adding it there would
give callers a path that fails intermittently against the index and looks like a database bug.

### 3.4 Resolution — sourced from rows, gates untouched

`getEffective` now reads candidate ROWS and projects them onto the existing `RoutingCandidate`
shape (`provider-configuration.ts#rowToCandidate`), so **`routing-gates.ts` did not change at
all** — the same residency / BAA / cross-funding rules apply, they just read row scalars.

Order of operations:

1. read `[requestTenant, SYSTEM]` ACTIVE + ENABLED + `enabled` rows for the task;
2. pick the winning TIER — tenant on presence, SYSTEM **only on absence**;
3. drop rows whose own `matchJson` predicate the request does not satisfy;
4. **the elected `isDefault` row is the primary**; ordering decides only when no row is elected;
5. derive funding per row through `resolveConnection`;
6. run the three hard gates on every hop, bounded by `fallback.maxDepth`.

Two fail-closed projections, matching what `parseCandidates` did with a malformed JSON
candidate: `baaCovered` NULL becomes `false` (an unanswered question is not a yes), and
`residency` NULL becomes the empty class.

### 3.5 Cascade, veto and funding — preserved exactly

- **Two tiers, request tenant → SYSTEM, widening only on ABSENCE.** A tenant with any live
  configuration has expressed an opinion, so SYSTEM is not consulted even when that tier yields
  nothing servable.
- **`50000000-…` ("Global") never appears.** Two independent guarantees, plus two tests: the
  service hands the repository exactly `[requestTenant, SYSTEM]`, and `AiRoutingPolicy` is a
  SYSTEM-shared read model so the tenant-scope extension itself pins `tenantId IN [caller,
  SYSTEM]`. One test asserts the id never reaches ANY persistence call, not merely that it is
  absent from the response.
- **`AiProviderConnection`'s three states are intact.** Funding still flows through
  `resolveConnection`, which is the only place that implements them, so **disabled = VETO in
  both tiers** still holds. Deriving funding straight off `connection.tenantId` would have got
  the BYOK/CLOUD answer right and silently lost the veto — the FK is used to learn *which*
  provider, and the cascade is still asked *who pays*.
- **Funding is DERIVED, never stamped.** A test pins the case that distinguishes them: a
  SYSTEM-supplied credential on a TENANT-owned configuration row meters `CLOUD`.
- **A configuration served by NO connection still resolves.** The `nlp.*` / `guardrail.*`
  selections run in-process inside `apps/nlp`; they are not "unfunded", they are not
  vendor-paid, and they must keep resolving exactly as they did through `AiTaskDefault`.

### 3.6 Promotion — the configuration crosses, the credential does not

`promote(id, sourceTenantId, targetTenantId)` copies the model binding, ordering, residency
label and BAA assertion, and re-points `providerConnectionId` at the **target tenant's own**
connection for the same `(service, provider)` through the standard cascade. A target with no
such row lands with a NULL connection and must supply one (or inherit SYSTEM's). It never
inherits the source tenant's row, because that row holds the source tenant's key and billing.

It **always lands DRAFT and NOT elected.** Promotion offers a configuration; it does not switch
a tenant's traffic. Landing it elected would silently unseat a choice the target tenant made,
on an operation they did not perform. The audit event records `credentialCopied: false`
explicitly, so the absence is a stated fact rather than something a reader has to infer.

### 3.7 Export / import — and a deliberate deviation from the brief

**The brief asked for "a masked hint (e.g. last 4)". The artifact emits no characters of any
credential at all.** This is a considered deviation, recorded here and in the module header:

- the credential is Vault-Transit **ciphertext**, so producing a last-4 would require
  **decrypting a live key** on a path whose entire purpose is to not handle key material; and
- **a last-4 is not a mask, it is a partial disclosure.** Four known characters shorten a brute
  force, and vendor keys carry structured prefixes, so the tail is often the highest-entropy
  part. On a PHI platform that is a credential leak with a friendly name.

What an operator actually needs is *which* secret, not what it looked like. So each
configuration carries a **`credentialRef` LOCATOR** — `vault-transit:<service>:<provider>:v<n>`,
built only from capability, provider name and the platform-assigned key **version** — plus
`hasCredential`. Together they say "this needs the Azure key you know as v3" without revealing
one byte of it.

Enforcement is structural, not editorial. `assertNoSecretMaterial` walks the **finished**
artifact at every depth, refuses a deny-list of credential-shaped keys, and refuses raw binary
outright (`Uint8Array`/`Buffer` is checked **before** the object branch — `typeof new
Uint8Array() === 'object'`, so checking it later lets ciphertext through as an object of numeric
keys, which is exactly the shape a leaked `encryptedApiKey` serializes to). A test proves the
guard is not vacuous by adding a secret field and watching it throw.

Import lands every row **DRAFT and NOT elected**, matches models by SLUG on the two-tier cascade
(a slug that resolves to nothing is **SKIPPED, never guessed** — selection is fail-closed), and
returns `requiresCredential` so a missing key is stated at import time rather than discovered as
a 503.

### 3.8 The staged retirement of `AiTaskDefault`

Dropping the table in this change would stop day-1 inference. A census of every runtime reader
found:

- **11 TypeScript runtime resolvers**, most of them fail-closed — harness policy resolution (all
  Temporal node types), consultation NER (sync summary + live-doc), the prompt-template Test
  button, the Agent Playground NER/diagnosis tab, and the `models.*` settings facade; and
- **`apps/guardrail`**, which reads `core."AiTaskDefault"` ⋈ `core."AiModel"` over its **own
  read-only SQL connection** (`core/tenant_config.py`, the sanctioned peer-service exception) —
  a **cross-language** reader that no TypeScript change can repoint, and which is load-bearing
  for every safety-plane request.

So the table survives one release as a read-compatibility projection, and
`AiTaskDefaultService.upsertRow` now **WRITES THROUGH**: the `AiTaskDefault` row and its
`AiRoutingPolicy` counterpart are written **in one transaction**, so they cannot drift. This is
a strangler-fig transition with a stated end condition, not a second home for the data. The end
condition is written into the schema banner (§I of the handoff below).

The projection resolves the slug to a catalogue FK **at write time** — the by-slug join F-6
named, performed once instead of on every read.

### 3.9 Findings repaired in passing

**F-844-A — TASK-843's `taskKind` had no writer.** TASK-843 added the column and backfilled the
dev DB through a side-car script, but taught neither `seedAiTaskDefault` nor
`AiTaskDefaultService.upsertRow` to write it. **Verified on a freshly seeded shadow DB: all 12
rows landed `taskKind = NULL`.** A straight copy would have propagated 12 unclassified rows into
the table that is now the source of truth. Repaired three ways: the migration derives with
`COALESCE`, the seed writes it, and the service derives it on every write.

**F-844-B — `priority` is redefined, deliberately.** TASK-818 used it as a policy-level
tie-break where HIGHER won. At this grain it is the **chain position**, replacing the old
candidate `rank`, so **LOWER serves first**. Safe to redefine because the table had zero runtime
readers and zero rows; recorded here, in the schema, and in a test whose name states it.

**F-10 — five stale `*_API_KEY` comments deleted.** Each was verified against the code that
would have to implement the fallback; in every case the fallback is gone AND the file already
says so a few lines later, which is what makes them actively misleading rather than merely out
of date:

| File | Claimed |
|---|---|
| `apps/stt/src/stt/models/sarvam_loader.py:4` | "then `SARVAM_API_KEY` env" — contradicted by its own class comment at `:42` |
| `apps/stt/src/stt/models/openai_loader.py:4` | "then `OPENAI_API_KEY` env" — same contradiction at `:38` |
| `packages/database/…/seed/06-stt.ts` (×2) | "or SARVAM_API_KEY env" / "or OPENAI_API_KEY env" |
| `apps/api/src/modules/text-compat/text-compat.controller.ts:195` | "absent ⇒ TEXT uses its platform `TEXT_SARVAM_API_KEY`" — `apps/text`'s Sarvam translator is BYOK-ONLY and connection-only, so an absent override FAILS |

---

## 4. Files Changed

**Schema** — `ai-routing-policy.prisma` (re-grain + header rewrite), `ai-task-default.prisma`
(RETIRED banner), `ai-provider-connection.prisma` + `stt.prisma` (back-relations),
`migrations/20260901061912_task_844_ai_routing_policy_absorption/migration.sql` (new),
`seed/16-ai-task-default.ts` (`taskKind` writer), `seed/06-stt.ts` (F-10).

**Domain** — `AiRoutingPolicyModel.ts` / `AiModelModel.ts` / `AiProviderConnectionModel.ts`
(regenerated by `gen:model`); `AiRoutingPolicyEntity.ts` + `AiRoutingPolicyFactory.ts` +
`AiRoutingPolicyRepository.ts` (hand-authored: new fields, revised `validate()`,
`findCandidates`, `clearDefaultFor`); `__tests__/AiRoutingPolicyEntity.test.ts`.

**Applications** — `ai-routing-policy/provider-configuration.ts` (new),
`ai-routing-policy.service.ts`, `IAiRoutingPolicyService.ts`, both request DTOs, the barrel;
`ai-task-default.service.ts` (write-through); both test suites.

**API** — `ai-routing-policy-admin.controller.ts` (four routes);
`text-compat.controller.ts` (F-10). Regenerated: `route-manifest.json`, `openapi.json`,
`admin-console/src/server/api-docs/openapi.{admin,business}.json`,
`vox-node/src/resources/admin/**`.

**Python** — `apps/stt/src/stt/models/{sarvam,openai}_loader.py` (F-10, comments only).

**Docs** — this README + `backfill-dev-db.sql`.

---

## 5. Verification (actual output)

### 5.1 Migration drift — empty

Authored against a throwaway shadow DB (`hope_shadow_844`) with the full ledger replayed, per
`02-database-prisma.md` §Migration Workflow. **The partial unique index causes no drift**, which
is the question that decided whether it could be hand-written at all:

```
$ npx prisma migrate diff --from-config-datasource --to-schema src/prisma/db_main --script
Loaded Prisma config from prisma.config.ts.
-- This is an empty migration.
```

### 5.2 The absorption preserves every row

Ledger replayed to the commit BEFORE this migration, seeded, then TASK-844 applied:

```
########## C. seed (pre-844 schema) — the BEFORE state
        t        | total | with_kind
-----------------+-------+-----------
 AiTaskDefault   |    12 |         0        ← F-844-A: TASK-843's column had no writer
 AiRoutingPolicy |     0 |         0

########## E. AFTER
             t             | total | with_kind
---------------------------+-------+-----------
 AiTaskDefault             |    12 |        12
 AiRoutingPolicy           |    12 |        12
 AiRoutingPolicy isDefault |    12 |

########## F. every absorbed row, with resolved FKs
        taskKey         |         taskKind         |             model_fk             |  conn_fk  | isDefault | status
------------------------+--------------------------+----------------------------------+-----------+-----------+--------
 harness.judge          | TEXT_GENERATION          | lms-gemma-4-e4b                  | lm-studio | t         | ACTIVE
 text.finalize          | TEXT_GENERATION          | lms-gemma-4-e2b-it-qat           | lm-studio | t         | ACTIVE
 text.live              | TEXT_GENERATION          | lms-gemma-4-e2b-it-qat           | lm-studio | t         | ACTIVE
 text.test              | TEXT_GENERATION          | lms-gemma-4-e2b-it-qat           | lm-studio | t         | ACTIVE
 nlp.ner                | NAMED_ENTITY_RECOGNITION | medical-ner                      | —         | t         | ACTIVE
 nlp.classification     | TEXT_CLASSIFICATION      | nlp-doc-type-classifier          | —         | t         | ACTIVE
 nlp.diagnosis          | TEXT_CLASSIFICATION      | symps-disease-bert-v3-c41        | —         | t         | ACTIVE
 guardrail.safety       | CONTENT_SAFETY           | gliguard-llm-guardrails-300m     | —         | t         | ACTIVE
 guardrail.validate     | CONTENT_SAFETY           | granite-guardian-4.1-8b          | lm-studio | t         | ACTIVE
 guardrail.groundedness | GROUNDEDNESS             | minicheck-flan-t5-large          | —         | t         | ACTIVE
 guardrail.pii          | PII_DETECTION            | gliner2-privacy-filter-pii-multi | —         | t         | ACTIVE
 guardrail.pii.spans    | PII_DETECTION            | gliner2-guardrails-pii-multi     | —         | t         | ACTIVE
(12 rows)
```

**All 12 rows preserved. All 12 `modelId` FKs resolved. The five LM-Studio-served GGUF SYSTEM
selections — `harness.judge`, `text.live`, `text.finalize`, `text.test`, `guardrail.validate` —
all carry both FKs**, which is the risk the program document flagged as able to stop day-1
inference. The seven `conn_fk = —` rows are the `nlp.*`/`guardrail.*` selections that run
in-process inside `apps/nlp` and are served by no connection at all; that NULL is the truth about
those selections, not a failed lookup.

Re-running the backfill inserts nothing (`INSERT 0 0`) — it is idempotent.

### 5.3 The constraint is enforced BY THE DATABASE — raw INSERT, not through the service

```
########## I. raw INSERT of a SECOND default for text.live must be REFUSED
ERROR:  duplicate key value violates unique constraint "AiRoutingPolicy_tenant_task_default_unique"
DETAIL:  Key ("tenantId", "taskKey")=(00000000-0000-0000-0000-000000000000, text.live) already exists.

########## J. a NON-default second candidate for the SAME task is ALLOWED
INSERT 0 1
########## K. a TENANT default for the same task is ALLOWED (the index keys on tenantId too)
INSERT 0 1
########## L. SOFT-DELETING the SYSTEM default frees the slot so a successor can be elected
INSERT 0 1
########## M. FK RESTRICT — hard-deleting a bound AiModel must be REFUSED
ERROR:  update or delete on table "AiModel" violates RESTRICT setting of foreign key constraint
        "AiRoutingPolicy_modelId_fkey" on table "AiRoutingPolicy"
```

J, K and L are the cases a naive constraint would have got wrong: the chain still works, the
two tiers stay independent, and soft delete does not permanently block re-election.

### 5.4 Suites

```
@arcaai/database       Test Files  73 passed (73)                Tests  1750 passed (1750)
@arcaai/domains        Test Files 158 passed | 2 skipped (160)   Tests  1881 passed | 2 skipped | 9 todo (1892)
@arcaai/applications   Test Files 626 passed | 1 skipped (627)   Tests 10696 passed | 4 skipped (10700)
@arcaai/api            Test Files 267 passed | 2 skipped (269)   Tests  4109 passed | 4 skipped (4113)
```

Builds: `@arcaai/database`, `@arcaai/domains`, `@arcaai/applications`, `pnpm api:build` — all
clean (`12 successful, 12 total`).

### 5.5 Generator + artifact gates

```
gen:model:check      check: no drift — 180 generated file(s) match the committed files.
gen:entity:check     check: no drift — 103 generated file(s) match the committed files.
                     Schema coverage OK: 101 entity artifact(s) cover every persisted column of 105 Prisma model(s)
gen:factory:check    check: no drift — 103 generated file(s) match the committed files.
                     Schema coverage OK: 101 factory artifact(s) cover every persisted column of 105 Prisma model(s)

api:openapi:check    [openapi-coverage] OK — every served route is either documented or deliberately excluded.
api:portal:check     [gen-api-portal] no drift (admin 627 ops, business 185 ops)
vox-node gen:admin:check  [vox-node-codegen] no drift (52 areas, 408 routes, 372 schemas)
```

All five artifacts were regenerated together (`route-manifest` → 704 routes, `openapi` → 484
paths, `portal`, `gen:admin` → 55 files) before the three `:check` gates were run.

### 5.6 Lint

`@arcaai/domains` 0 errors, `@arcaai/applications` 0 errors, `apps/api` 0 errors. The files this
ticket authored lint clean with no warnings. Remaining warnings across those packages are
pre-existing (`eslint-comments/require-description` on generated-file headers).

---

## 6. Change History

| Date | Change |
|---|---|
| 2026-09-01 | Ticket opened and completed. Re-grained `AiRoutingPolicy`, absorbed all 12 `AiTaskDefault` rows, added the DB-enforced election, promotion, and secret-free export/import. Recorded F-844-A, F-844-B; repaired F-10. |
