import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { ConfigResolver } from './config-resolver.service';

/**
 * ConfigResolver DI module (TASK-356 Phase 5 — Pillar B). Imports
 * CoreDatabaseModule for the PipelinePolicy repository (cascade rows + SYSTEM
 * default) and the UserProfile repository (preferred-prompt threading).
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [ConfigResolver],
  exports: [ConfigResolver],
})
export class ConfigResolverModule {}
