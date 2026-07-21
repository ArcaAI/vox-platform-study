import { Module } from '@nestjs/common';
import { GlobalSettingService } from './globalSetting.service';
import { IGlobalSettingService } from './IGlobalSettingService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { CryptoServiceModule } from '../crypto/crypto.service.module';

// Reveal needs ICryptoService (bcrypt step-up verify) in addition to
// SecretsService (Vault decrypt, via CommonServiceModule) + UserRepository /
// GlobalSettingRepository (via CoreDatabaseModule).

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule],
  providers: [
    {
      provide: IGlobalSettingService,
      useClass: GlobalSettingService,
    },
  ],
  exports: [IGlobalSettingService],
})
export class GlobalSettingServiceModule {}
