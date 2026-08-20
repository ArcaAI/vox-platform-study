import { HttpModule } from '@nestjs/axios';
import {
  AiProviderConnectionServiceModule,
  DnaWritingStyleServiceModule,
  HarnessPolicyServiceModule,
  PromptResolutionServiceModule,
} from '@arcaai/applications';
import { CoreDatabaseModule } from '@arcaai/domains';
import { Module } from '@nestjs/common';
import { TextCompatController } from './text-compat.controller';
import { TextCompatTemplateService } from './text-compat-template.service';

/**
 * v1-compatible TEXT summary gateway shims.
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
    // TEXT-served transcript translation.
    AiProviderConnectionServiceModule,
    CoreDatabaseModule,
  ],
  controllers: [TextCompatController],
  providers: [TextCompatTemplateService],
})
export class TextCompatModule {}
