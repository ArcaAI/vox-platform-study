import { Injectable } from '@nestjs/common';
import {
  AgentModelFallbackRepository,
  AgentRepository,
  AgentTask,
  AiRoutingPolicyRepository,
  ModelResidencyPolicyRepository,
  ResourceStatusType,
  UserVoiceProfileRepository,
} from '@arcaai/domains';
import type { ModelReferrer } from './model-lifecycle.types';

/**
 * Where an ASR agent names an auxiliary registry model BY SLUG.
 *
 * MIRRORED from `ASR_AUX_MODEL_PATHS` in `services/agent/agent-resolver.service.ts`
 * (module-private there): the resolver refuses a session when one of these slugs
 * stops resolving, so a model named here is in use exactly as much as a primary.
 */
export const ASR_SUBMODEL_SLUG_PATHS: ReadonlyArray<{ role: string; path: readonly string[] }> = [
  { role: 'vad', path: ['audioFrontEnd', 'vad', 'modelSlug'] },
  { role: 'denoise', path: ['audioFrontEnd', 'denoise', 'modelSlug'] },
  { role: 'embedding', path: ['audioFrontEnd', 'diarization', 'embeddingModelSlug'] },
  { role: 'punctuation', path: ['postProcessing', 'punctuation', 'modelSlug'] },
  { role: 'endpointing', path: ['streaming', 'semantic', 'modelSlug'] },
];

const NOT_DELETED = { not: ResourceStatusType.DELETED };

function dig(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * "Who still points at this model?" — across EVERY tenant (TASK-1019 D-7).
 *
 * The union of each tenant's own rows, read through the domain repositories on
 * the tenant-scoped client. It is only ever reached behind
 * `assertPlatformRegistryAdmin` — a SUPER_ADMIN with NO working tenant — which
 * is exactly the context the tenant-scope extension passes through, so every
 * tenant's rows are visible (the `ModelUsageIndexReader` shape residency uses).
 *
 * Deliberately wider than residency's "who uses it" index: a draft, a
 * superseded version or a disabled policy still references the row (every FK is
 * `onDelete: Restrict`), and a slug reference silently breaks the next resolve.
 * Only soft-DELETED referrers are ignored.
 */
@Injectable()
export class ModelUsageReader {
  constructor(
    private readonly agents: AgentRepository,
    private readonly fallbacks: AgentModelFallbackRepository,
    private readonly routing: AiRoutingPolicyRepository,
    private readonly residencyPolicies: ModelResidencyPolicyRepository,
    private readonly voiceProfiles: UserVoiceProfileRepository,
  ) {}

  async referrersOf(model: { id: string; slug: string }): Promise<ModelReferrer[]> {
    const [primaries, links, routes, residency, asrAgents, profiles] = await Promise.all([
      this.agents.findAll({ filters: { modelId: model.id, resourceStatus: NOT_DELETED } as never }),
      this.fallbacks.findAll({ filters: { modelId: model.id, resourceStatus: NOT_DELETED } as never }),
      this.routing.findAll({ filters: { modelId: model.id, resourceStatus: NOT_DELETED } as never }),
      this.residencyPolicies.findAll({ filters: { aiModelId: model.id, resourceStatus: NOT_DELETED } as never }),
      this.agents.findAll({ filters: { task: AgentTask.SPEECH_TO_TEXT, resourceStatus: NOT_DELETED } as never }),
      this.voiceProfiles.findAll({ filters: { modelId: model.slug, resourceStatus: NOT_DELETED } as never }),
    ]);

    const referrers: ModelReferrer[] = [];
    for (const agent of primaries) {
      referrers.push({ kind: 'agent', tenantId: agent.tenantId, id: agent.id, name: `${agent.name} (${agent.slug} v${agent.versionNumber})` });
    }

    const linkedAgentIds = [...new Set(links.map((link) => link.agentId))];
    const linkedAgents = linkedAgentIds.length ? await this.agents.findAll({ filters: { id: { in: linkedAgentIds } } as never }) : [];
    const agentById = new Map(linkedAgents.map((agent) => [agent.id, agent]));
    for (const link of links) {
      const agent = agentById.get(link.agentId);
      referrers.push({
        kind: 'agent-fallback',
        tenantId: link.tenantId,
        id: link.agentId,
        name: agent
          ? `${agent.name} (${agent.slug} v${agent.versionNumber}) — fallback #${link.priority}`
          : `agent ${link.agentId} — fallback #${link.priority}`,
      });
    }

    for (const agent of asrAgents) {
      const compiled = (agent.compiledConfig as { parameters?: unknown } | null | undefined)?.parameters;
      const roles = ASR_SUBMODEL_SLUG_PATHS.filter(
        ({ path }) => dig(agent.parameters, path) === model.slug || dig(compiled, path) === model.slug,
      ).map(({ role }) => role);
      if (roles.length === 0) continue;
      referrers.push({
        kind: 'agent-asr-submodel',
        tenantId: agent.tenantId,
        id: agent.id,
        name: `${agent.name} (${agent.slug} v${agent.versionNumber}) — ${roles.join(', ')}`,
      });
    }

    for (const policy of routes) {
      referrers.push({ kind: 'routing-policy', tenantId: policy.tenantId, id: policy.id, name: policy.displayName || policy.taskKey });
    }
    for (const policy of residency) {
      referrers.push({ kind: 'residency-policy', tenantId: policy.tenantId, id: policy.id, name: `${policy.service} residency (${policy.class})` });
    }
    for (const profile of profiles) {
      referrers.push({
        kind: 'voice-profile',
        tenantId: profile.tenantId,
        id: profile.id,
        name: profile.label || `voice profile of user ${profile.userId}`,
      });
    }
    return referrers;
  }
}
