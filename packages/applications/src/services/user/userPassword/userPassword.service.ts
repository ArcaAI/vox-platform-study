import { Injectable, Inject, Optional, BadRequestException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { ResourceType, SysEventType, UserRepository } from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ICryptoService } from '../../crypto/ICryptoService';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IPasswordResetMailer } from './IPasswordResetMailer';

/**
 * TASK-388 #8 — password reset.
 *
 * Two admin flows + one public completion:
 *  - `setTemporaryPassword` — admin sets (or has the server generate) a
 *    login-compatible bcrypt-hashed temporary password and receives the
 *    plaintext to convey out-of-band.
 *  - `createResetLink` — admin mints a single-use, expiring reset token and
 *    (best-effort) emails it; the token/link is also returned so the flow works
 *    when email is unconfigured.
 *  - `completeReset` — public: consumes the token to set a new password.
 *
 * The reset token is a stateless signed JWT (no DB table). It carries a `pv`
 * (password-version) claim = a hash of the user's CURRENT password hash;
 * completing a reset changes the hash, so the token's `pv` no longer matches on
 * a second use — single-use without persistence. See the ticket for the flags
 * (revocable DB-backed tokens / self-service forgot-password are follow-ups).
 */
export interface SetTemporaryPasswordOptions {
  temporaryPassword?: string;
}
export interface SetTemporaryPasswordResult {
  temporaryPassword: string;
}
export interface CreateResetLinkResult {
  token: string;
  resetPath: string;
  expiresInSeconds: number;
  emailSent: boolean;
}
export interface CompleteResetInput {
  token: string;
  newPassword: string;
}
export interface CompleteResetResult {
  userId: string;
}

const RESET_PURPOSE = 'password_reset';
const RESET_EXPIRES_IN_SECONDS = 3600; // 1h — FLAG: tune / make configurable in a follow-up.
const MIN_PASSWORD_LENGTH = 8; // FLAG: stronger complexity policy is a follow-up.

interface ResetTokenClaims {
  sub: string;
  purpose: string;
  pv: string;
}

@Injectable()
export class UserPasswordService extends BaseService {
  private readonly logger = new Logger(UserPasswordService.name);

  constructor(
    private readonly userRepository: UserRepository,
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
    @Inject(SecretsService) private readonly secretsService: SecretsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so the reset flow works (returning the link) when no provider is
    // wired; a delivery failure never blocks the reset.
    @Optional() @Inject(IPasswordResetMailer) private readonly mailer?: IPasswordResetMailer,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  async setTemporaryPassword(userId: string, options?: SetTemporaryPasswordOptions): Promise<SetTemporaryPasswordResult> {
    const temporaryPassword = options?.temporaryPassword ?? UserPasswordService.generateTemporaryPassword();
    this.assertPasswordPolicy(temporaryPassword);

    const user = await this.userRepository.findById(userId);
    user.password = await this.cryptoService.hash(temporaryPassword);
    await this.userRepository.update(userId, user);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: userId,
      data: { kind: 'password-reset', mode: 'temporary-password' },
    });

    return { temporaryPassword };
  }

  async createResetLink(userId: string): Promise<CreateResetLinkResult> {
    const user = await this.userRepository.findById(userId);
    const secret = await this.resolveJwtSecret();
    const pv = UserPasswordService.passwordVersion(user.password);

    const token = jwt.sign({ sub: userId, purpose: RESET_PURPOSE, pv } satisfies ResetTokenClaims, secret, {
      expiresIn: RESET_EXPIRES_IN_SECONDS,
    });
    const resetPath = `/reset-password?token=${encodeURIComponent(token)}`;

    const email = (user as { UserProfile?: { email?: string | null } }).UserProfile?.email ?? null;
    const emailSent = await this.tryDeliver(email, resetPath, token);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: userId,
      data: { kind: 'password-reset', mode: 'reset-link', emailSent },
    });

    return { token, resetPath, expiresInSeconds: RESET_EXPIRES_IN_SECONDS, emailSent };
  }

  async completeReset(input: CompleteResetInput): Promise<CompleteResetResult> {
    this.assertPasswordPolicy(input.newPassword);

    const secret = await this.resolveJwtSecret();
    let claims: ResetTokenClaims;
    try {
      claims = jwt.verify(input.token, secret) as ResetTokenClaims;
    } catch {
      throw new BadRequestException('Reset token is invalid or has expired');
    }
    if (claims.purpose !== RESET_PURPOSE || !claims.sub) {
      throw new BadRequestException('Reset token is invalid or has expired');
    }

    const user = await this.userRepository.findById(claims.sub);
    // Single-use: the token's `pv` was bound to the password hash at mint time.
    // If the hash has since changed (a completed reset or any other password
    // change), the token is spent.
    if (claims.pv !== UserPasswordService.passwordVersion(user.password)) {
      throw new BadRequestException('Reset token is invalid or has expired');
    }

    user.password = await this.cryptoService.hash(input.newPassword);
    await this.userRepository.update(claims.sub, user);

    return { userId: claims.sub };
  }

  private async tryDeliver(email: string | null, resetPath: string, token: string): Promise<boolean> {
    if (!this.mailer || !email) return false;
    try {
      return await this.mailer.sendResetLink({ email, resetPath, token, expiresInSeconds: RESET_EXPIRES_IN_SECONDS });
    } catch (error) {
      this.logger.warn(`Password-reset email delivery failed (non-fatal): ${(error as Error).message}`);
      return false;
    }
  }

  private assertPasswordPolicy(password: string): void {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new BadRequestException(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  private async resolveJwtSecret(): Promise<string> {
    const secret = this.secretsService.getSecretSync('JWT_SECRET_KEY') ?? (await this.secretsService.getSecretOptional('JWT_SECRET_KEY'));
    if (!secret) {
      throw new BadRequestException('Authentication system not configured');
    }
    return secret;
  }

  /** Short, stable fingerprint of the current password hash — the single-use marker. */
  private static passwordVersion(passwordHash: string): string {
    return createHash('sha256').update(passwordHash ?? '').digest('hex').slice(0, 16);
  }

  private static generateTemporaryPassword(): string {
    // ~16 url-safe chars; comfortably exceeds MIN_PASSWORD_LENGTH.
    return randomBytes(12).toString('base64url');
  }
}
