import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { IUserService } from './IUserService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { UserProfileServiceModule } from '../userProfile/userProfile.service.module';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';

// TODO: Implement this

@Module({
  // TASK-381 (V1) — UserProfileServiceModule supplies IUserProfileService so
  // create() can persist the optional `email` onto the user's profile.
  // TASK-392 Phase 3 — EntitlementsServiceModule supplies the maxUsers seat quota.
  // TASK-402 — CryptoServiceModule supplies ICryptoService so creation/update
  // passwords are bcrypt-hashed (IAppSettingsService comes from the @Global
  // AppSettingsModule).
  imports: [CommonServiceModule, CoreDatabaseModule, UserProfileServiceModule, EntitlementsServiceModule, CryptoServiceModule],
  providers: [
    {
      provide: IUserService,
      useClass: UserService,
    },
  ],
  exports: [IUserService],
})
export class UserServiceModule {}
