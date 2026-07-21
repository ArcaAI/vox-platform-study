import { Module } from '@nestjs/common';
import { UserProfileService } from './userProfile.service';
import { IUserProfileService } from './IUserProfileService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule],
  providers: [
    {
      provide: IUserProfileService,
      useClass: UserProfileService,
    },
  ],
  exports: [IUserProfileService],
})
export class UserProfileServiceModule {}
