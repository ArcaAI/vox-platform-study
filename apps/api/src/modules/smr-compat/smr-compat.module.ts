import { HttpModule } from '@nestjs/axios';
import { HarnessPolicyServiceModule } from '@arcaai/applications';
import { Module } from '@nestjs/common';
import { SmrCompatController } from './smr-compat.controller';

/**
 * v1-compatible SMR summary gateway shims (TASK-562).
 *
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
    HarnessPolicyServiceModule,
  ],
  controllers: [SmrCompatController],
})
export class SmrCompatModule {}
