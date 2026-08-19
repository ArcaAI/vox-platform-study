# Tenant authoring boundary — proposal for TASK-719 and its follow-ups

| | |
|---|---|
| **Status** | PROPOSAL — needs the owner's decision before Batch 2 builds on it |
| **Date** | 2026-08-17 |
| **Origin** | Owner directive on TASK-719: *"ensure the flexibility of platform where tenant admins and end-users with privilege can manage: agents, workflows, rules, etc. Especially we need to allow tenant admin to define context schema, where the developer can integrate with our system to develop feature and functions for a specific tenant. SDK need to be updated/upgraded also. This is a big task, you can create follow-up tickets."* |

## 1. The one question this document exists to settle

Four separate tickets have each stopped at the same missing concept, from different directions:

| Ticket | Where it stopped |
|---|---|
| **715** | `configSchema` per node type was never delivered — three tickets name it, none owns it |
| **716** | Validator rules are hardcoded and permanently DRAFT; there is no rules-as-data model |
| **719** | Studio's inspector cannot generate a config form without a schema to generate it from |
| **731** | Consultation nodes need per-node config the palette cannot express |

They are one question: **what may a tenant define, in what language, and what validates it?** Answer it once and all four unblock. Answer it four times and the platform grows four incompatible mini-schemas.

## 2. Proposed answer — one schema mechanism, three consumers

A single **JSON Schema**-based definition mechanism, stored in the database, tenant → SYSTEM
resolved, consumed by three surfaces that must never disagree:

```
        ┌──────────────────────── SchemaDefinition (DB, versioned, tenant→SYSTEM)
        │
   ┌────┴─────┐        ┌──────────────┐        ┌─────────────┐
   │  Backend │        │ Admin-Console│        │     SDK     │
   │ validate │        │ render form  │        │ typed client│
   └──────────┘        └──────────────┘        └─────────────┘
   authoritative        generated, never        generated types,
   rejection            hand-written             never hand-written
```

Three schema KINDS, one mechanism:

| Kind | Defines | Who authors | Precedent to follow |
|---|---|---|---|
| `NODE_CONFIG` | the config accepted by one workflow node type | platform (SYSTEM rows) | the node registry's existing `NodeSpec` |
| `CONTEXT` | the shape of a tenant's consultation context — **the owner's headline requirement** | tenant admin | `ContextSchema` work already seeded day-1 |
| `RULE` | a validator rule expressed as data rather than code | platform authors, doctors review | TASK-716's `rule-catalogue.ts`, promoted from code to rows |

## 3. Why this shape

- **It is already half-built.** A context-schema plane was seeded day-1 and there is an
  `AiTaskDefault`-style tenant → SYSTEM cascade to copy. This is consolidation, not invention.
- **It satisfies the configuration rule.** Schemas are configuration: they live in the database,
  resolve tenant-first, and never appear as env vars or code literals.
- **It makes the integration requirement real.** "A developer integrates against a specific
  tenant's shape" only works if the shape is machine-readable and the SDK can emit types from it.
  Hand-written SDK types would drift the first time a tenant edited anything.
- **It gives the doctors something to review.** Rules as versioned rows can be enabled, disabled and
  reviewed without a redeploy — which is what "a team of doctors will review" presupposes.

## 4. Boundary — what a tenant may and may not do

The flexibility the owner asked for stops where safety or tenancy begins.

| A tenant admin MAY | A tenant admin MAY NOT |
|---|---|
| Define and version its own `CONTEXT` schema | Author or disable a `RULE` (platform + clinical review own these) |
| Author, publish and version workflows from the node palette | Add a node TYPE, or edit a `NODE_CONFIG` schema |
| Configure agents, prompts, and per-task model selection (BYO) | Escape validation — publish is gated on `compile()` + `validate()` |
| Grant a privileged end-user the same authoring rights | Grant rights it does not itself hold |

Two invariants that are not negotiable: publish stays gated on the validator, and a tenant's schema
is never visible to another tenant. Cross-tenant reads keep the 404-over-403 posture.

## 5. Proposed ticket split

| Ticket | Scope | Depends on |
|---|---|---|
| **719** (existing, rescoped) | Studio UI only — authoring, versioning, publish, inspector forms *generated from* schemas | 741 |
| **741** (new) | The schema plane: `SchemaDefinition` model + domain quartet + admin CRUD + tenant→SYSTEM resolver + `NODE_CONFIG` population for every existing node | — |
| **742** (new) | Tenant-defined `CONTEXT` schemas: authoring surface, versioning, validation-on-write, migration of the day-1 seeded schema | 741 |
| **743** (new) | SDK upgrade: generated types from a tenant's published schemas, typed context read/write, versioned client | 741, 742 |
| **744** (new) | Rules-as-data: promote `rule-catalogue.ts` into `RULE` rows, admin enable/disable, re-validation sweep of published definitions — this is TASK-716's unfinished governance half | 741 |

Numbers 741–744 are proposals; 740 is already proposed for the `smr` task-key defects. None is
opened until the owner confirms.

## 6. What I need decided

1. **Approve or amend the boundary in §4** — particularly whether a tenant admin may author RULES.
   Recommendation: no. A tenant authoring its own clinical-safety rules defeats the review that
   makes the AI-authored rule set acceptable in the first place.
2. **Approve the ticket split in §5**, or say if 719 should stay one large ticket.
3. **Confirm `CONTEXT` schema versioning semantics**: when a tenant edits its context schema, do
   in-flight consultations keep the old version (recommended — mirrors how loop config is pinned at
   workflow start) or adopt the new one?
