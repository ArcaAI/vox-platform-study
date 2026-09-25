import { Injectable, Logger } from '@nestjs/common';
import {
  AgentAssignmentRepository,
  AgentRepository,
  AgentTask,
  AiModelRepository,
  ResourceStatusType,
  WorkflowDefinitionStatus,
} from '@arcaai/domains';
import type { ResidencyControlledService } from './model-residency.types';

/**
 * TASK-1005 §5.2 / D-4 — which models are IMPLICITLY PINNED because they back
 * the live consultation path.
 *
 * ── WHAT IT READS, EXACTLY ───────────────────────────────────────────────────
 *
 * An explicit PLATFORM-INFRASTRUCTURE read across every tenant, in three
 * queries, and nothing else:
 *
 *   1. every ENABLED `AgentAssignment` whose task is `SPEECH_TO_TEXT` or
 *      `TEXT_GENERATION` — any tenant (SYSTEM included), any scope, any
 *      selector;
 *   2. the ACTIVE `PUBLISHED` `Agent` row each assignment names
 *      (`tenantId` + `slug`);
 *   3. the `AiModel` each such agent names as its PRIMARY (`Agent.modelId`).
 *
 * A `SPEECH_TO_TEXT` primary pins `(stt, AiModel.slug)` — the key stt caches
 * the model under (`models.asr.slug` of the resolved spec). A
 * `TEXT_GENERATION` primary served by LM Studio pins
 * `(lm-studio, AiModel.wireModelId)` — the engine's exact key. Anything else
 * (a cloud primary, a fallback, a TTS or NER agent) is not pinned.
 *
 * ── WHAT IT DELIBERATELY IS NOT ─────────────────────────────────────────────
 *
 *  - NOT a tenant → SYSTEM cascade. No tenant's resolution order is replayed;
 *    the question is "which models could ANY tenant's live path need", which
 *    is the union over every tenant's own rows. Content stays cloned
 *    (rule 00 §"Content is cloned; configuration cascades"): SYSTEM rows are
 *    read here only because SYSTEM is one more tenant with assignments.
 *  - NOT an exact reconstruction of the live-summary node. The live summary
 *    runs the agent a governing workflow's realtime `core.agent` node names;
 *    replaying every tenant's workflow graphs on a 10 s loop is out of
 *    proportion to a pin. The `TEXT_GENERATION` assignment (the seeded
 *    `general-medicine-summarization` and the `phase:pre-summary` selector) is
 *    the proxy — an OVER-approximation in the safe direction (pinning a model
 *    that is not on the path costs memory, never a cold load).
 *
 * Runs outside any request CLS (the tenant-scope extension passes through) or
 * inside a platform admin's tenant-less request (elevated pass-through).
 * Cached for `CACHE_MS`: assignments change on an admin's timescale, not the
 * decision loop's.
 */

export interface LivePathModel {
  service: Extract<ResidencyControlledService, 'stt' | 'lm-studio'>;
  modelRef: string;
  aiModelId: string;
  /** The (first) agent that put it on the live path — for the stt load spec and for the audit trail. */
  tenantId: string;
  agentSlug: string;
}

const CACHE_MS = 60_000;
const LM_STUDIO_PROVIDERS = new Set(['lm-studio', 'lmstudio']);

@Injectable()
export class ImplicitLivePathReader {
  private readonly logger = new Logger(ImplicitLivePathReader.name);
  private cached: { at: number; models: LivePathModel[]; agentKeys: ReadonlySet<string> } | null = null;

  constructor(
    private readonly assignments: AgentAssignmentRepository,
    private readonly agents: AgentRepository,
    private readonly aiModels: AiModelRepository,
  ) {}

  /** The implicit live-path set. Never throws: an unreadable set is `[]` (nothing is implicitly pinned) plus a warning. */
  async read(now = Date.now()): Promise<LivePathModel[]> {
    return (await this.current(now)).models;
  }

  /**
   * TASK-1005 §13 — EVERY assigned agent (`${tenantId}|${slug}`) whose primary
   * put a model on the live path, from the same cached read. `read()` keeps one
   * entry per model (the first agent), which is enough to pin it but not to say
   * which of a model's consumers is the live one.
   */
  async readLiveAgents(now = Date.now()): Promise<ReadonlySet<string>> {
    return (await this.current(now)).agentKeys;
  }

  private async current(now: number): Promise<{ models: LivePathModel[]; agentKeys: ReadonlySet<string> }> {
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached;
    try {
      const loaded = await this.load();
      this.cached = { at: now, ...loaded };
      return loaded;
    } catch (error) {
      this.logger.warn({
        message: 'residency.live_path.read_failed — no model is implicitly pinned until the next read',
        error: error instanceof Error ? error.message : String(error),
      });
      return this.cached ?? { models: [], agentKeys: new Set() };
    }
  }

  /** Drop the cache (an admin changed an assignment and wants the view to follow now). */
  invalidate(): void {
    this.cached = null;
  }

  private async load(): Promise<{ models: LivePathModel[]; agentKeys: ReadonlySet<string> }> {
    const rows = await this.assignments.findAll({
      filters: {
        task: { in: [AgentTask.SPEECH_TO_TEXT, AgentTask.TEXT_GENERATION] },
        resourceStatus: ResourceStatusType.ENABLED,
      } as never,
    });
    if (rows.length === 0) return { models: [], agentKeys: new Set() };

    const pairs = new Map<string, { tenantId: string; slug: string; task: AgentTask }>();
    for (const row of rows)
      pairs.set(`${row.tenantId}|${row.agentSlug}`, { tenantId: row.tenantId, slug: row.agentSlug, task: row.task as AgentTask });

    const agents = await this.agents.findAll({
      filters: {
        OR: [...pairs.values()].map(({ tenantId, slug }) => ({ tenantId, slug })),
        isActive: true,
        status: WorkflowDefinitionStatus.PUBLISHED,
        resourceStatus: ResourceStatusType.ENABLED,
      } as never,
    });
    if (agents.length === 0) return { models: [], agentKeys: new Set() };

    const models = await this.aiModels.findAll({ filters: { id: { in: [...new Set(agents.map((a) => a.modelId))] } } as never });
    const byId = new Map(models.map((m) => [m.id, m]));

    const out = new Map<string, LivePathModel>();
    const agentKeys = new Set<string>();
    for (const agent of agents) {
      const model = byId.get(agent.modelId);
      if (!model) continue;
      let entry: LivePathModel | null = null;
      if (agent.task === AgentTask.SPEECH_TO_TEXT) {
        entry = { service: 'stt', modelRef: model.slug, aiModelId: model.id, tenantId: agent.tenantId, agentSlug: agent.slug };
      } else if (agent.task === AgentTask.TEXT_GENERATION && model.provider && LM_STUDIO_PROVIDERS.has(model.provider) && model.wireModelId) {
        entry = { service: 'lm-studio', modelRef: model.wireModelId, aiModelId: model.id, tenantId: agent.tenantId, agentSlug: agent.slug };
      }
      if (!entry) continue;
      agentKeys.add(`${agent.tenantId}|${agent.slug}`);
      if (!out.has(`${entry.service}|${entry.modelRef}`)) out.set(`${entry.service}|${entry.modelRef}`, entry);
    }
    return { models: [...out.values()], agentKeys };
  }
}
