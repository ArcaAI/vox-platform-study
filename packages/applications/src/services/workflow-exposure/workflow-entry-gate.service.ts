import { BadRequestException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { WorkflowDefinitionRepository } from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { effectiveExposureSettings, isWorkflowEntryAllowed, type WorkflowEntry } from '../workflow-definition/exposure-settings';

/**
 * TASK-1036 (OD-4) — does a workflow VERSION admit an entry point under its effective settings?
 *
 * The exposure service enforces this inline at invoke. The socket ticket route lives in a
 * controller that holds no definition, so this is the same decision, asked by `(slug, version)`.
 * It reads the version the RUN belongs to (a later republish must not change what an old run
 * allows), falling back to the tenant's ACTIVE version when that row is no longer PUBLISHED.
 *
 * A definition with no settings at all (`origin: 'legacy'`, D-4) or no readable row is NOT gated
 * here: the legacy trigger/output checks own that case, and ownership of the run was proved
 * before this is asked.
 */
@Injectable()
export class WorkflowEntryGateService {
  constructor(
    private readonly workflowDefinitionRepository: WorkflowDefinitionRepository,
    private readonly cls: ClsService,
  ) {}

  /** @throws BadRequestException `MODE_UNSUPPORTED` when the settings do not admit `entry`. */
  async assertEntryAllowed(slug: string, versionNumber: number, entry: WorkflowEntry): Promise<void> {
    const tenantId = this.cls.get<string | undefined>('tenantId');
    if (!tenantId) throw new ArgumentInvalidException('Tenant context required');

    const definition =
      (await this.workflowDefinitionRepository.findPublishedBySlugVersion(tenantId, slug, versionNumber)) ??
      (await this.workflowDefinitionRepository.findPublishedBySlug(tenantId, slug));
    if (!definition) return;

    const exposure = effectiveExposureSettings({ compiledConfig: definition.compiledConfig, graph: definition.graph });
    if (exposure.origin === 'legacy' || isWorkflowEntryAllowed(exposure, entry)) return;
    throw new BadRequestException({
      code: 'MODE_UNSUPPORTED',
      message: `The '${entry}' connection is not enabled for workflow '${slug}'; it admits [${exposure.connections.join(', ')}]. Enable it in the workflow settings, or use SSE.`,
    });
  }
}
