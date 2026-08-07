import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UserPreferencesService } from './userPreferences.service';
import { IUserPreferencesService } from './IUserPreferencesService';

@Module({
  imports: [CoreDatabaseModule, ClsModule],
  providers: [
    UserPreferencesService,
    {
      provide: IUserPreferencesService,
      // useExisting, not useClass — useClass would construct a second
      // UserPreferencesService instance instead of aliasing the one above.
      // No cache/listener/timer state here, so the duplicate was harmless,
      // but aliasing is free.
      useExisting: UserPreferencesService,
    },
  ],
  exports: [IUserPreferencesService, UserPreferencesService],
})
export class UserPreferencesServiceModule {}
