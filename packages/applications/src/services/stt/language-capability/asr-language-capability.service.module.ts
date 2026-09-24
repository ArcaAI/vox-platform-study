import { Module } from '@nestjs/common';
import { AsrAgentResolverServiceModule } from '../agent-resolver/asr-agent-resolver.service.module';
import { StreamingSessionServiceModule } from '../streaming/streamingSession.service.module';
import { AsrLanguageCapabilityService } from './asr-language-capability.service';

/** TASK-1004 — per-agent language capability (catalog + configuration-time warnings). */
@Module({
  imports: [StreamingSessionServiceModule, AsrAgentResolverServiceModule],
  providers: [AsrLanguageCapabilityService],
  exports: [AsrLanguageCapabilityService],
})
export class AsrLanguageCapabilityServiceModule {}
