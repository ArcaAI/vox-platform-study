import { Module } from '@nestjs/common';
import { GlobalSettingService } from './globalSetting.service';
import { IGlobalSettingService } from './IGlobalSettingService';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../baseServices';
import { CryptoServiceModule } from '../crypto/crypto.service.module';
import { ActionConfirmationService } from '../settings-registry/action-confirmation.service';
import { TenantSettingsService } from '../settings-registry/tenant-settings.service';

// Reveal needs ICryptoService (bcrypt step-up verify) in addition to
// SecretsService (Vault decrypt, via CommonServiceModule) + UserRepository /
// GlobalSettingRepository (via CoreDatabaseModule).

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule],
  providers: [
    // TASK-1057 — provided locally (the `apiKey` / `rate-limit` precedent): `EffectiveSettingsModule`
    // imports THIS module, so importing it back would close a cycle. Both are stateless readers.
    TenantSettingsService,
    ActionConfirmationService,
    {
      provide: IGlobalSettingService,
      useClass: GlobalSettingService,
    },
  ],
  exports: [IGlobalSettingService],
})
export class GlobalSettingServiceModule {}
