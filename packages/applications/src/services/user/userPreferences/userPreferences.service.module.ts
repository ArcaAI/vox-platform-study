import { Module } from '@nestjs/common';
import { ClsModule } from 'nestjs-cls';
import { CoreDatabaseModule } from '@arcaai/domains';
import { UserPreferencesService } from './userPreferences.service';
import { IUserPreferencesService } from './IUserPreferencesService';

@Module({
  imports: [CoreDatabaseModule, ClsModule],
  providers: [
    {
      provide: IUserPreferencesService,
      useClass: UserPreferencesService,
    },
    UserPreferencesService,
  ],
  exports: [IUserPreferencesService, UserPreferencesService],
})
export class UserPreferencesServiceModule {}
