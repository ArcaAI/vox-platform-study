import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { UserPasswordService } from './userPassword.service';
import { IPasswordResetMailer } from './IPasswordResetMailer';
import { createPasswordResetMailer } from './msgraph-mailer';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';

/**
 * Reset-password service wiring.
 *
 * - `CommonServiceModule` provides `IAppSettingsService` (complexity/rotation
 *   policy overrides) + `CoreDatabaseModule` (User / UserProfile /
 *   PasswordResetToken repositories).
 * - `CryptoServiceModule` provides `ICryptoService` (bcrypt hashing).
 * - `IPasswordResetMailer` is selected from env at boot: MS Graph transport
 *   when MSGRAPH_CLIENT_ID/SECRET/TENANT_ID/SENDER are provisioned, else a
 *   dev outbox (non-prod) or log-only no-op (prod). See msgraph-mailer.ts.
 * - `TenantSettingsService` resolves `console.publicBaseUrl` (tenant → SYSTEM)
 *   for the reset link's origin (TASK-1056).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule],
  providers: [UserPasswordService, TenantSettingsService, { provide: IPasswordResetMailer, useFactory: () => createPasswordResetMailer() }],
  exports: [UserPasswordService],
})
export class UserPasswordServiceModule {}
