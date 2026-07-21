import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { IUserService } from './IUserService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { UserProfileServiceModule } from '../userProfile/userProfile.service.module';
import { EntitlementsServiceModule } from '../../entitlements/entitlements.service.module';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { JwtRevocationModule } from '../../auth/jwt-revocation.module';

@Module({
  // UserProfileServiceModule supplies IUserProfileService so
  // create() can persist the optional `email` onto the user's profile.
  // EntitlementsServiceModule supplies the maxUsers seat quota.
  // CryptoServiceModule supplies ICryptoService so creation/update
  // passwords are bcrypt-hashed (IAppSettingsService comes from the @Global
  // AppSettingsModule).
  // JwtRevocationModule supplies IJwtRevocationService so
  // disabling/deleting a user also kills their already-issued access tokens.
  // (Standalone module, NOT AuthServiceModule — that would be circular.)
  imports: [CommonServiceModule, CoreDatabaseModule, UserProfileServiceModule, EntitlementsServiceModule, CryptoServiceModule, JwtRevocationModule],
  providers: [
    {
      provide: IUserService,
      useClass: UserService,
    },
  ],
  exports: [IUserService],
})
export class UserServiceModule {}
