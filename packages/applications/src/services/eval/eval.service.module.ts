import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { EvalService } from './eval.service';

/**
 * EvalService DI module (TASK-330 Phase 0). Imports CoreDatabaseModule for the
 * GoldenSet/GoldenCase/EvalRun/EvalScore repositories.
 */
@Module({
  imports: [CoreDatabaseModule],
  providers: [EvalService],
  exports: [EvalService],
})
export class EvalServiceModule {}
