import { Module } from '@nestjs/common';
import { ChangelogServiceModule } from '@arcaai/applications';
import { ChangelogController } from './changelog.controller';
import { ChangelogAdminController } from './changelog-admin.controller';

@Module({
  imports: [ChangelogServiceModule],
  controllers: [ChangelogController, ChangelogAdminController],
})
export class ChangelogModule {}
