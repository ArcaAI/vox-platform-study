import { Module } from '@nestjs/common';
import {
  AsrAgentResolverServiceModule,
  PipelineServiceModule,
  StreamingSessionServiceModule,
  TenantSttConfigServiceModule,
} from '@arcaai/applications';
import { TenantOwnedResourceModule } from '../../common';
import { SttCompatController } from './stt-compat.controller';
import { SttCompatSessionMetadataService } from './stt-compat-session-metadata.service';
import { SttCompatGateway } from './stt-compat.gateway';

@Module({
  // TASK-861 — `AsrAgentResolverServiceModule` is the resolution path; `PipelineServiceModule`
  // and `TenantSttConfigServiceModule` serve only the deprecated `pipelineId` path (removed in R4).
  imports: [
    AsrAgentResolverServiceModule,
    PipelineServiceModule,
    StreamingSessionServiceModule,
    TenantSttConfigServiceModule,
    TenantOwnedResourceModule,
  ],
  controllers: [SttCompatController],
  providers: [SttCompatGateway, SttCompatSessionMetadataService],
})
export class SttCompatModule {}
