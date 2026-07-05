import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiServiceAdminController } from './ai-service-admin.controller';
import { AiServiceProxyClient } from './ai-service-proxy.client';

/**
 * AiServiceAdminModule (TASK-419 item 3) — the `/admin/ai-services/*` read-only
 * proxy plane over the Guardrail + NLP Python services. `IConfigService` is
 * global (ConfigModule.forRoot in AppModule), so only HttpModule is imported.
 */
@Module({
  imports: [HttpModule],
  controllers: [AiServiceAdminController],
  providers: [AiServiceProxyClient],
})
export class AiServiceAdminModule {}
