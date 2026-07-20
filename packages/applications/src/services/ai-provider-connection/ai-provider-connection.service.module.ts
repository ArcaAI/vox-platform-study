import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices/common.service.module';
import { IAiProviderConnectionService } from './IAiProviderConnectionService';
import { AiProviderConnectionService } from './ai-provider-connection.service';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [{ provide: IAiProviderConnectionService, useClass: AiProviderConnectionService }, AiProviderConnectionService],
  exports: [IAiProviderConnectionService, AiProviderConnectionService],
})
export class AiProviderConnectionServiceModule {}
