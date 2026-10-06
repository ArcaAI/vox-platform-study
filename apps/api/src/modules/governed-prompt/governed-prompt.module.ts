import { Module } from '@nestjs/common';
import { GovernedPromptServiceModule, TenantLockModule } from '@arcaai/applications';
import { HarnessServiceTokenGuard } from '../consultation/harness-service-token.guard';
import { GovernedPromptInternalController } from './governed-prompt-internal.controller';

/** TASK-1047 L12 — `POST internal/governed-prompts/verify` (the harness's FC-6 verification). */
@Module({
  imports: [GovernedPromptServiceModule, TenantLockModule],
  controllers: [GovernedPromptInternalController],
  // Applied via `@UseGuards`, but provided here so Nest can inject SecretsService into it.
  providers: [HarnessServiceTokenGuard],
})
export class GovernedPromptModule {}
