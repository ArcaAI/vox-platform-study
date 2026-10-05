import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { RedisCacheModule } from '../baseServices/redis';
import { EffectiveSettingsModule } from '../settings-registry/effective-settings.module';
import { GoverningWorkflowAsrReader } from '../stt/agent-resolver/governing-workflow-asr';
import { WorkflowRunServiceModule } from '../workflow-run';
import { RunAudioBindingService } from './run-audio-binding.service';
import { RunAudioTranscriptService } from './run-audio-transcript.service';

/**
 * TASK-1042 — live audio into standalone workflow runs.
 *
 * - `RunAudioBindingService` (the exposure plane's `invoke`): C3 checks + the OCC bind.
 * - `RunAudioTranscriptService` (the gateway's internal C5 route): the bound session's finals.
 *
 * Kept OUT of `WorkflowExposureServiceModule`'s own provider list so the internal route can import
 * it without the whole exposure plane. `GoverningWorkflowAsrReader` (the graph's STT node agent) is
 * provided here from its leaf: it is stateless and reads only `CoreDatabaseModule` repositories, so
 * importing `AsrAgentResolverServiceModule` (agents + provider connections) would buy nothing.
 */
@Module({
  imports: [CoreDatabaseModule, RedisCacheModule.register(), EffectiveSettingsModule, WorkflowRunServiceModule],
  providers: [RunAudioBindingService, RunAudioTranscriptService, GoverningWorkflowAsrReader],
  exports: [RunAudioBindingService, RunAudioTranscriptService],
})
export class RunAudioServiceModule {}
