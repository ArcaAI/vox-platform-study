import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { ChangelogService } from './changelog.service';
import { IChangelogService } from './IChangelogService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    ChangelogService,
    {
      provide: IChangelogService,
      // useExisting, not useClass — aliasing the instance above rather than
      // constructing a second one.
      useExisting: ChangelogService,
    },
  ],
  exports: [IChangelogService, ChangelogService],
})
export class ChangelogServiceModule {}
