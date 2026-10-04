import { Injectable, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { AgentRepository, ResourceStatusType, WorkflowDefinitionRepository, WorkflowDefinitionStatus } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import type { AgentUsageResponse } from './dto/agent-usage.response';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Every compiled node of a workflow artifact — its stages and each `core.loop` body. */
function* compiledNodes(compiledConfig: unknown): Generator<Record<string, unknown>> {
  const config = asRecord(compiledConfig);
  if (!config) return;
  const stageLists: unknown[] = [config.stages];
  if (Array.isArray(config.loops)) for (const loop of config.loops) stageLists.push(asRecord(asRecord(loop)?.body)?.stages);
  for (const stages of stageLists) {
    if (!Array.isArray(stages)) continue;
    for (const stage of stages) {
      const nodes = asRecord(stage)?.nodes;
      if (!Array.isArray(nodes)) continue;
      for (const node of nodes) {
        const record = asRecord(node);
        if (record) yield record;
      }
    }
  }
}

/** Does this artifact pin `slug` at `versionNumber` in one of its `core.agent` nodes? */
function pinsAgentVersion(compiledConfig: unknown, slug: string, versionNumber: number): boolean {
  for (const node of compiledNodes(compiledConfig)) {
    if (node.type !== 'core.agent') continue;
    const agentRef = asRecord(asRecord(node.config)?.agentRef);
    if (agentRef?.slug === slug && agentRef.versionNumber === versionNumber) return true;
  }
  return false;
}

/**
 * TASK-1036 OD-21 — "used by N published workflows".
 *
 * A pinned agent version keeps running after it is deprecated, so the Deprecate action warns with
 * this count first. It reads the CALLER tenant's PUBLISHED and DEPRECATED workflow versions and
 * keeps those whose frozen artifact (`compiledConfig`) pins exactly `slug@versionNumber` in a
 * `core.agent` node — the artifact, not the authored graph, because the artifact is what runs.
 * An unpinned reference (no `versionNumber`) follows the active version and is not counted.
 *
 * The agent version must belong to the caller's own lineage: an unknown version, a draft-less
 * lineage, or another tenant's slug is one 404 (404-over-403), via the tenant-filtered
 * `findAllVersionsBySlug`.
 */
@Injectable()
export class AgentUsageService {
  constructor(
    private readonly agentRepository: AgentRepository,
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly cls: ClsService,
  ) {}

  async usage(slug: string, versionNumber: number): Promise<AgentUsageResponse> {
    const tenantId = this.cls.get<string | undefined>('tenantId');
    if (!tenantId) throw new ArgumentInvalidException('Tenant context required');

    const versions = await this.agentRepository.findAllVersionsBySlug(tenantId, slug);
    if (!versions.some((row) => row.versionNumber === versionNumber)) throw new NotFoundException('Agent version not found');

    const rows = [];
    for (const status of [WorkflowDefinitionStatus.PUBLISHED, WorkflowDefinitionStatus.DEPRECATED]) {
      rows.push(...(await this.workflowDefinitionRepository.findAll({ filters: { tenantId, status, resourceStatus: ResourceStatusType.ENABLED } })));
    }
    const publishedWorkflows = rows
      .filter((row) => pinsAgentVersion(row.compiledConfig, slug, versionNumber))
      .map((row) => ({ slug: row.slug, versionNumber: row.versionNumber, isActive: row.isActive === true }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.versionNumber - b.versionNumber);
    return { publishedWorkflows, count: publishedWorkflows.length };
  }
}
