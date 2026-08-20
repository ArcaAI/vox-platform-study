import { AiModelServiceModule, CommonServiceModule } from '@arcaai/applications';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { AiModelAdminController } from './ai-model-admin.controller';
import { AiModelDiscoveryController } from './ai-model-discovery.controller';
import { AiModelDiscoveryService } from './ai-model-discovery.service';

/**
 * Wires the admin AI model controller to the
 * already-existing `AiModelService`. Mirrors `PipelineModule`.
 *
 * Also wires the discovery surface (merge view + explicit register). It needs
 * `HttpModule` to reach TEXT's provider aggregator and `CommonServiceModule` for
 * `IConfigService` (`TEXT_URL`) / `SecretsService` — direct `process.env` reads
 * for downstream URLs are lint-banned in `src/modules/**`.
 */
@Module({
  imports: [AiModelServiceModule, CommonServiceModule, HttpModule],
  // ORDER MATTERS: Nest registers routes in controller order,
  // and `AiModelAdminController` carries `GET ':id'` — if it registers first it
  // captures `GET admin/ai-models/discovery` as id="discovery" (404). The
  // discovery controller's static paths must register BEFORE the `:id` family
  // (same static-route-wins rule as the settings registry).
  controllers: [AiModelDiscoveryController, AiModelAdminController],
  providers: [AiModelDiscoveryService],
})
export class AiModelModule {}
