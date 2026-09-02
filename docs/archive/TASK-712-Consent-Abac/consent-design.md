# TASK-712 — Consent Domain Design

| | |
|---|---|
| **Status** | Pass 3 — non-HTTP enforcement (Phase 4), the WORM ledger writer, and Phase 6's dedicated seed file are now built (see §8 below). Phase 5 (CASL) remains untouched, per explicit instruction. Still not owner-approved in the formal Phase-0 T4 sense (no compliance/product sign-off obtained beyond the answers the owner already recorded in the ticket README §6); this remains a subagent-authored engineering design. |
| **Scope of Pass 1** | Consent domain (model + domain trio) and the `assertConsent` ABAC evaluation path, plus their tests. No enforcement was wired anywhere in Pass 1. |
| **Scope of Pass 2** | The partial-unique-active-grant index fix, the legacy-grant backfill (Q2 option (a)), `@RequiresConsent`/`@ConsentExempt` + `PatientConsentGuard` registered as an unconditional `APP_GUARD`, route decoration on the four named gated stages' HTTP surface, a narrowed boot-time coverage audit, the admin CRUD controller, `ConsentUnavailableException` (R4), and e2e coverage. **Documentation note (disclosed, not fixed here):** Pass 2's own summary (ticket README §7) refers to a "Pass 2 Addendum below" in this file; no such section was ever written — this is a pre-existing gap in Pass 2's documentation, left as-is (out of Pass 3's scope) rather than reconstructed after the fact from memory. |
| **Scope of Pass 3 (this update)** | §8 below: the WORM `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` writers (Pitfall 1 resolved as option (a) — nullable `consultationId`, hash-compatibility proven), the gateway-internal `/internal/consent/assert` endpoint, the harness `ConsentClient` + activity gating (`call_mcp_tool`/`retrieve_context`), and the dedicated `22-consent-grant.ts` seed. CASL (Phase 5) untouched. |

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

## 6. WORM ledger decision (Pitfall 1 / R2) — RESOLVED in Pass 3, see §8.1

The analysis below is Pass 1/2's original reasoning, kept for the record. Pass 3
(§8.1) picked option (a) from the closing paragraph — nullable `consultationId`,
with the hash-compatibility proof this section says is required — now that a
live database is available in this session.

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
Still true in Pass 3 — CASL (Phase 5) was not touched, per explicit instruction to keep it staged
and separate (owner R1 answer: shadow → measure → enforce, never in the same change as enforcement).

---

## 8. Pass 3 (2026-08-16) — Phase 4, WORM ledger writer, Phase 6 seed

Scope: the three items §7's "remaining" list named — non-HTTP enforcement, the WORM ledger writer,
and the dedicated seed file. Live infra (Postgres, Redis, Temporal, Vault, MinIO, Qdrant) was up
this pass, which is what makes §8.1 possible (Pass 1/2 explicitly could not do this without a
database).

### 8.1 WORM ledger writer — option (a), nullable `consultationId`

Chose option (a) from §6's closing paragraph over option (b) (a second ledger), for one reason: the
hash function's own construction makes it a genuinely SAFE, additive change, not a risky one.
`computeHarnessAuditHash` folds `consultationId` into the canonical digest via
`input.consultationId ?? null`. For every row that already exists, `consultationId` is a non-null
string, and `x ?? null` for a non-null `x` is `x` — so the digest is **byte-identical** for every
historical row, unconditionally, not just "expected to be." This is proven, not asserted: a fixed
golden-hash literal (`packages/domains/src/utils/harnessAuditHash.test.ts`,
`describe('computeHarnessAuditHash — nullable consultationId (TASK-712)')`) computed against a fixed
input, asserting the exact same SHA-256 hex string the pre-change algorithm would have produced.
Option (b) was rejected: it would create a SECOND ledger implementation in a second place, exactly
the fragmentation the assessment (§3.2 "one choke point") warns against, for a problem the additive
nullability already solves cleanly.

**What changed:**
- `harness.prisma`: `HarnessAuditEvent.consultationId String` → `String?`. Migration
  `20260816100536_task_712_consent_grant_worm_writer` — a single `ALTER COLUMN … DROP NOT NULL`,
  proven empty-diff against a throwaway `hope_shadow` database (`npx prisma migrate diff
  --from-config-datasource --to-schema src/prisma/db_main --script` → `-- This is an empty
  migration.`, run twice: once before and once after a concurrent sibling session (TASK-711) landed
  its own unrelated migration in the same file — both proofs came back empty).
- `HarnessAuditEventEntity.validate()`: the `consultationId` required-check is now conditional —
  waived ONLY for `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` (`ACTIONS_WITHOUT_CONSULTATION`), a named,
  narrow exception, not a general relaxation. Every other action (`GENERATE`, `ATTEST`, ...) still
  requires one.
- `ConsentGrantService.create()`/`revoke()` now append a `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` row via
  `HarnessAuditService` (optional + trailing DI, mirroring `SummaryService`'s existing `ATTEST`
  wiring) — `consultationId: null`, and `modelName`/`modelVersion`/`sensorScores`/`citations` carry
  the SAME sentinel shape `SummaryService.approveSummary` already uses for `ATTEST`
  (`modelName: 'clinician-attestation'`-style — here `'consent-administration'`/`'v1'`/`{}`/`[]`) —
  reusing an established precedent for "a human action recorded on a ledger built for model runs,"
  not inventing a new one.
- **Fail-closed posture, explicitly a trade-off, matching the ATTEST precedent it mirrors:** the WORM
  append happens AFTER the `ConsentGrant` row is already persisted; if the append throws, `create()`/
  `revoke()` rejects — the caller sees a failure — but the grant row itself is NOT rolled back (no DB
  transaction wraps both writes, same as `SummaryService`'s existing SIGNED_NOTE → ATTEST sequence).
  This is disclosed, not hidden: a WORM outage means a grant is recorded but its ledger entry visibly
  failed (the caller's error surfaces it), rather than the grant silently succeeding with no audit
  trail at all.
- Downstream typing fallout fixed: `AppendHarnessAuditInput.consultationId`, `HarnessAuditHashInput`,
  `HarnessAuditEventLike`, `HarnessAuditEventResponse` (admin DTO) all widened to `string | null`;
  `HarnessObservabilityService`'s per-consultation `Map<string, …>` build now skips rows with a null
  `consultationId` (only `CONSENT_GIVEN`/`CONSENT_WITHDRAWN` can have one, and those are filtered out
  by the `action !== GENERATE` check one line above already).

**What this does NOT do:** write a WORM row for a consent DENIAL (only grant/revoke). §6's original
design intentionally scoped that out — `ConsultationConsentService.deny()`'s structured-log-only
posture for denials is unchanged; INV-007/338's "audited denial" is satisfied for the two gated
Temporal activities via the `STEP_TOOL_CALL`/`STEP_RETRIEVAL` trajectory rows (§8.2), a different,
pre-existing audit surface, not the WORM ledger.

### 8.2 Phase 4 — non-HTTP enforcement

**Transport (Task 12):** the A+B hybrid design.md called for. `POST /internal/consent/assert`
(`apps/api/src/modules/consultation/consent-internal.controller.ts`), guarded by the EXISTING
`HarnessServiceTokenGuard` (no new auth mechanism), wraps `checkConsent` (never `assertConsent` — the
endpoint must never throw; it returns a decision). `harness/core/consent_client.py`'s `ConsentClient`
mirrors `effective_config.py`'s TTL + negative-cache shape, keyed per `(tenantId, externalPatientId,
purpose)` — never a single global snapshot. A process-lifetime singleton in `activities.py`
(`_consent_client`), UNLIKE the other per-call client factories in that file, because the whole point
of the cache is to survive across activity invocations.

**Gating (Task 13):**
- `call_mcp_tool`: consent is step (0.5) — after the server-enabled check, before the allowlist,
  exactly where the ticket's §2.3 analysis said it belongs. A denial OR an unavailable lookup raises
  a non-retryable `ApplicationError` (`type="ConsentDenied"` / `type="ConsentUnavailable"`) BEFORE any
  network call — mirroring the existing `McpToolNotAllowed`/`PhiEgressBlocked` raise pattern this
  function already uses for its other pre-network denials.
- `retrieve_context`: consent is checked after the retrieval-enabled flag check, before the retriever
  runs. Deliberately does NOT raise — it follows this activity's OWN pre-existing contract ("any
  backend outage degrades to an empty context, never raises into the durable loop"): a denial/
  unavailable is treated like a retrieval-backend outage, returning `RetrievedContext(degraded=True)`.
  This is an intentional divergence from `call_mcp_tool`'s raising posture — RAG retrieval is
  minimum-necessary augmentation, not a network egress that must be blocked outright, and crashing
  the whole document workflow over a missing history-retrieval grant would be a worse failure mode
  than generating without institutional context.
- Both distinguish `consent_denied` from `consent_unavailable` in the trajectory `error_code` and the
  raised/returned type (R4) — a missing `tenant_id`/`external_patient_id` (a wiring gap, not a
  patient-level decision) is ALSO reported as `unavailable`, never fabricated as a denial.

**Identity threading (the part the ticket's Task 12/13 split didn't fully spell out):**
`external_patient_id` did not exist ANYWHERE on the harness's workflow/activity models before this
pass. Threaded end to end: TS `HarnessGatewayService.start()` (new `externalPatientId` field on
`HarnessStartContext`) ← `NoteGenerationService.generate()` (a best-effort, non-fatal
`consultationRepository.findById` lookup — a failure here degrades the DOWNSTREAM consent check to
`unavailable`, it never blocks note generation itself) → Python `StartDocumentRequest`/
`internal.py`'s `document:start` → `HarnessDocWorkflowInput.external_patient_id` (additive-optional,
replay-safe) → threaded into `CallMcpToolInput`/`RetrieveContextInput` inside `HarnessDocWorkflow.run`
in `workflows.py`.

**Disclosed, bounded gap:** `ConsultationLoopWorkflow`'s finalize-child path (`workflows.py:~2435`,
the `child_input = HarnessDocWorkflowInput(...)` construction inside the loop's own finalize logic)
starts a `HarnessDocWorkflow` child WITHOUT `external_patient_id` — `ConsultationLoopWorkflowInput`
has no such field, and threading it through that workflow's own start payload (a third entry point,
in a different subsystem, not named by the ticket's Task 12/13) is out of this pass's scope. Its
`call_mcp_tool`/`retrieve_context` calls will report `consent_unavailable` (fail-closed, but
distinguishable from a denial) until that workflow is upgraded too — a follow-up, not a silent gap:
`test_missing_identity_denies_as_unavailable_not_a_crash` (`test_mcp_tool_activity.py`) locks the
degrade behaviour so it stays a controlled failure mode, not a crash, until then.

**Cache-invalidation scope (also disclosed, also bounded):** the TS side already has an in-process
`arca:consent:invalidate` EventEmitter2 channel (§4, this document) — NOT the cross-process Redis
channel the design's Task 7 approach section describes, per that section's own text ("There is no
second process to invalidate yet in this phase"). This pass adds exactly that second process (the
harness worker) but does NOT wire it into a cross-process invalidation channel — `ConsentClient`'s
TTL (30s, matching the TS-side cache) is the sole bounded-staleness mechanism, same posture the
ticket's own design section names as the accepted backstop ("Short TTL as a backstop... a Redis
invalidation channel... is the propagation mechanism" — the channel itself remains unbuilt, on both
sides, a scoped decision rather than an oversight).

### 8.3 Phase 6 — dedicated seed file

`packages/database/src/prisma/db_main/seed/22-consent-grant.ts` (21 was already claimed by a sibling
ticket's `21-workflow-definition.ts`). Seeds `EXTERNAL_TOOL_LOOKUP`/`STYLE_LEARNING`/`QUALITY_REVIEW`
grants for the demo patients in `09-consultation.ts` — the three purposes the Pass-2 legacy-grant
backfill did NOT cover (it only backfilled `AI_DOCUMENTATION`/`HISTORY_RETRIEVAL`, the two purposes
gated at HTTP enforcement time; nothing gated on the other three until this pass's Phase 4). Without
this seed, every demo `call_mcp_tool` invocation in a freshly-seeded environment would now deny
(correctly, but uselessly for demo purposes) — this file is what makes the newly-built Phase-4 gate
actually exercisable out of the box.

Gated on the SAME `isPhaseEnabled('09-consultation', mode)` phase (not a new phase name) — these rows
exist only to make the synthetic demo patients usable, carrying the same "never outside development/
test" posture `seedConsultation` already has. CREATE-ONLY / idempotent (checked via `findFirst` on the
active-grant shape, since the DB's partial unique index isn't expressible as a Prisma `@@unique` for
a typed `upsert` to target — same posture as `seedTenantTtsConfig`). Verified against a live
`hope_test` database this pass: first run created 24 rows (7 Global-tenant patients × 3 purposes + 1
ArcaAI patient × 3 purposes); a second run created 0 (all 24 already-present, skipped) — idempotency
proven, not assumed.

### 8.4 What Pass 3 still does not build

| Item | Status |
|---|---|
| CASL condition evaluation (Phase 5) | **Untouched**, per explicit instruction — shadow/measure/enforce stays its own change |
| A WORM row for a consent DENIAL (only grant/revoke write) | **Not built** — see §8.1's closing note; denials stay on the trajectory-step surface |
| `ConsultationLoopWorkflow` finalize-child `external_patient_id` threading | **Not built** — disclosed gap, §8.2 |
| Cross-process consent-cache invalidation for the harness worker | **Not built** — TTL-only, disclosed scope, §8.2 |
| `casl-blast-radius.md` (Task 2) | **Not built** — Phase 5 is untouched this pass too |
| The full ticket's original Task 11 boot-audit predicate ("every consultation-module route") | **Unchanged from Pass 2** — still narrowed to `:patientId`-only routes |
