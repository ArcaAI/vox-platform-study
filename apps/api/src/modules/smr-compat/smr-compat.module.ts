import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { SmrCompatController } from './smr-compat.controller';

/**
 * v1-compatible SMR summary gateway shims (TASK-562).
 *
 * `IConfigService` (SMR base URL) and `SecretsService` (`SMR_SERVICE_TOKEN`)
 * are provided app-wide by the `@Global()` `CommonServiceModule` imported in
 * `AppModule`, so this module only needs its own `HttpModule` registration and
 * the controller. `ClsService` comes from the global `ClsModule`.
 *
 * Registered in `AppModule`; the two routes are added to the `setGlobalPrefix`
 * exclusion list in `main.ts` so `@Controller('api/smr/api/v1')` yields the
 * literal v1 paths `/api/smr/api/v1/summary/sync` and `/api/smr/api/v1/presummary`.
 */
@Module({
  imports: [
    HttpModule.register({
      timeout: 120_000,
      maxRedirects: 3,
    }),
  ],
  controllers: [SmrCompatController],
})
export class SmrCompatModule {}
