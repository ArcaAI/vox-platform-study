import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConfigResolverModule } from '../config-resolver';
import { PipelinePolicyService } from './pipeline-policy.service';

/**
 * PipelinePolicyService DI module. Imports
 * CoreDatabaseModule for the PipelinePolicy + PipelinePolicyChange repositories
 * and the `CORE_DATABASE_SERVICE` (interactive transactions), and
 * ConfigResolverModule for the effective-cascade resolution. `ClsService` is
 * resolved from the globally-registered `ClsModule`.
 */
@Module({
  imports: [CoreDatabaseModule, ConfigResolverModule],
  providers: [PipelinePolicyService],
  exports: [PipelinePolicyService],
})
export class PipelinePolicyServiceModule {}
