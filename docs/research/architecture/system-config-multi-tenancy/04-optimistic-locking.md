# Optimistic Locking for HOPE — Best-Practice Guide & Migration Plan

| Field | Value |
|---|---|
| **Parent assessment** | System Configuration & Multi-Tenancy Deep Assessment |
| **Scope** | `core.GlobalSetting` first; pattern reusable for all tenant-scoped Prisma models |
| **Status** | Research / decision-ready (no code change yet) |
| **Audience** | Senior backend engineer scoping work |
| **Last updated** | 2026-05-24 |

> **TL;DR** — HOPE's `core.GlobalSetting` (and every other model in `packages/database/src/prisma/db_main/`) already carries `version Int @default(1) @map("_version")`, but nothing in the runtime touches it. Two SUPER_ADMINs editing `smr-provider-models` at the same time silently lose-write each other. This document scopes a phased, opt-in roll-out of optimistic concurrency control (OCC) using the existing column, HTTP `If-Match` / `ETag` on the public API, and a small additive surface on `Repository<T>` and `BaseService`. No data migration is required.

---

## 1. Why optimistic locking — concrete HOPE scenarios

The `version` column is currently incremented by nobody. Under concurrent writes the database awards the last `UPDATE` to commit and the earlier writer's effect is overwritten with **no error and no log entry** — the textbook "lost update" anomaly (Berenson et al., 1995). In a healthcare-AI control plane it bites in four places:

1. **Two SUPER_ADMINs editing `smr-provider-models` catalog.** A removes a deprecated model; B (page loaded before A saved) adds a new one. B's PATCH carries the pre-removal JSON blob, so the deprecated model silently reappears and patient consultations route to a model meant to be retired.
2. **Bull job racing the admin UI on `enable-ner-extraction`.** A re-provisioning job reads the setting, an admin then disables NER for an HIPAA review, the job's `update` lands and re-enables NER. PHI now flows through an NLP path the compliance officer believes is off.
3. **Audit-log gaslighting.** `core.AuditLog` records *"user X changed value to Y at t=10:00:03"*, but a millisecond later user Z's stale-read overwrite lands and the *effective* state is Z's. The investigator cannot reconcile the audit log with the database — the failure mode HIPAA §164.312(b) and SOC2 CC7.2 require us to prevent.
4. **Retry-on-failure double-apply.** Any transient-retry policy (NestJS request-scoped retries, Bull `attempts: 3`) re-applies the entity it read at attempt 1 — clobbering anything an admin changed between attempts.

Frequency today is low (≤ 50 tenants), but **blast radius is non-uniform**: a lost-write on `jwt-secret-rotation` or `smr-provider-models` is operationally catastrophic; a lost-write on a notification preference is irritating. OCC lets us protect the high-value subset without paying any price on the low-value writes.

---

## 2. Optimistic vs pessimistic — the trade-off

| Dimension | Optimistic (`UPDATE … WHERE id = ? AND version = ?`) | Pessimistic (`SELECT … FOR UPDATE` row lock) |
|---|---|---|
| **Read cost** | None — no lock taken | None until you escalate, then row lock acquired |
| **Write cost** | One round trip; rejects on version drift | Lock acquired on read; held until COMMIT |
| **Failure mode** | `OptimisticConcurrencyException` → client retries | `LockTimeout` / deadlock; pool starvation |
| **Distributed friendliness** | Works trivially across pods, jobs, multi-region read replicas | Requires connection affinity and session-mode pooling — incompatible with PgBouncer transaction-mode that HOPE uses today |
| **Sweet spot** | Low-to-moderate contention, human-driven CRUD, config | Tight-loop counters, balance updates, queue checkpoints |

For HOPE's config plane the answer is obvious: contention is rare, writes are human-paced, and every pod talks to PostgreSQL through a transaction-mode pooler. `SELECT … FOR UPDATE` would hold a row lock across a typical admin-UI round-trip (hundreds of ms to seconds) — exactly the anti-pattern Hibernate and SQLAlchemy 2.0 warn against. Pessimistic earns its place only in short, provably-contended hot paths (none today; possibly `core.UsageRecord` if we ever surface real-time billing). **Optimistic is the default.**

---

## 3. Implementation pattern (Prisma 7 on PostgreSQL)

The canonical Prisma OCC idiom is `updateMany` with the version included in the `where`:

```typescript
async updateWithVersion(
  id: EntityId,
  changes: Partial<Models.GlobalSetting>,
  expectedVersion: number,
): Promise<GlobalSettingEntity> {
  const { count } = await this.db.updateMany({
    where: { id, version: expectedVersion },
    data: {
      ...changes,
      version: { increment: 1 },
    },
  });

  if (count === 0) {
    const exists = await this.db.findUnique({ where: { id }, select: { version: true } });
    if (!exists) throw new DataNotFoundException(this._modelName, id);
    throw new OptimisticConcurrencyException(this._modelName, id, {
      expectedVersion,
      currentVersion: exists.version,
    });
  }

  return this.findById(id);
}
```

Three things deserve emphasis:

- **`updateMany` over `update`.** `update` throws `P2025` when the row is missing and cannot distinguish "row gone" from "version drifted". `updateMany` returns `{ count }` — exactly the compare-and-set primitive we need.
- **PostgreSQL-safe.** Prisma issues [#10207](https://github.com/prisma/prisma/issues/10207) and [#28840](https://github.com/prisma/prisma/issues/28840) document that on **MySQL** Prisma rewrites `updateMany` as `SELECT pk … ; UPDATE … WHERE pk IN (…)`, dropping non-pk predicates and defeating OCC. **PostgreSQL emits predicates verbatim** (`UPDATE … WHERE id = $1 AND "_version" = $2`); the pattern is safe. HOPE is Postgres-only — but keep a unit test that proves `count === 0` under concurrent writes as a permanent regression guard.
- **Version source.** Admin-UI writes carry the version in the HTTP `If-Match` header (§4). Service-to-service and Bull-job writes read it off the freshly-loaded entity (`entity.version`); the call site is responsible for not refreshing-then-overwriting.

**Retry semantics:** never auto-retry human-driven writes — a 412 is meaningful information; the user wants to see the diff before re-submitting. For machine-driven writes, wrap in `pRetry({ retries: 3, factor: 2 })` with re-fetch + re-apply between attempts, per Martin Fowler's *Optimistic Offline Lock* (PoEAA, 2003).

---

## 4. ETag-based optimistic locking for HTTP APIs

RFC 7232 §3.1 + §4.2 give us a battle-tested wire format for OCC. The shape:

```
GET /api/global-settings/abc123
→ 200 OK
   ETag: "7"
   { "id": "abc123", "value": "true", "version": 7, … }

PATCH /api/global-settings/abc123
   If-Match: "7"
   { "value": "false" }
→ 200 OK
   ETag: "8"
   { …, "version": 8 }

# concurrent admin saved at v8 before this one:
PATCH /api/global-settings/abc123
   If-Match: "7"
   { "value": "false" }
→ 412 Precondition Failed
   ETag: "8"
   { "error": "OPTIMISTIC_CONCURRENCY_CONFLICT", "currentVersion": 8, "yourVersion": 7 }
```

Implementation notes:

- **Strong ETag.** RFC 7232 §2.3.2 *requires* strong comparison for `If-Match`. A monotonic integer rendered as `"7"` (double quotes, no `W/` prefix) is the simplest strong validator. Do *not* hash the body — we want byte-identical re-saves to fail too if the version drifted.
- **`ETagInterceptor` in `apps/api`.** (a) On responses whose body carries `.version`, set `res.setHeader('ETag', '"' + body.version + '"')`. (b) On incoming `PATCH`/`PUT`/`DELETE` annotated `@RequiresIfMatch()`, parse `If-Match`, strip quotes, validate it is a positive integer, expose on `req.expectedVersion`. A custom `@ExpectedVersion()` param decorator pulls it for the service.
- **Missing header.** When `@RequiresIfMatch()` is set and the client omits the header, return **`428 Precondition Required`** (RFC 6585) — the SOC2-friendly default the Ed-Fi spec and Google Cloud Healthcare API both adopt.
- **Hybrid fallback.** Server-to-server callers (Bull jobs invoking `updateTenantConfigs`) pass `expectedVersion` in the request body. The same service method handles both wire shapes.

The interceptor is ≤ 60 lines — structurally smaller than the caching variant because we don't hash the body.

---

## 5. Domain-layer integration

HOPE's layering is `Controller → Service → Entity → Repository → DB` with change tracking on the entity. OCC threads through every layer:

- **Entity (`BaseEntity`).** The interface already declares `version?: number` but the constructor never reads it and no getter exposes it. **Add** `_version`, a getter, and initialise to `1` in the factory. **Do not** add a public setter — `version` is database-owned.
- **Mapper (`GlobalSettingEntityMapper`).** Auto-mapper silently drops `version` today (no entity property). After the entity change, the auto-mapper picks it up for `$toDomain` only; handlers include `version: { $toPersistence: () => undefined }` so the change-tracked path never writes it. The only legitimate writer is `updateWithVersion`.
- **Change tracking (`entity.changes`, `entity.hasChanges`).** Untouched. `version` is not a "change" — the user never sets it; the repository increments it as part of the CAS write.
- **Repository base class.** Add `updateWithVersion(id, changes, expectedVersion)` alongside the existing `update(id, entity)`. Existing `update` stays — seed code and non-concurrent callers should not be forced to thread a version.
- **`softDelete` / `restore`.** Both currently bypass `entity.changes`. Wire them through `updateWithVersion` when the caller passes `expectedVersion` (overloaded signature); default behaviour stays unchanged so maintenance Bull jobs don't break.
- **Service (`BaseService.updateEntity`).** No change. The service still calls `applyChangesToEntity(entity, dto)`; it just calls `repo.updateWithVersion(…, expectedVersion)` instead of `repo.update(…)` when a version is available.

The diff lands cleanly because change tracking and OCC are orthogonal: OCC guards *when* the write is allowed; change tracking decides *what columns* it touches.

---

## 6. Migration plan — five reversible phases

| Phase | What | Effort | Rollback | Verification |
|---|---|---|---|---|
| **A. Audit** | Vitest + a transactional helper that reproduces the silent overwrite on `GlobalSetting`. Marks the regression as `it.skip` for now (we don't want a failing CI). Adds a `__tests__/optimisticLockingEvidence.test.ts` documenting today's behaviour. | 0.5 day | Delete the test file | Test currently passes, demonstrates lost write, sits as evidence |
| **B. Infrastructure** | Add `OptimisticConcurrencyException` to `packages/exceptions` (`CONCURRENCY_CONFLICT` code). Add `updateWithVersion(id, changes, expectedVersion)` to `packages/domains/src/common/repository.ts` + unit test. Expose `version` getter on `BaseEntity`. Update auto-mapper handlers to round-trip `version` on read only. **No service or controller changes.** | 2 days | Revert the four files | All existing tests green (no regression); new repository test covers count=0 path |
| **C. Opt-in services** | Migrate `TenantService.updateTenantConfigs` and `GlobalSettingService.update` to call `updateWithVersion`. Update DTOs to require `expectedVersion: number`. Bulk path threads version per-row. Wrap the loop in a transaction so the whole PATCH is all-or-nothing on conflict. | 3 days | Revert the service files; `updateWithVersion` stays available but unused | Vitest service tests + a new e2e Playwright test that simulates two concurrent PATCHes and asserts one wins / one gets 412 |
| **D. HTTP + SDK** | Add `ETagInterceptor` and `@RequiresIfMatch()` decorator to `apps/api`. Apply to `PATCH /tenants/me/config` and `PATCH /global-settings/:id`. Update `@arcaai/vox` `ConfigManager.update()` to capture `ETag` on GET and replay as `If-Match` on PATCH; surface 412 as `ConfigConflictError` with `currentVersion` so the admin UI can show "Refresh to see what changed". | 3 days | Decorator + interceptor removed; SDK falls back to body-field `expectedVersion` | Manual test: two browser tabs editing the same setting, second save shows conflict modal |
| **E. Roll out** | Walk the remaining 18 models; opt-in those that are admin-edited (`Tenant`, `Department`, `PromptTemplate`, `AsrPipeline`, `Webhook`). Skip append-only / system-managed (`AuditLog`, `Notification`, `*UsageRecord`, `WebhookRunHistory`). Add a short "Concurrency Model" section to each service's `README.md`. | 1 week | Per-service revert; pattern continues to exist for new entities | Per-service tests; observability dashboard tracks 412 rate (target < 0.5 % of PATCHes) |

Phase A through C ship behind no flag and are SDK-transparent. Phase D introduces a new HTTP contract; the SDK release that consumes it must be deployed before any UI relying on the conflict modal. Phase E is incremental and can be paused at any point without dragging earlier phases backwards.

---

## 7. Edge cases

- **Bulk `updateTenantConfigs`.** Each row carries its own `expectedVersion`. Inside one Prisma `$transaction`, run the CAS for every row; if any returns `count === 0`, throw `OptimisticConcurrencyException` with the offending `{ id, expected, current }` array and roll back. The whole batch fails — partial success would leave a tenant in a half-applied state, a SOC2 finding waiting to happen.
- **Soft-delete.** `softDelete` mutates `resourceStatus` — a real state change that **must** bump `version`. Otherwise an admin who read at v7 can `updateWithVersion(…, 7)` after another admin soft-deleted, succeed, and resurrect a deleted row.
- **Audit-log correlation.** Each version bump emits `SysEvent.ResourceUpdated` carrying `previousVersion` and `newVersion`. Investigators can `SELECT … WHERE metadata->>'newVersion' = ?` to reconstruct history without re-deriving from timestamps.
- **`updatedAt` does *not* replace `version`.** Postgres microsecond timestamps collide under load; integer monotonic version is robust.
- **Existing data.** Every row already has `version = 1` from the Prisma default. No back-fill, no migration SQL.
- **Replicas.** OCC is read-your-write-safe because the CAS hits the primary. If admin reads land on a lagging replica, the CAS fails and the admin is told to refresh — correct behaviour.

---

## 8. Alternative patterns considered (and why we are not picking them)

- **DB triggers enforcing `version = OLD.version + 1`.** Hides the check from application logs, breaks Prisma's return-value expectations. Debugging a 412 becomes "SSH into the primary". Reject.
- **Postgres advisory locks (`pg_advisory_xact_lock`).** Pessimistic by another name; same round-trip-holding / session-mode pooling problems as `SELECT … FOR UPDATE`. Reject.
- **JSON Patch with `test` op (RFC 6902).** Elegant for fine-grained edits, gives free per-field OCC, but our PATCH bodies are partial objects, our SDK is Zustand-flat, and rolling out a new wire format is far more disruptive than adding `If-Match`. Revisit only if a collaborative editor ships.
- **CRDT / conflict-free merge.** Wrong tool — we *want* conflicts visible and human-resolved, not silently merged. Reject.
- **Last-write-wins + audit log (today's state).** Cheap, shipped, acceptable for low-stakes settings. Unacceptable for `smr-provider-models`, JWT rotation, or any flag gating PHI processing.

---

## 9. HOPE-specific recommendation

1. **Adopt optimistic locking, opt-in per service**, using the existing `version` column. Start with `TenantService.updateTenantConfigs` — highest concurrency surface, smallest blast radius if we regress.
2. **`If-Match` / `ETag` on admin HTTP APIs**, backed by `ETagInterceptor` + `@RequiresIfMatch()`. Body-carried `expectedVersion` is the fallback for service-to-service callers.
3. **Defer for append-only / system-owned tables** — `AuditLog`, `Notification`, every `*UsageRecord`, `WebhookRunHistory`. They are never targets of concurrent human edits.
4. **Pair with `GlobalSettingHistory`**. When a 412 fires, the UI renders "user X changed value from Y to Z at t" so the operator can clobber, merge, or abandon. Conflicts without context are user-hostile.
5. **Treat `version` as database-owned** — never expose a setter, never write it through `entity.changes`. The only writer is `updateWithVersion`. This rule alone prevents the entire class of "looks like OCC, actually broken" failures Prisma #10207 documents on MySQL.

---

## 10. Effort estimate

| Phase | Engineer-days | Calendar weeks (1 eng, parallel work allowed) |
|---|---|---|
| A. Audit / evidence test | 0.5 | < 1 |
| B. `OptimisticConcurrencyException` + `updateWithVersion` + entity getter | 2 | < 1 |
| C. `TenantService` + `GlobalSettingService` migration | 3 | 1 |
| D. `ETagInterceptor` + SDK update + UI conflict modal | 3 | 1 |
| E. Roll out to 5 more services + docs | 5 | 1–2 |
| **Total** | **~13.5 days** | **~3–4 weeks elapsed** |

If you want a single "minimum viable" cut: A + B + C is a usable 5.5 days of work that closes the lost-write hole on tenant config without touching the wire format. D and E can land later.

---

## 11. References

- **RFC 7232** — *HTTP/1.1 Conditional Requests* (§3.1 `If-Match`, §4.2 `412`, §2.3.2 strong comparison). <https://www.rfc-editor.org/rfc/rfc7232.html>
- **RFC 6585** — `428 Precondition Required`. <https://www.rfc-editor.org/rfc/rfc6585.html>
- **RFC 6902** — JSON Patch (§8 alternative considered). <https://www.rfc-editor.org/rfc/rfc6902.html>
- **Prisma — Transactions guide, "Optimistic concurrency control"** (2025 revision). <https://www.prisma.io/docs/orm/prisma-client/queries/transactions>
- **Prisma #10207** — *MySQL: OCC doesn't work with UpdateMany*. Confirms PostgreSQL is unaffected. <https://github.com/prisma/prisma/issues/10207>
- **Prisma #28840** — *updateMany on MySQL drops predicates* (2025). <https://github.com/prisma/prisma/issues/28840>
- **OneUptime — "Implement Optimistic Locking with Prisma in Node.js"** (2026-01-25). <https://oneuptime.com/blog/post/2026-01-25-optimistic-locking-prisma-nodejs/view>
- **Martin Fowler — *Optimistic Offline Lock*** (PoEAA, 2003, ongoing updates).
- **Hibernate ORM 6 — "Versioning and optimistic locking".** <https://docs.jboss.org/hibernate/orm/6.6/userguide/html_single/Hibernate_User_Guide.html#locking>
- **SQLAlchemy 2.0 — "Versioning Objects".** <https://docs.sqlalchemy.org/en/20/orm/versioning.html>
- **Ed-Fi Alliance — *Handling Optimistic Concurrency with ETags*** (REST API design guideline, 2024). <https://docs.ed-fi.org/reference/data-exchange/api-guidelines/design-and-implementation-guidelines/api-implementation-guidelines/handling-optimistic-concurrency-with-etags/>
- **Google Cloud Healthcare API — FHIR resource versioning and `If-Match`.** <https://cloud.google.com/healthcare-api/docs/concepts/fhir>
- **NestJS interceptors.** <https://docs.nestjs.com/interceptors>
- **Wanago — "API with NestJS #58: Using ETag"** (updated 2024). <https://wanago.io/2022/01/17/api-nestjs-etag-cache/>
- **OneUptime — "Implement API ETag Headers"** (2026-01-30). <https://oneuptime.com/blog/post/2026-01-30-api-etag-headers/view>
- **The assessment finding "missing optimistic locking"** (`packages/database/src/prisma/db_main/globalSetting.prisma`). This document is the proposed remediation.
