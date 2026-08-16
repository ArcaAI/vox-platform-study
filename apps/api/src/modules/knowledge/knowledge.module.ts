import { Module } from '@nestjs/common';
import { KnowledgeServiceModule } from '@arcaai/applications';
import { KnowledgeController } from './knowledge.controller';

/**
 * Wraps `KnowledgeServiceModule` (the worker-only BullMQ ingestion wiring)
 * with this ticket's admin REST surface (TASK-728). Replaces the direct
 * `KnowledgeServiceModule` import that previously sat in `app.module.ts`
 * imports — same providers/queue registration, now with a controller too.
 */
@Module({
  imports: [KnowledgeServiceModule],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}
