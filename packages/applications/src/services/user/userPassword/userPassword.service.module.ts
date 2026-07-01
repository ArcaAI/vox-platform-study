import { Module } from '@nestjs/common';
import { CoreDatabaseModule } from '@arcaai/domains';
import { CommonServiceModule } from '../../baseServices';
import { CryptoServiceModule } from '../../crypto/crypto.service.module';
import { UserPasswordService } from './userPassword.service';
import { IPasswordResetMailer, LoggingPasswordResetMailer } from './IPasswordResetMailer';

/**
 * TASK-388 #8 — reset-password service wiring.
 *
 * - `CommonServiceModule` provides `SecretsService` (JWT signing secret) +
 *   `CoreDatabaseModule` (UserRepository).
 * - `CryptoServiceModule` provides `ICryptoService` (bcrypt hashing).
 * - `IPasswordResetMailer` defaults to the logging no-op; wiring a real
 *   provider (e.g. `MicrosoftGraphIntegration`) behind this port is a
 *   documented follow-up (needs MS Graph secrets + a config factory).
 */
@Module({
  imports: [CommonServiceModule, CoreDatabaseModule, CryptoServiceModule],
  providers: [
    UserPasswordService,
    { provide: IPasswordResetMailer, useClass: LoggingPasswordResetMailer },
  ],
  exports: [UserPasswordService],
})
export class UserPasswordServiceModule {}
