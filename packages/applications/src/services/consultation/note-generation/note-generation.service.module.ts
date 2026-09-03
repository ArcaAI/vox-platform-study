import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { ConfigResolverModule } from '../../config-resolver';
import { HarnessGatewayServiceModule } from '../harness/harness-gateway.service.module';
import { INoteGenerationService } from './INoteGenerationService';
import { NoteGenerationService } from './note-generation.service';

/**
 * Generator Entry-Point Seam.
 *
 * HarnessGatewayServiceModule supplies the REQUIRED (not @Optional())
 * HarnessGatewayService dependency — omitting this import is exactly the
 * "wrong module graph" failure mode `NoteGenerationService`'s constructor is
 * designed to fail loudly on at boot. ConfigResolverModule supplies the
 * realtime cascade resolver `resolveConfig` uses.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, ConfigResolverModule, HarnessGatewayServiceModule],
  providers: [
    NoteGenerationService,
    {
      provide: INoteGenerationService,
      // useExisting, not useClass — useClass would construct a second
      // NoteGenerationService instance instead of aliasing the one above.
      useExisting: NoteGenerationService,
    },
  ],
  exports: [INoteGenerationService, NoteGenerationService],
})
export class NoteGenerationServiceModule {}
