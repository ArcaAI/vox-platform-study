import { WorkflowTestFixtureEntity } from '@arcaai/domains';
import { FetchResponse } from '../../common';
import { WorkflowTestFixtureResponse, PaginatedWorkflowTestFixtureResponse } from './dto';

/** Opt-in disclosure of the decrypted payload — see {@link WorkflowTestFixtureDtoMapper.toResponse}. */
export interface WorkflowTestFixtureProjectionOptions {
  includeInput?: boolean;
}

export class WorkflowTestFixtureDtoMapper {
  /**
   * PHI-safe by DEFAULT: `input` is Vault-Transit encrypted at rest (TASK-721
   * R4) and is projected ONLY when the call site opts in with
   * `{ includeInput: true }` — the id-scoped, tenant-asserted, audited reads.
   * List pages and delete acknowledgements leave it out entirely, mirroring
   * `EvalService`'s PHI-safe `goldenCaseToMetaResponse`. Defaulting to OMIT
   * means a new call site fails safe.
   */
  static toResponse(entity: WorkflowTestFixtureEntity, options: WorkflowTestFixtureProjectionOptions = {}): WorkflowTestFixtureResponse {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description ?? undefined,
      paletteId: entity.paletteId ?? undefined,
      workflowDefinitionId: entity.workflowDefinitionId ?? undefined,
      ...(options.includeInput ? { input: (entity.input as Record<string, unknown>) ?? {} } : {}),
      resourceStatus: entity.resourceStatus ?? undefined,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt.toISOString(),
      version: entity.version,
    };
  }

  static toPaginatedResponse({ page, limit, count, data }: FetchResponse<WorkflowTestFixtureEntity>): PaginatedWorkflowTestFixtureResponse {
    return new PaginatedWorkflowTestFixtureResponse({
      page,
      limit,
      count,
      data: data.map((entity) => this.toResponse(entity)),
    });
  }
}
