import { WorkflowTestFixtureEntity } from '@arcaai/domains';
import { FetchResponse } from '../../common';
import { WorkflowTestFixtureResponse, PaginatedWorkflowTestFixtureResponse } from './dto';

export class WorkflowTestFixtureDtoMapper {
  static toResponse(entity: WorkflowTestFixtureEntity): WorkflowTestFixtureResponse {
    return {
      id: entity.id,
      name: entity.name,
      description: entity.description ?? undefined,
      paletteId: entity.paletteId ?? undefined,
      workflowDefinitionId: entity.workflowDefinitionId ?? undefined,
      input: (entity.input as Record<string, unknown>) ?? {},
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
