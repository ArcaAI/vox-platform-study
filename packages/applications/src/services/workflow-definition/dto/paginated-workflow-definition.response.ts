import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { WorkflowDefinitionResponse } from './workflow-definition.response';

export class PaginatedWorkflowDefinitionResponse extends PaginatedResponse<WorkflowDefinitionResponse> {
  @ApiProperty({ type: [WorkflowDefinitionResponse] })
  override readonly data!: readonly WorkflowDefinitionResponse[];
}
