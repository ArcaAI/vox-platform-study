import { Module } from '@nestjs/common';
import { DnaWritingStyleServiceModule } from '@arcaai/applications';
import { DnaWritingStyleController } from './dna-writing-style.controller';
import { DnaWritingStyleAdminController } from './dna-writing-style-admin.controller';
import { DnaWritingStyleIngestController } from './dna-writing-style-ingest.controller';

@Module({
  imports: [DnaWritingStyleServiceModule],
  // TASK-974 D-4 — the ingest surface is its own controller so the personal DNA routes keep
  // their `@ForbidApiKey()` exemption. Order matters to NOTHING here (Nest matches on path), but
  // the more specific prefix `dna-writing-styles/ingest` is declared before the catch-all
  // `dna-writing-styles/:reportId` routes so a reader sees the specificity.
  controllers: [DnaWritingStyleIngestController, DnaWritingStyleController, DnaWritingStyleAdminController],
})
export class DnaWritingStyleModule {}
