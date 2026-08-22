import { Module } from '@nestjs/common';
import { WorkflowInvariantRuleServiceModule } from '@arcaai/applications';
import { WorkflowInvariantRuleController } from './workflow-invariant-rule.controller';

@Module({
  imports: [WorkflowInvariantRuleServiceModule],
  controllers: [WorkflowInvariantRuleController],
})
export class WorkflowInvariantRuleModule {}
