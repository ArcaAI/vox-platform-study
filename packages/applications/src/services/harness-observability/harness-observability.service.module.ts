import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { HarnessObservabilityService } from './harness-observability.service';

/**
 * HarnessObservabilityService DI module. Imports
 * CoreDatabaseModule for the audit / eval / consultation / policy repositories.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [HarnessObservabilityService],
  exports: [HarnessObservabilityService],
})
export class HarnessObservabilityServiceModule {}
