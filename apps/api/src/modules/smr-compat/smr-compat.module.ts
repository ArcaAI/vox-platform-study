import { HttpModule } from '@nestjs/axios';
import { DnaWritingStyleServiceModule, HarnessPolicyServiceModule, PromptResolutionServiceModule } from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { SmrCompatController } from './smr-compat.controller';
import { SmrCompatTemplateService } from './smr-compat-template.service';

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
    // TASK-592: real tenant Department → governed instruction-template resolution.
    PromptResolutionServiceModule,
    // TASK-599: requesting doctor's DNA writing-style resolution (IDnaWritingStyleService).
    DnaWritingStyleServiceModule,
    CoreDatabaseModule,
  ],
  controllers: [SmrCompatController],
  providers: [SmrCompatTemplateService],
})
export class SmrCompatModule {}
