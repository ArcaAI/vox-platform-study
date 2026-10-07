import { Injectable, Logger } from '@nestjs/common';
import { TenantRepository } from '@arcaai/domains';
import type { ModelResidencyUsage, ModelResidencyUse } from './dto';
import { ImplicitLivePathReader, MODEL_CONSUMER_CACHE_MS, type ModelConsumerSnapshot, type ModelConsumerUse } from './implicit-live-path';

/**
 * TASK-1005 §13, rebuilt by TASK-1051 (F2, F3) — the REVERSE index the catalogue-first
 * residency view shows under each model: "who uses this model", across EVERY tenant.
 *
 * ── WHERE IT COMES FROM ──────────────────────────────────────────────────────
 *
 * It is a PROJECTION of `ImplicitLivePathReader.readSnapshot()` — the one platform-wide consumer
 * snapshot that also yields the implicit live-path pin set — plus one `Tenant` read for the
 * tenant names. Because both come from one snapshot, `usage.liveConsultation` is true exactly
 * when the model is in the pin set; the catalogue can no longer say "Always loaded — live
 * consultation" over a model with no consumer, or "on demand" over a guardrail judge.
 *
 * Roles (see `implicit-live-path.ts` for the exact rules): `primary`, `fallback`, `routing`
 * (`agentSlug` null, `agentName` = the policy's display name or task key), `pipeline_stage`
 * (`agentSlug`/`agentName` = the ASR agent, `task` = `SPEECH_TO_TEXT · vad`), `workflow_node`
 * (`agentName` = `<workflow name> › <node label or id>`, `agentSlug` = the node's agent).
 *
 * Counts: `agentCount` = distinct agents among `primary` + `fallback` uses (its TASK-1005
 * meaning); `tenantCount` = distinct tenants across ALL uses; `consumers` counts each kind —
 * distinct primary agents, distinct agents holding a fallback, routing-policy rows, distinct ASR
 * agents using it as a stage, distinct (workflow, node) pairs.
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 *
 *  - NOT a tenant → SYSTEM cascade: the union of every tenant's own rows, SYSTEM included as one
 *    more tenant, read inside a platform administrator's tenant-LESS request.
 *  - NOT per request: the snapshot is cached platform-wide for `MODEL_USAGE_CACHE_MS`
 *    (= `MODEL_CONSUMER_CACHE_MS`), for EVERY id set — the snapshot covers every model, so a new
 *    catalogue model needs no re-read. Tenant names are re-read only when the snapshot changes.
 *
 * A failed refresh serves the last snapshot with a warning (a stale "used by" is better than an
 * empty one, which would read as "safe to unload"); with nothing cached the failure propagates —
 * the view fails, it does not lie.
 */

/** The reverse index is cached this long, platform-wide (≥ 30 s by design) — the consumer snapshot's own window. */
export const MODEL_USAGE_CACHE_MS = MODEL_CONSUMER_CACHE_MS;

/** The reverse index: `get` never answers undefined — a model nothing uses has an empty usage. */
export interface ModelResidencyUsageIndex {
  get(aiModelId: string): ModelResidencyUsage;
}

const EMPTY_INDEX: ModelResidencyUsageIndex = { get: () => project([], new Map()) };

function distinct(uses: readonly ModelConsumerUse[], role: ModelConsumerUse['role']): number {
  return new Set(uses.filter((u) => u.role === role).map((u) => u.consumerKey)).size;
}

function project(uses: readonly ModelConsumerUse[], names: ReadonlyMap<string, string>): ModelResidencyUsage {
  const list: ModelResidencyUse[] = uses.map(({ tenantId, agentSlug, agentName, task, role, liveConsultation }) => ({
    tenantId,
    tenantName: names.get(tenantId) ?? tenantId,
    agentSlug,
    agentName,
    task,
    role,
    liveConsultation,
  }));
  return {
    agentCount: new Set(uses.filter((u) => u.role === 'primary' || u.role === 'fallback').map((u) => u.consumerKey)).size,
    tenantCount: new Set(uses.map((u) => u.tenantId)).size,
    liveConsultation: uses.some((u) => u.liveConsultation),
    uses: list,
    consumers: {
      agents: distinct(uses, 'primary'),
      fallbacks: distinct(uses, 'fallback'),
      routingPolicies: distinct(uses, 'routing'),
      pipelineStages: distinct(uses, 'pipeline_stage'),
      workflowNodes: distinct(uses, 'workflow_node'),
    },
  };
}

@Injectable()
export class ModelUsageIndexReader {
  private readonly logger = new Logger(ModelUsageIndexReader.name);
  private names: { snapshot: ModelConsumerSnapshot; byId: ReadonlyMap<string, string> } | null = null;

  constructor(
    private readonly tenants: TenantRepository,
    private readonly livePath: ImplicitLivePathReader,
  ) {}

  async read(aiModelIds: string[], now = Date.now()): Promise<ModelResidencyUsageIndex> {
    if (aiModelIds.length === 0) return EMPTY_INDEX;
    const snapshot = await this.livePath.readSnapshot(now);
    const names = await this.tenantNames(snapshot);
    return { get: (aiModelId: string) => project(snapshot.uses.get(aiModelId) ?? [], names) };
  }

  private async tenantNames(snapshot: ModelConsumerSnapshot): Promise<ReadonlyMap<string, string>> {
    if (this.names?.snapshot === snapshot) return this.names.byId;
    const ids = [...new Set([...snapshot.uses.values()].flatMap((list) => list.map((u) => u.tenantId)))];
    try {
      const rows = ids.length > 0 ? await this.tenants.findAll({ filters: { id: { in: ids } } as never }) : [];
      this.names = { snapshot, byId: new Map(rows.map((t) => [t.id, t.name])) };
      return this.names.byId;
    } catch (error) {
      if (!this.names) throw error;
      this.logger.warn({
        message: 'residency.usage_index.tenant_names_failed — serving the last names',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.names.byId;
    }
  }
}
