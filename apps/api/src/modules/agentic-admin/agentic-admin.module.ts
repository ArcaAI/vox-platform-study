import { Module } from '@nestjs/common';
import { AgenticInstructionsServiceModule } from '@arcaai/applications';
import { AgenticAdminController } from './agentic-admin.controller';

/**
 * AgenticAdminModule (TASK-511 Phase 3A item 6) — mounts the `/admin/agentic/*`
 * read-only control-plane surface. `AgenticInstructionsServiceModule` supplies
 * the `IAgenticInstructionsService` aggregator; `ClsService` resolves from the
 * globally-registered `ClsModule`.
 */
@Module({
  imports: [AgenticInstructionsServiceModule],
  controllers: [AgenticAdminController],
})
export class AgenticAdminModule {}
