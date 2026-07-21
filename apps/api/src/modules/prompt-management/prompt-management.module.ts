import { Module } from '@nestjs/common';
import { PromptManagementServiceModule } from '@arcaai/applications';
import { PromptManagementController } from './prompt-management.controller';
// End-user (clinician) prompt-template plane, mounted
// alongside the admin controller in the same module (shared service).
import { PromptTemplateController } from './prompt-template.controller';

@Module({
  imports: [PromptManagementServiceModule],
  controllers: [PromptManagementController, PromptTemplateController],
})
export class PromptManagementModule {}
