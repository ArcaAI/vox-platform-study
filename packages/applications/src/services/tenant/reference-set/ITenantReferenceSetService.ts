/**
 * TASK-890 §3.4 (OD-H, OD-J, OD-M) — the SYSTEM REFERENCE SET.
 *
 * The owner rule (§1.5): **content is cloned, config cascades.** An agent, a prompt template, a
 * workflow definition and a context schema are CONTENT — what a tenant authors, publishes and
 * runs — so the SYSTEM tenant holds a REFERENCE SET they are copied FROM, not a tier they are
 * resolved THROUGH. After L13 step v, no runtime read of content ever widens to SYSTEM: a miss
 * is a named, fail-closed error naming the tenant and the task.
 *
 * That makes provisioning a hard precondition of the runtime, which is what this port is:
 *
 *  - `provision(tenantId)` runs as a step of `TenantService.create`, so a tenant is born with
 *    the set;
 *  - `resync(tenantId, options)` is the super-admin repair for a tenant that already exists —
 *    `POST /admin/tenants/:id/reference-set/sync`;
 *  - the one-shot backfill over every existing tenant is the same call in a loop
 *    (`packages/database/scripts/backfill-tenant-reference-set.ts`).
 *
 * What is NOT here, and why: `AiModel` (the catalogue is CONFIG and stays SYSTEM-shared-read —
 * OD-O), `GlobalSetting` (platform settings cascade tenant → SYSTEM at read time — OD-P),
 * `TenantGuardrailPolicy` (excluded precisely so ABSENCE stays meaningful — OD-R; a clone would
 * turn every tenant's "no opinion" into an opinion), and `DocumentTemplate` (already clone-only
 * through its own path).
 */

/** The kinds the reference set copies, in the order they MUST be copied. */
export const REFERENCE_SET_KINDS = ['contextSchemas', 'promptTemplates', 'agents', 'agentAssignments', 'workflowDefinitions'] as const;

export type ReferenceSetKind = (typeof REFERENCE_SET_KINDS)[number];

/**
 * `missing-only` adds what the tenant lacks and NEVER touches a row it already has — the mode
 * provisioning and the backfill both use, and the only mode that is safe to run unattended.
 *
 * `refresh-locked` is DECLARED but NOT IMPLEMENTED (TASK-890 wave-3 close). Its intent is to
 * additionally re-copy rows that are still `templateLocked` (pristine clones) and never touch an
 * UNLOCKED one — unlocked means the tenant edited it, or the lineage could not be proven
 * pristine, and both mean hands off; the same semantics as `PipelineTemplateResyncService`, for
 * the same reason. Until it exists, a run asking for it reconciles MISSING-ONLY and says so in
 * `warnings` rather than reporting a fast-forward it did not perform.
 */
export type ReferenceSetSyncMode = 'missing-only' | 'refresh-locked';

export interface ReferenceSetKindOutcome {
  /** Rows the tenant did not have and now does. */
  added: number;
  /** Rows left exactly as they were (already present, or edited by the tenant). */
  skipped: number;
  /** Rows whose copy failed; the reason is in `warnings` and in the logs, never swallowed. */
  failed: number;
}

export interface ReferenceSetSummary {
  tenantId: string;
  mode: ReferenceSetSyncMode;
  kinds: Record<ReferenceSetKind, ReferenceSetKindOutcome>;
  /** One line per failure — a provisioning report a human can act on, not a stack trace. */
  warnings: string[];
}

export interface ReferenceSetSyncOptions {
  mode?: ReferenceSetSyncMode;
  /** Restrict the run to these kinds; absent ⇒ every kind, in {@link REFERENCE_SET_KINDS} order. */
  kinds?: readonly ReferenceSetKind[];
}

export interface ITenantReferenceSetService {
  /** Clone the whole reference set into a tenant, missing-only. Never throws for a per-row failure. */
  provision(tenantId: string): Promise<ReferenceSetSummary>;
  /** The explicit, super-admin repair of an EXISTING tenant. */
  resync(tenantId: string, options?: ReferenceSetSyncOptions): Promise<ReferenceSetSummary>;
}

export const ITenantReferenceSetService = Symbol('ITenantReferenceSetService');
