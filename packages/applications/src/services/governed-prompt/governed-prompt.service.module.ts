import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { GovernedPromptRegistryService } from './governed-prompt-registry.service';
import { GuardrailPromptScreenClient } from './guardrail-prompt-screen.client';
import { IGovernedPromptRegistry } from './IGovernedPromptRegistry';

/**
 * TASK-1047 FC-3 — the governed-prompt registry. Imported by the authoring surfaces (agent publish,
 * prompt-template approve, promote-to-system) and by the composers that ask `areGoverned`.
 *
 * Deliberately depends on no agent / prompt module (it reads the frozen artifacts through its own
 * repository), so every importer can take it without closing a module cycle. Nest instantiates a
 * module once, so the in-process verdict cache and the boot backfill are single per process.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigModule, HttpModule, EventEmitterModule, ClsModule],
  providers: [
    GuardrailPromptScreenClient,
    GovernedPromptRegistryService,
    { provide: IGovernedPromptRegistry, useExisting: GovernedPromptRegistryService },
  ],
  exports: [IGovernedPromptRegistry, GovernedPromptRegistryService],
})
export class GovernedPromptServiceModule {}
