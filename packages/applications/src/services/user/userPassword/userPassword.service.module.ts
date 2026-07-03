import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { UserPasswordService } from './userPassword.service';
import { IPasswordResetMailer } from './IPasswordResetMailer';
import { createPasswordResetMailer } from './msgraph-mailer';

/**
 * TASK-388 #8 — reset-password service wiring. Reworked by TASK-400.
 *
 * - `CommonServiceModule` provides `IAppSettingsService` (complexity/rotation
 *   policy overrides) + `CoreDatabaseModule` (User / UserProfile /
 *   PasswordResetToken repositories).
 * - `CryptoServiceModule` provides `ICryptoService` (bcrypt hashing).
 * - `IPasswordResetMailer` is selected from env at boot: MS Graph transport
 *   when MSGRAPH_CLIENT_ID/SECRET/TENANT_ID/SENDER are provisioned, else a
 *   dev outbox (non-prod) or log-only no-op (prod). See msgraph-mailer.ts.
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule],
  providers: [
    UserPasswordService,
    { provide: IPasswordResetMailer, useFactory: () => createPasswordResetMailer() },
  ],
  exports: [UserPasswordService],
})
export class UserPasswordServiceModule {}
