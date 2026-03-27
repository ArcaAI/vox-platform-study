import { Module } from '@nestjs/common';
import { DnaWritingStyleServiceModule } from '@arcaai/applications';
import { DnaWritingStyleController } from './dna-writing-style.controller';
import { DnaWritingStyleAdminController } from './dna-writing-style-admin.controller';

@Module({
  imports: [DnaWritingStyleServiceModule],
  controllers: [DnaWritingStyleController, DnaWritingStyleAdminController],
})
export class DnaWritingStyleModule {}
