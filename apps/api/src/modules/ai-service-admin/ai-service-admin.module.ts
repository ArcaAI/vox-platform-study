import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { InferenceReadinessServiceModule } from '@arcaai/applications';
import { AiServiceAdminController } from './ai-service-admin.controller';
import { AiServiceProxyClient } from './ai-service-proxy.client';
import { MlflowProxyClient } from './mlflow-proxy.client';

/**
 * AiServiceAdminModule — the `/admin/ai-services/*` read-only
 * proxy plane over the Guardrail + NLP Python services and the MLflow tracking
 * server. `IConfigService` and `IAppSettingsService` are both global
 * (`ConfigModule.forRoot` / `AppSettingsModule.forRoot` in AppModule), so only
 * HttpModule is imported.
 *
 * `InferenceReadinessServiceModule` supplies the readiness sweep behind
 * `GET/POST admin/ai-services/readiness*` (TASK-890 §3.12). Importing it here is
 * also what STARTS the sweep: the module owns the `@Cron` provider, so the
 * platform's readiness observation exists because this read plane exists.
 */
@Module({
  imports: [HttpModule, InferenceReadinessServiceModule],
  controllers: [AiServiceAdminController],
  providers: [AiServiceProxyClient, MlflowProxyClient],
})
export class AiServiceAdminModule {}
