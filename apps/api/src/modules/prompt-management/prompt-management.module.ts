import { Module } from '@nestjs/common';
import { PromptManagementServiceModule } from '@arcaai/applications';
import { PromptManagementController } from './prompt-management.controller';
// TASK-331 doc-09 — end-user (clinician) prompt-template plane, mounted
// alongside the admin controller in the same module (shared service).
import { PromptTemplateController } from './prompt-template.controller';

@Module({
  imports: [PromptManagementServiceModule],
  controllers: [PromptManagementController, PromptTemplateController],
})
export class PromptManagementModule {}
