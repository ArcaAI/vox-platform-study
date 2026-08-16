# TASK-712 — Consent Domain Design

| | |
|---|---|
| **Status** | Draft — working design for a REDUCED-SCOPE execution pass. Not owner-approved (no compliance/product sign-off obtained; this is a subagent-authored engineering design produced under explicit orchestrator scoping, not a substitute for the Phase 0 T4 design-gate the full ticket calls for). |
| **Scope of this pass** | Consent domain (model + domain trio) and the `assertConsent` ABAC evaluation path, plus their tests. **No enforcement is wired anywhere** — no guard registration, no route decorators, no harness/Temporal wiring, no CASL changes, no seeds. See §7 for the exact boundary and rationale. |

This document exists to satisfy Task 1 of the ticket plan to the extent the reduced scope requires:
it records the decisions actually needed to build the model and the evaluation path honestly,
and it explicitly defers or flags every decision that requires a compliance/product owner or a
live database the author does not have in this session.

---

## 1. Model shape

Adopted the ticket's proposed per-purpose-row shape verbatim (§4 Task 1 of the README), with the
recommendation the ticket itself favors:

```prisma
model ConsentGrant {
  // meta fields
  metaData Json?  @map("_metadata") @db.JsonB
  version  Int    @default(1) @map("_version")
  id       String @id @default(uuid(7))

  // multi tenant fields
  tenantId String

  // core (business) fields
  externalPatientId String
  purpose           ConsentPurpose
  scope             Json?              @db.JsonB
  grantedAt         DateTime
  grantedBy         String
  grantMethod       ConsentGrantMethod
  evidenceRef       String?
  expiresAt         DateTime?
  revokedAt         DateTime?
  revokedBy         String?
  revocationReason  String?

  // resource status fields
  resourceStatus          ResourceStatusType @default(ENABLED)
  resourceStatusUpdatedAt DateTime?
  resourceStatusUpdatedBy String?

  // audit fields
  createdBy String?  @default("60000000-0000-0000-0000-000000000000")
  updatedBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([tenantId, externalPatientId, purpose], map: "ConsentGrant_tenant_patient_purpose_key")
  @@index([tenantId], name: "ConsentGrant_tenantId_idx")
  @@index([tenantId, externalPatientId], name: "ConsentGrant_tenant_patient_idx")
  @@schema("core")
}
```

**Trade-off record (Q4, HUMAN-GATED — recommendation only, not a decision):**

| | One row per purpose (adopted here) | One row, `purposes[]` array (04-target-architecture) |
|---|---|---|
| Per-purpose expiry/revocation (INV-342) | Native — each row has its own `expiresAt`/`revokedAt` | Requires per-element metadata inside the array, or a parallel structure |
| Row volume | One row per (tenant, patient, purpose) — bounded by the fixed purpose vocabulary (§2), so at most 5 rows per patient today | One row per patient |
| Query shape | `assertConsent` is a single-row point lookup on the unique index | Requires an array-containment query plus per-purpose metadata lookup |
| Widening (INV-016/197) | A new row version via `updateWithVersion`; the OLD grant's history is visible in `AuditLog` | Same, but harder to express "widen only this purpose" without touching the whole array |

The per-purpose shape is recommended and is what this pass implements, because §2's purpose
vocabulary is small and fixed and INV-342 explicitly requires per-purpose time-limiting. A product/
compliance owner can still choose the array form later — it is a migration, not a refactor, per the
ticket's own framing.

## 2. Purpose vocabulary

`ConsentPurpose`: `AI_DOCUMENTATION | HISTORY_RETRIEVAL | EXTERNAL_TOOL_LOOKUP | STYLE_LEARNING | QUALITY_REVIEW`
— adopted verbatim from the ticket (§4 Task 1 item 2), each justified against an invariant there.
**HUMAN-GATED**: this is a recommendation, not a ratified vocabulary. Compliance may want a finer
or coarser split (e.g. splitting `HISTORY_RETRIEVAL` by source system).

`ConsentGrantMethod`: `VERBAL_ATTESTED | WRITTEN | PORTAL | IMPORTED` — adopted verbatim.
`IMPORTED` exists specifically so a future legacy-backfill (Q2) has a truthful method value to
stamp, without this ticket choosing to run one.

## 3. Scope semantics

`scope` is a nullable JSONB bag. This pass defines the shape but does not implement scope-narrowing
comparison logic beyond a simple structural containment check (`coversScope`, entity method — see
`consent-design.md` §6 for exactly what it does and does not do):

```jsonc
// HISTORY_RETRIEVAL example
{ "dateRangeDays": 365, "sourceSystems": ["EHR-A", "EHR-B"] }
```

`coversScope(requested)` on the entity returns `true` when every key present in `requested` is
present in the grant's own `scope` and, for `dateRangeDays` specifically, the grant's value is
`>=` the requested value (wider window covers a narrower request). Any other key is compared for
strict equality. This is intentionally minimal — a general partial-order scope algebra is out of
scope for this pass; the ticket's INV-016/197 (widening is a new, audited grant, never a mutation)
is honored structurally by `revoke()` never touching `scope` and `ConsentGrantService.create()`
being the only writer of a new row's `scope`.

## 4. Choke-point transport

**Not decided by this pass — no HTTP hop exists yet because nothing calls `assertConsent` from any
production path.** The ticket's own analysis (§4 Task 1 item 4) is sound and is recorded here for
the phase that DOES wire enforcement:

- (A) Gateway-internal endpoint (`POST /api/v1/internal/consent/assert`), (B) injected snapshot,
  (C) peer-service DB read. **Recommended: A + B hybrid** — snapshot at workflow start for the fast
  path, re-assert over (A) at every gated stage, tenant-keyed cache with Redis invalidation
  (`arca:consent:invalidate`), fail-closed on an unreachable endpoint.

This pass builds only the in-process piece of (B)/(A)'s shared foundation: `assertConsent` /
`checkConsent` in `packages/applications`, with a tenant-keyed, TTL-bounded in-memory cache
invalidated via `EventEmitter2` on grant/revoke (the `OriginRegistryService` precedent for
within-node invalidation — see `.claude/rules/09-infrastructure-devops.md` §Config caches). A
cross-process Redis channel is NOT wired — there is no second process to invalidate yet (no
gateway-internal endpoint, no harness client). Building it now would be untested scaffolding.
Flagged as a concrete follow-up in §7.

## 5. Revocation semantics

`revoke()` sets `revokedAt`/`revokedBy`/`revocationReason` via `setProperty` (change-tracked,
OCC-written through `updateWithVersion`) and does not delete the row — the grant's full history
stays in `AuditLog` via the standard sys-event. `assertConsent`/`checkConsent` treat
`revokedAt !== null && revokedAt <= now` as a denial, same as an expired or absent grant.

**Q5 (HUMAN-GATED, unchanged from the ticket):** whether an in-flight capture is torn down on
revocation is not decided here — no capture-teardown code is touched by this pass at all (Phase 3/4
enforcement is out of scope), so the question does not yet have a code path to answer it. Default
assumption for whoever builds that phase: new gated calls denied from `t_revoke`, in-flight capture
allowed to reach `DRAINING`, per the ticket's stated default.

## 6. WORM ledger decision (Pitfall 1 / R2) — DEFERRED, not implemented

Re-examined against the actual code, not just the ticket's description:

- `HarnessAuditEvent.consultationId` is `String` (NOT NULL) and is a hash input
  (`packages/domains/src/utils/harnessAuditHash.ts:19`).
- `AppendHarnessAuditInput` (`packages/applications/src/services/harness-audit/harness-audit.service.ts`)
  additionally requires `modelName: string`, `modelVersion: string`, `sensorScores: JsonValue`,
  `citations: JsonValue` — fields that model an **AI generation event** (which model produced what,
  scored how), not a **human consent action** taken by a clinician or admin. A grant/revoke has no
  model, no sensor scores, no citations.

Shoehorning `ConsentGrant` create/revoke into this ledger would mean (a) inventing sentinel values
for four fields that don't apply, compromising the ledger's meaning for every real reader of it, AND
(b) touching a NOT-NULL, hash-chained column with no way to prove — outside a live database with
real historical rows — that the change is byte-compatible with every existing chain. The ticket's
own Pitfall 1 requires exactly that proof before Task 3 may touch the column, and this session has
no database.

**Decision for this pass: `ConsentGrant` create/revoke do NOT write to `HarnessAuditEvent`.** They
use the standard `AuditLog` sys-event pipeline every other application service uses
(`.claude/rules/04-application-services.md` canonical CRUD flow —
`broadcastSysEvent(SysEventType.ResourceCreated/ResourceUpdated, …)`), which already gives an
immutable-enough (append-only `AuditLog` table, no UI update path) record of every grant/revoke
without touching the WORM chain's schema or write path.

**Consequence, stated plainly:** `HarnessAuditAction.CONSENT_GIVEN` / `CONSENT_WITHDRAWN` are
**still dead** after this pass — they gain no writer here. The acceptance criterion in the full
ticket that expects them to have "real writers" is **not met by this reduced-scope pass**; §7 and
the ticket README's Implementation Summary say so explicitly rather than claiming otherwise.

Whoever resolves this properly should decide between: (a) making `consultationId` nullable with the
byte-identical-serialization proof the ticket demands, re-run against a real chain of pre-existing
rows on a live database, or (b) a second, purpose-built WORM ledger for non-generation clinical/
compliance events (grant, revoke, override) that doesn't force AI-generation fields onto a human
action. This document does not pick between them — that is exactly Pitfall 1's HUMAN/DB-gated call.

## 7. Boot-audit rule — NOT BUILT (no guard exists to audit coverage of)

The ticket's Task 11 boot-time coverage audit checks that every consultation/`patientId` route
declares `@RequiresConsent` or `@ConsentExempt`. Building that audit presupposes the decorator and
guard exist and are registered — Phase 3 is out of scope for this pass, so there is nothing to
audit yet. Not built.

---

## Summary: what this pass actually ships vs. defers

| Ticket item | This pass |
|---|---|
| `ConsentGrant` model, enums, migration (authored) | **Built** — `packages/database` |
| Domain trio (entity/factory/mapper/repository) | **Built** — `packages/domains` |
| `ConsentGrantService` (admin CRUD) | **Built** — `packages/applications` |
| `assertConsent`/`checkConsent` choke point, fail-closed, tenant-keyed cache | **Built** — `packages/applications` |
| `ConsentDeniedException` (403-mapped) | **Built** — `packages/exceptions` + `apps/api` interceptor mapping (mapping only; nothing throws it in a live request path yet) |
| `@RequiresConsent`/`PatientConsentGuard`, guard registration in `app.module.ts` | **NOT built** — enforcement wiring, explicitly out of scope |
| Route decoration on consultation controller | **NOT built** |
| Boot-time consent-coverage audit | **NOT built** (nothing to audit) |
| Gateway-internal assert endpoint + harness Python client + activity gating | **NOT built** |
| CASL condition-evaluation fix (Phase 5) | **NOT built** — independently scoped, platform-wide blast radius, needs its own design gate |
| Seeds (legacy posture) | **NOT built** — this is exactly Q2, HUMAN-GATED, not chosen |
| E2E specs (`consent-abac.spec.ts`) | **NOT built** — requires the guard to exist and a live API/DB |
| WORM `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` writers | **NOT built** — deferred per §6 |

## The legacy-consent posture (Q2) — the single explicit switch

This pass makes **no** legacy-consent decision and seeds **no** legacy grants. Because no
enforcement is wired, `assertConsent` denying every unGranted `(tenant, patient, purpose)` —
including every pre-existing consultation — has **no observable effect yet**: nothing in a request
path calls it. The risk the ticket names ("fail-closed on day one would brick every existing
chart") is a property of Phase 3/4 (enforcement), not of this pass.

The switch point for whoever wires enforcement: `assertConsent` must stay fail-closed with **no**
built-in legacy exemption (per §3.2 of the ticket — "fail-closed by construction, not by
configuration", and a kill-switch must default OFF, which for an exemption would mean defaulting
the gate OPEN — exactly the outcome that must not happen by accident). The legacy posture belongs
as **one** `SettingsRegistry` descriptor (`.claude/rules/09-infrastructure-devops.md` §Configuration
Tiers, `redis-flag` tier, mandatory `failMode`, default OFF) consulted at a single call site inside
`assertConsent`/`checkConsent` — e.g. `consent.legacyExemptionEnabled` (boolean, default `false`)
plus `consent.legacyExemptionCutoverAt` (timestamp, default unset). While OFF (the shipped default),
behavior is unchanged: fail-closed, no exemption. Turning it ON is the explicit, auditable,
single-flip decision Q2 asks a compliance owner to make — implemented as a follow-up once Phase 3/4
exists to make the decision observable at all. **Not implemented in this pass** — documented here so
the switch has exactly one place to be added rather than being improvised at seed time.

## Secondary open questions (flagged, not resolved)

Restated from the ticket's §6, unchanged by this pass, because nothing in this pass touches them:

- **Q1 — patient-facing surface.** No patient app exists. This pass's `ConsentGrantService` is
  clinician/admin-recorded only (`grantMethod` + optional `evidenceRef` capture provenance).
  Whether that satisfies "the patient must be able to act directly, without a proxy, where
  regulation requires it" (INV-342/344) is a compliance judgement this pass does not make.
- **Q3 — `externalPatientId` normalization.** Implemented as trim-only, exact-case match, in one
  shared function (`normalizeExternalPatientId`, `packages/applications/src/services/consent/`) —
  the ticket's stated default. Case-folding is NOT applied. A mismatch fails closed (denied); the
  denial reason surfaces the normalized value that was looked up so support can diagnose a case/
  whitespace mismatch.
- **Q4 — granularity.** See §1 — per-purpose rows implemented as the recommendation, not ratified.
- **Q5 — revocation grace / in-flight teardown.** See §5 — no code path exists yet to answer it.

## CASL blast-radius survey (Task 2)

**Not produced in this pass.** It requires a live database query
(`SELECT … FROM core."Policy" …`) this session cannot run, and Phase 5 is independently scoped and
explicitly deferred (§7 above). `docs/implementation/TASK-712-Consent-Abac/casl-blast-radius.md` is
NOT created here — creating a partial version without the live query output would be worse than
not creating it, per the ticket's own evidence rule ("done" without pasted output is not accepted).
