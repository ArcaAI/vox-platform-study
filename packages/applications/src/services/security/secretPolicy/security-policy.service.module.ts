import { Module } from '@nestjs/common';

import { CommonServiceModule } from '../../baseServices';
import { EffectiveSettingsModule } from '../../settings-registry/effective-settings.module';
import { ISecurityPolicyService } from './ISecurityPolicyService';
import { SecurityPolicyService } from './security-policy.service';

/**
 * The credential-policy admin surface. `EffectiveSettingsModule` supplies the
 * ONE enforcement point every write goes through
 * (`SettingsRegistryWriteService`); `CommonServiceModule` supplies the
 * `IAppSettingsService` cache the readers themselves consult.
 */
@Module({
  imports: [CommonServiceModule, EffectiveSettingsModule],
  providers: [SecurityPolicyService, { provide: ISecurityPolicyService, useExisting: SecurityPolicyService }],
  exports: [ISecurityPolicyService, SecurityPolicyService],
})
export class SecurityPolicyServiceModule {}
