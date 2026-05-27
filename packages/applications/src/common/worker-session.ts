import { UserSession } from '../services';

/**
 * Init shape for `createWorkerSession`.
 *
 * @see createWorkerSession for the full TSDoc on why this factory exists.
 */
export interface WorkerSessionInit {
  /**
   * Responsible user id captured by the job / event payload, if any.
   * Falls back to `system-<kind>` when absent (e.g. system-emitted
   * events with no originating user, like cron triggers).
   */
  userId?: string | null;

  /**
   * Tenant the worker is acting on behalf of. REQUIRED — the
   * Phase-B `tenantScope` Prisma extension reads `tenantId` from
   * the CLS user payload, and an undefined value silently widens
   * the query to all tenants.
   */
  tenantId: string;

  /**
   * Short, descriptive label for the worker class (e.g. `'audit'`,
   * `'summary'`, `'ner'`, `'transcription-event'`). Becomes the
   * local-part of the synthetic sentinel email so SOC can grep
   * audit-log rows by worker source.
   */
  kind: string;
}

/**
 * TASK-306 W5.7.11 (§8 F-6) — typed factory for background-worker /
 * event-handler CLS contexts.
 *
 * Replaces the ad-hoc `{ id, tenantId, roles: [], permissions: [] }
 * `<as-unknown-as-UserSession>` cast repeated 8× across queue processors
 * and event handlers (pre-W5.7.11). Those casts compiled only
 * because the `<as-unknown>` escape hatch silenced the missing
 * `email!: string` field; the runtime object never carried an email,
 * so any code path that read `session.email` (e.g. a future audit
 * row's "actor email" column) would have observed `undefined` on
 * worker writes.
 *
 * Worker sessions are deliberately:
 *   - **Roleless** — workers never get SUPER_ADMIN bypass
 *   - **Permissionless** — the policy engine grants based on `roles`
 *   - **Email-tagged** with a sentinel local-part keyed off the
 *     `kind` label, so logs / audit rows are grep-able by worker
 *     source (e.g. `audit@system.local` vs. `summary@system.local`)
 *
 * The returned value is a fully-typed `UserSession`; no `as unknown`
 * cast is required at the callsite. The Phase-B tenant-scope
 * extension reads `tenantId` directly from CLS (`tenantId`) and the
 * user payload's `tenantId` field — both are populated by callers
 * via `cls.set('tenantId', tenantId)` + this factory.
 */
export function createWorkerSession(init: WorkerSessionInit): UserSession {
  return new UserSession({
    id: init.userId ?? `system-${init.kind}`,
    email: `${init.kind}@system.local`,
    tenantId: init.tenantId,
    roles: [],
    permissions: [],
  });
}
