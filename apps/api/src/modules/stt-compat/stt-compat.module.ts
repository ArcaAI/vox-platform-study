import { Module } from '@nestjs/common';
import { PipelineServiceModule, StreamingSessionServiceModule, TenantSttConfigServiceModule } from '@arcaai/applications';
import { TenantOwnedResourceModule } from '../../common';
import { SttCompatController } from './stt-compat.controller';
import { SttCompatSessionMetadataService } from './stt-compat-session-metadata.service';
import { SttCompatGateway } from './stt-compat.gateway';

@Module({
  imports: [PipelineServiceModule, StreamingSessionServiceModule, TenantSttConfigServiceModule, TenantOwnedResourceModule],
  controllers: [SttCompatController],
  providers: [SttCompatGateway, SttCompatSessionMetadataService],
})
export class SttCompatModule {}
