import { HttpModule } from '@nestjs/axios';
import {
  AiProviderConnectionServiceModule,
  DnaWritingStyleServiceModule,
  HarnessPolicyServiceModule,
  PromptResolutionServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { SmrCompatController } from './text-compat.controller';
import { SmrCompatTemplateService } from './text-compat-template.service';

/**
 * v1-compatible SMR summary gateway shims.
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
    // Real tenant Department → governed instruction-template resolution.
    PromptResolutionServiceModule,
    // Requesting doctor's DNA writing-style resolution (IDnaWritingStyleService).
    DnaWritingStyleServiceModule,
    // Per-tenant Sarvam BYOK resolution (unified provider plane) for the
    // SMR-served transcript translation.
    AiProviderConnectionServiceModule,
    CoreDatabaseModule,
  ],
  controllers: [SmrCompatController],
  providers: [SmrCompatTemplateService],
})
export class SmrCompatModule {}
