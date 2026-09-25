import { Injectable, Logger } from '@nestjs/common';
import {
  AgentModelFallbackRepository,
  AgentRepository,
  AiRoutingPolicyRepository,
  AiRoutingPolicyStatus,
  ResourceStatusType,
  TenantRepository,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import type { ModelResidencyUsage, ModelResidencyUse } from './dto';
import { ImplicitLivePathReader } from './implicit-live-path';

/**
 * TASK-1005 §13 — the REVERSE index the catalogue-first residency view shows
 * under each model: "who uses this model", across EVERY tenant.
 *
 * ── WHAT IT READS, EXACTLY ───────────────────────────────────────────────────
 *
 * Four explicit queries per refresh, for the set of SELF_HOSTED catalogue ids
 * the caller passes, and nothing per row:
 *
 *   1. `AgentModelFallback` — ENABLED, `enabled` links whose `modelId` is in the
 *      set (the `AgentModelFallback_modelId_idx` index);         ┐ in parallel
 *   2. `AiRoutingPolicy` — ACTIVE, `enabled`, not kill-switched   │
 *      rows whose `modelId` is in the set (guardrail / NLP /     │
 *      judge selections; `AiRoutingPolicy_modelId_idx`);        ┘
 *   3. `Agent` — the ACTIVE PUBLISHED ENABLED versions whose PRIMARY
 *      (`modelId`, `Agent_modelId_idx`) is in the set, OR that own a link
 *      from (1). A draft, a superseded version or a disabled row is not a
 *      consumer: nothing resolves to it at runtime;
 *   4. `Tenant` — the names of the tenants the uses belong to.
 *
 * Roles: `primary` (Agent.modelId), `fallback` (AgentModelFallback), `routing`
 * (AiRoutingPolicy — no agent behind it, so `agentSlug` is `null` and
 * `agentName` is the policy's display name or its task key).
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 *
 *  - NOT a tenant → SYSTEM cascade. It is a platform-infrastructure read (the
 *    `ImplicitLivePathReader` shape): the union of every tenant's OWN rows,
 *    SYSTEM included as one more tenant. It runs only inside a platform
 *    administrator's tenant-LESS request, where the tenant-scope extension
 *    passes through.
 *  - NOT per request. Consumers change on an administrator's timescale, so the
 *    index is cached platform-wide for `MODEL_USAGE_CACHE_MS` (one entry,
 *    keyed by the id set — a new catalogue model refreshes it at once). The
 *    `liveConsultation` marker is applied on EVERY read from the live-path
 *    reader's own (60 s) cache, so it never lags that reader.
 *
 * A failed refresh serves the last index with a warning (a stale "used by" is
 * better than an empty one, which would read as "safe to unload"); with
 * nothing cached the failure propagates — the view fails, it does not lie.
 */

/** The reverse index is cached this long, platform-wide (≥ 30 s by design). */
export const MODEL_USAGE_CACHE_MS = 30_000;

/** The reverse index: `get` never answers undefined — a model nothing uses has an empty usage. */
export interface ModelResidencyUsageIndex {
  get(aiModelId: string): ModelResidencyUsage;
}

type RawUse = Omit<ModelResidencyUse, 'liveConsultation'>;

@Injectable()
export class ModelUsageIndexReader {
  private readonly logger = new Logger(ModelUsageIndexReader.name);
  private cached: { at: number; key: string; uses: Map<string, RawUse[]> } | null = null;

  constructor(
    private readonly agents: AgentRepository,
    private readonly fallbacks: AgentModelFallbackRepository,
    private readonly routing: AiRoutingPolicyRepository,
    private readonly tenants: TenantRepository,
    private readonly livePath: ImplicitLivePathReader,
  ) {}

  async read(aiModelIds: string[], now = Date.now()): Promise<ModelResidencyUsageIndex> {
    const ids = [...new Set(aiModelIds)].sort();
    const [uses, liveAgents] = await Promise.all([this.rawUses(ids, now), this.livePath.readLiveAgents(now)]);
    return {
      get(aiModelId: string): ModelResidencyUsage {
        const list = (uses.get(aiModelId) ?? []).map((use) => ({
          ...use,
          liveConsultation: use.role === 'primary' && use.agentSlug !== null && liveAgents.has(`${use.tenantId}|${use.agentSlug}`),
        }));
        return {
          agentCount: new Set(list.filter((u) => u.agentSlug !== null).map((u) => `${u.tenantId}|${u.agentSlug}`)).size,
          tenantCount: new Set(list.map((u) => u.tenantId)).size,
          liveConsultation: list.some((u) => u.liveConsultation),
          uses: list,
        };
      },
    };
  }

  private async rawUses(ids: string[], now: number): Promise<Map<string, RawUse[]>> {
    if (ids.length === 0) return new Map();
    const key = ids.join(',');
    if (this.cached && this.cached.key === key && now - this.cached.at < MODEL_USAGE_CACHE_MS) return this.cached.uses;
    try {
      const uses = await this.load(ids);
      this.cached = { at: now, key, uses };
      return uses;
    } catch (error) {
      if (!this.cached) throw error;
      this.logger.warn({
        message: 'residency.usage_index.refresh_failed — serving the last index',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.cached.uses;
    }
  }

  private async load(ids: string[]): Promise<Map<string, RawUse[]>> {
    const [links, routes] = await Promise.all([
      this.fallbacks.findAll({ filters: { modelId: { in: ids }, enabled: true, resourceStatus: ResourceStatusType.ENABLED } as never }),
      this.routing.findAll({
        filters: {
          modelId: { in: ids },
          status: AiRoutingPolicyStatus.ACTIVE,
          enabled: true,
          killSwitch: false,
          resourceStatus: ResourceStatusType.ENABLED,
        } as never,
      }),
    ]);

    const linkedAgentIds = [...new Set(links.map((l) => l.agentId))];
    const agents = await this.agents.findAll({
      filters: {
        isActive: true,
        status: WorkflowDefinitionStatus.PUBLISHED,
        resourceStatus: ResourceStatusType.ENABLED,
        OR: [{ modelId: { in: ids } }, ...(linkedAgentIds.length > 0 ? [{ id: { in: linkedAgentIds } }] : [])],
      } as never,
    });

    const wanted = new Set(ids);
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const pending: Array<{ modelId: string; use: Omit<RawUse, 'tenantName'> }> = [];
    for (const agent of agents) {
      if (wanted.has(agent.modelId)) {
        pending.push({
          modelId: agent.modelId,
          use: { tenantId: agent.tenantId, agentSlug: agent.slug, agentName: agent.name, task: String(agent.task), role: 'primary' },
        });
      }
    }
    for (const link of links) {
      const agent = agentById.get(link.agentId);
      if (!agent) continue; // the link belongs to a draft or superseded version
      pending.push({
        modelId: link.modelId,
        use: { tenantId: agent.tenantId, agentSlug: agent.slug, agentName: agent.name, task: String(agent.task), role: 'fallback' },
      });
    }
    for (const route of routes) {
      if (!route.modelId) continue;
      pending.push({
        modelId: route.modelId,
        use: { tenantId: route.tenantId, agentSlug: null, agentName: route.displayName || route.taskKey, task: route.taskKey, role: 'routing' },
      });
    }

    const tenantIds = [...new Set(pending.map((p) => p.use.tenantId))];
    const tenants = tenantIds.length > 0 ? await this.tenants.findAll({ filters: { id: { in: tenantIds } } as never }) : [];
    const names = new Map(tenants.map((t) => [t.id, t.name]));

    const out = new Map<string, RawUse[]>();
    for (const { modelId, use } of pending) {
      const list = out.get(modelId) ?? [];
      list.push({ ...use, tenantName: names.get(use.tenantId) ?? use.tenantId });
      out.set(modelId, list);
    }
    return out;
  }
}
