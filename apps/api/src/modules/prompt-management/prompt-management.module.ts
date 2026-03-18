import { Module } from '@nestjs/common';
import { PromptManagementServiceModule } from '@arcaai/applications';
import { PromptManagementController } from './prompt-management.controller';

@Module({
    imports: [PromptManagementServiceModule],
    controllers: [PromptManagementController],
})
export class PromptManagementModule {}
