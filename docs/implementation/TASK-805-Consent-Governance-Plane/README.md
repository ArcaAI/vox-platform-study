# TASK-805 — Consent Governance Plane (console + tenant-wide list)

| Field | Value |
|---|---|
| Status | Completed |
| Type | feature |
| Branch | `dev-2.2` |
| Depends on | TASK-712 (consent-abac choke point) |

## 1. Requirement Analysis

Realtime consultation is unusable on a fresh environment. Reproduced against the
deployed `hope-v2-dev` cluster:

```
POST /api/v1/consultations/01a036f7-fa27-77af-946d-7cac2da3373f/recording/start
403 {"code":"DOMAIN.CONSENT_DENIED","metadata":{"externalPatientId":"test",
     "purpose":"AI_DOCUMENTATION","reason":"no_grant"}}
```

Verified in `vox-dev` (the cluster's database, NOT the `hope` DB the local
postgres MCP points at):

| Check | Result |
|---|---|
| Consultation `01a036f7…` | exists, `tenantId=…0001` (ArcaAI), `patientId="test"` |
| `ConsentGrant` rows for `test` | **0**, in any tenant |
| `ConsentGrant` rows total | 38 — all seeded `PAT-*` demo patients |

`PatientConsentGuard` is therefore behaving correctly: enforcement is
unconditional and fail-closed by design, with no kill-switch
(`patient-consent.guard.ts:10-16`).

**The defect is not the gate — it is that the console offers no way to satisfy
it.** `grep -rl consent apps/admin-console/src` returns two unrelated files. The
consultation workspace accepts a free-text patient id
(`consultations-column.tsx:95`) and opens a consultation that can never be
recorded, and `POST /admin/consent-grants` — the only write surface — has no UI.

### Explicit non-goal: auto-granting

A `ConsentGrant` asserts a patient authorized a use of their data. Creating one
as a side effect of opening a consultation would fabricate that claim. The
platform already ruled on this: the write surface carries `@ForbidServiceAccount`
because *"consent is an act of a PERSON"* (`consent.controller.ts:35-45`).
Day-1-ready therefore means **a human can record consent in one click at the
point of care**, never that the gate ships pre-satisfied.

## 2. Current State Evaluation

| Surface | State |
|---|---|
| `ConsentGrant` model, partial-unique-active index, WORM ledger | complete (TASK-712) |
| `POST /admin/consent-grants`, `PATCH :id/revoke` (If-Match OCC) | complete |
| `GET /admin/consent-grants?externalPatientId=` | complete but **requires** a patient id and returns a bare array — unusable as a register |
| Admin console consent UI | **absent entirely** |
| Point-of-care consent capture | **absent entirely** |
| `@arcaai/vox-node` admin surface | deliberately absent (owner decision D-3) — unchanged here |

## 3. Implementation Plan

### Layer 1 — Applications (`@arcaai/applications`)
1. `dto/list-consent-grants.query.ts` — `ListConsentGrantsQuery extends PaginatedQuery`
   with optional `externalPatientId`, `purpose`, `state` (`ACTIVE|REVOKED|ALL`).
2. `dto/paginated-consent-grant.response.ts` — `PaginatedConsentGrantResponse`.
3. `ConsentGrantDtoMapper.ToPaginatedResponse`.
4. `ConsentGrantService.getByPatient` → **`list(query)`**, tenant-scoped, paginated.
   `state` maps to a `revokedAt` predicate; `ACTIVE` additionally excludes
   already-expired rows.

### Layer 2 — API (`apps/api`)
5. `GET /admin/consent-grants` returns `PaginatedConsentGrantResponse`; the
   `externalPatientId` query param becomes OPTIONAL. Deliberate contract change
   (pre-production, no consumers outside the e2e spec and the new console screen).
6. Update `tests/e2e/consent-abac.spec.ts` for the envelope shape.
7. Regenerate `route-manifest.json`, `openapi.json`, portal.

### Layer 3 — Console register screen (`/consent`, tier 30-49)
8. `features/consent/` — `api/{client,hooks,keys,types,index}`,
   `components/{consent-screen, consent-grant-form-dialog}`.
9. `ScreenTemplate` + `AdminDataGrid`, create dialog, revoke under If-Match.
10. `nav-config.ts` entry, `app/(console)/(tenant)/consent/{page,loading}.tsx`.

### Layer 4 — Point of care (`features/playground-consultation`)
11. Consent status read for the selected consultation's patient.
12. Record button gated with a visible reason when `AI_DOCUMENTATION` is absent
    (never a bare disabled control — rule 11 §5).
13. `RecordConsentDialog` — attestation (`grantMethod`, optional expiry) → POST.
14. `CONSENT_DENIED` 403 handled with an actionable recovery instead of the raw
    exception message.

### Verification
`pnpm --filter @arcaai/applications test build`, `pnpm --filter @arcaai/api test`
(unit), `pnpm --filter @arcaai/admin-console test build lint`, `pnpm api:openapi:check`,
`pnpm api:portal:check`, plus a live re-run of the failing request.

## 4. Implementation Summary

### Files changed

| Layer | File | Change |
|---|---|---|
| Applications | `services/consent/dto/list-consent-grants.query.ts` | NEW — `ListConsentGrantsQuery` + `ConsentGrantState` |
| Applications | `services/consent/dto/paginated-consent-grant.response.ts` | NEW — `PaginatedConsentGrantResponse` |
| Applications | `services/consent/consent-grant.dto.mapper.ts` | + `ToPaginatedResponse` |
| Applications | `services/consent/consent-grant.service.ts` | `getByPatient` → `list(query)`; `buildListWhere`; `stableSort` |
| Applications | `services/consent/IConsentGrantService.ts` | interface follows |
| API | `modules/consent/consent.controller.ts` | `GET /admin/consent-grants` now paginated, `externalPatientId` optional |
| API | `route-manifest.json`, `openapi.json`, portal projections | regenerated |
| API | `tests/e2e/consent-abac.spec.ts` | envelope shape + 6 new register tests |
| Console | `features/consent/**` | NEW feature module (api + 4 components) |
| Console | `app/(console)/(tenant)/consent/page.tsx` | NEW route |
| Console | `shared/navigation/nav-config.ts` | NEW entry, tier 30-49, domain `clinical` |
| Console | `features/playground-consultation/**` | consent gate, attestation dialog, 403 recovery |
| Console | `features/ai-providers/**` | incidental — see I-1 below |

### Contract change

`GET /admin/consent-grants` returns `PaginatedConsentGrantResponse` instead of
`ConsentGrantResponse[]`, and `externalPatientId` is now optional. Deliberate
and pre-production: the only consumers were the e2e spec and the new console
screen. `@arcaai/vox-node` is unaffected — the whole controller is absent from
the generated SDK by owner decision D-3.

### Defects found and fixed during the work

**D-1 — offset pagination was unsound on this table.** `grantedAt` is not
unique (the seed stamps every demo grant with the same instant, and a bulk
import does the same), and Postgres gives no ordering guarantee between rows
that tie on every ORDER BY key — so page 2 repeated rows from page 1 and
silently omitted others. Fixed by `stableSort`, which appends the UUIDv7 `id`
as a tiebreaker to whatever sort is requested. Caught by the register's own
pagination e2e, then confirmed fixed in a live browser (page 1 and page 2 share
no rows).

**I-1 — incidental: `openapi.json` was stale, hiding a real console gap.**
Regenerating it surfaced that the gateway's `:service` enum gained a SEVENTH
value, `model-registry` (TASK-799, 2026-08-24), which the committed snapshot
never recorded. `provider-services.drift.test.ts` — the gate built to catch
exactly this — had been passing against the stale snapshot, so the console's
`PROVIDER_SERVICES` stayed at six and the model-registry weight-fetch
credentials (HuggingFace token, S3 key pair) had a working API and no UI for an
entire release. Fixed per that test's own instruction ("update `services.ts` to
match the snapshot — never relax the assertion"): the type, the derived list,
and the four `Record<ProviderService, …>` maps. Field shapes are copied from
`PROVIDER_REQUIREMENTS['model-registry:*']`, and `CLOUD_BYO_PROVIDERS` is empty
because the plane is platform-managed by owner ruling — the same shape `rerank`
already had.

**I-3 — the four-artifact rule is missing a fifth.** `05-nestjs-api.md`'s
definition of done says to regenerate `api:build && api:route-manifest &&
api:openapi && api:portal` together. It omits
`pnpm --filter @arcaai/vox-node gen:admin`, whose output (`schemas.ts`) is
derived from `openapi.json` and is gated by `generate-vox-node-admin-check` just
as tightly. Following the documented list exactly still produced a red pipeline
(#990). The drift was, again, only the `model-registry` enum — the same I-1
staleness — and nothing consent-related, since `ConsentGrantController` is
absent from the generated SDK by owner decision D-3. Worth folding into the
rule's DoD list.

**I-2 — out of scope, reported not fixed.** Every admin-console screen logs a
React `Received false for a non-boolean attribute active` error from a shared
`packages/ui` component. Reproduced on `/audio/pipelines`, untouched by this
ticket. Filed separately.

### Verification (actual output)

| Gate | Result |
|---|---|
| `pnpm --filter @arcaai/applications test` | 581 files, **10169 passed**, 1 skipped |
| `pnpm --filter @arcaai/api test` | 259 files, **4021 passed**, 2 skipped |
| `pnpm --filter @arcaai/admin-console test` | 242 files, **2026 passed** |
| e2e `consent-abac` (live gateway, port 8968) | **13 passed** (7 pre-existing + 6 new) |
| `pnpm --filter @arcaai/{admin-console,api} lint` | 0 errors |
| `pnpm --filter @arcaai/admin-console typecheck` / `build` | clean; `/consent` in the route table |
| `pnpm api:openapi:check` | OK — and the ratcheted counters IMPROVED (description 411→410, 4xx 289→288) |
| `pnpm api:portal:check` | no drift |

**Live browser pass** (dev API 8868 + console 5176, `tenant_admin`):
register renders 33 seeded grants; page 2 shares no rows with page 1 (D-1);
opening a consultation for an ad-hoc patient blocks Start with
*"Recording is blocked: patient <id> has no active AI documentation consent on
record"* plus a **Record consent** action; recording consent clears the gate and
enables Start; the grant appears in the register within the same session
(cross-surface invalidation); Withdraw removes it from Active (34→33) and it
remains visible under *Withdrawn only*. Verified in both themes.

Database confirmation of the point-of-care write:

```
ConsentGrant  externalPatientId=test  purpose=AI_DOCUMENTATION
              grantMethod=VERBAL_ATTESTED  grantedBy=70000000-…-002  revokedAt=null
HarnessAuditEvent  action=CONSENT_GIVEN  clinicianId=70000000-…-002
                   modelName=consent-administration  consultationId=null
```

i.e. the WORM ledger append fired and the grant is attributed to the human who
made the attestation — which is the entire point of refusing to auto-grant.

### Deployment (dev, 2026-08-25)

| Step | Evidence |
|---|---|
| Commits | `5f20284f1` (feature) · `4e626db24` (vox-node regen) · `5daca9ddd` (docs) on `dev-2.2` |
| Pipeline | [#991](https://git.taphuynh.dev/arca/hope-v2/-/pipelines/991) green (see D-2 below) |
| Promote | `c0e10bd7` `promote(dev): dev-5daca9dd from pipeline #784` in `arca/hope-v2-deployment` |
| Argo | `hope-v2-dev` **Synced** at `c0e10bd7`; 105/107 Synced+Healthy (2 unrelated rollouts finishing) |
| Images | `api@sha256:b7f8cf62…` (was `d532d046…`), `admin-console@sha256:b52c40ff…` (was `ba097d10…`) |
| Running build-info | both services report `gitCommitSha 5daca9ddd…`, `ciPipelineId 991` |
| Live API contract | `GET /api/v1/admin/consent-grants` → `operationId ConsentGrantController_list`, params include `externalPatientId` (OPTIONAL), `purpose`, `state`; 200 = `PaginatedConsentGrantResponse` |
| Live console route | `/consent` → `307 /login?from=%2Fconsent` (exists, auth-gated) |

**D-2 — the CI/CD facts this deploy exposed, none caused by this change.**

1. *No tests run in CI.* Pipelines 988/990/991 instantiate ZERO jobs from
   `.gitlab/ci/test.yml` — every one is gated behind `SKIP_TESTS` /
   `SKIP_TESTS_TS`, which something sets at project level. The pipeline is
   lint + typecheck + codegen-drift + gitleaks only. TASK-805's evidence is
   therefore entirely local (§Verification above); CI re-verified none of it,
   and would not catch anyone else's regression either.
2. *Python image builds time out.* `build-nlp`, `build-harness` and
   `build-harness-worker` all hit `job_execution_timeout` at 1800s pulling
   82 MB of Debian packages at ~30-60 KB/s; they passed on retry off a warm
   cache. None of them contains a line of this change — they rebuilt only
   because `build-python-base` came up cold and invalidated their layers.
   Worth a mirror/proxy for the build runner, and worth asking whether
   `promote-dev` should gate on images that did not change.
3. *The `hope-db-migrate` Argo failure is a live overlay bug.* Before this
   deploy the app was OutOfSync/Missing with its last sync FAILED:
   `Job.batch "hope-db-migrate" is invalid: spec.selector: Required value …
   field is immutable`. `base/db-migrate.yaml` declares it correctly as a
   `PreSync` hook with `hook-delete-policy: BeforeHookCreation`, but the DEV
   OVERLAY strips those annotations and substitutes
   `argocd.argoproj.io/sync-options: Replace=true`. `Replace=true` against an
   EXISTING Job sends a manifest with no auto-generated `controller-uid`, so
   the replace is rejected. It self-cleared here only because the Job had been
   deleted by hand at ~04:50Z, so Argo took the create path; it recreated
   cleanly (`succeeded: 1` at 06:58:59Z). **It will re-break on the next sync
   where the Job still exists.** The fix is to stop overriding the base's hook
   annotations — in `arca/hope-v2-deployment`, so out of scope here.

   Worth noting for confidence: even while that sync was failing, the
   Deployments still applied — the pod running before this deploy carried
   `e3de6a43` from the pipeline whose sync was marked Failed.

## 5. Follow-ups (not in this ticket)

- **F-1 — clinician bedside capture.** `POST /admin/consent-grants` is gated by
  `@CanManage('ConsentGrant')`. Tenant admins hold it; a plain clinician role
  does not, so in a real deployment a clinician could not record consent at the
  bedside. Not blocking today (the playground is nav-gated to
  SUPER_ADMIN/TENANT_ADMIN), but widening a PHI authorization root is an owner
  decision, not a code-review call. The `USER_PERSONAL` prompt-template
  owner-scoped-write pattern (`05-nestjs-api.md` §Imperative Privilege Checks)
  is the precedent if it is taken up.

## 6. Change History

| Date | Change |
|---|---|
| 2026-08-25 | Ticket opened; root cause verified against `vox-dev`; plan approved (full governance plane, clinician gate noted not changed). |
| 2026-08-25 | Pipeline #990 red on `generate-vox-node-admin-check`; regenerated `vox-node` `schemas.ts` (2 lines, the `model-registry` enum). Recorded as I-3. |
| 2026-08-25 | Deployed to dev: pipeline #991 green, promote `c0e10bd7`, Argo Synced, both services verified on `5daca9dd`. Recorded D-2 (CI runs no tests; Python builds time out; the db-migrate overlay bug). |
| 2026-08-25 | Implemented all four layers. Fixed D-1 (unstable pagination sort) and I-1 (stale OpenAPI hiding the missing `model-registry` console surface). All gates green; live browser pass recorded. Status → Completed. |
