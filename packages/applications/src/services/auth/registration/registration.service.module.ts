import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { UserServiceModule } from '../../user/user/user.service.module';
import { TenantOnboardingServiceModule } from '../../tenant/onboarding';
import { IPasswordResetMailer } from '../../user/userPassword/IPasswordResetMailer';
import { createPasswordResetMailer } from '../../user/userPassword/msgraph-mailer';
import { RegistrationService } from './registration.service';
import { IRegistrationService } from './IRegistrationService';

@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, UserServiceModule, TenantOnboardingServiceModule],
  providers: [
    { provide: IRegistrationService, useClass: RegistrationService },
    // Same TASK-400 provider-selection factory as UserPasswordServiceModule
    // (env-selected: MS Graph / dev outbox / log-only) — reused, not exported
    // from that module, so provided again here (module-scoped DI).
    { provide: IPasswordResetMailer, useFactory: () => createPasswordResetMailer() },
  ],
  exports: [IRegistrationService],
})
export class RegistrationServiceModule {}
