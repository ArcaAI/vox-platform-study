import { Module } from '@nestjs/common';
import { KnowledgeServiceModule } from '@arcaai/applications';
import { KnowledgeController } from './knowledge.controller';

/**
 * Wraps `KnowledgeServiceModule` (the worker-only BullMQ ingestion wiring)
 * with admin REST surface. Replaces the direct
 * `KnowledgeServiceModule` import that previously sat in `app.module.ts`
 * imports — same providers/queue registration, now with a controller too.
 */
@Module({
  imports: [KnowledgeServiceModule],
  controllers: [KnowledgeController],
})
export class KnowledgeModule {}
