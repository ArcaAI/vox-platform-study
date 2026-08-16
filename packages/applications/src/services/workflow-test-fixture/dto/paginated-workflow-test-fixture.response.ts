import { ApiProperty } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';
import { WorkflowTestFixtureResponse } from './workflow-test-fixture.response';

export class PaginatedWorkflowTestFixtureResponse extends PaginatedResponse<WorkflowTestFixtureResponse> {
  @ApiProperty({ type: [WorkflowTestFixtureResponse] })
  override readonly data!: readonly WorkflowTestFixtureResponse[];
}
