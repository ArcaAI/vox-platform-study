import { Injectable, Inject, Optional, BadRequestException, Logger } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import {
  PasswordResetTokenEntity,
  PasswordResetTokenFactory,
  PasswordResetTokenRepository,
  ResourceStatusType,
  ResourceType,
  SysEventType,
  UserProfileRepository,
  UserRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { ICryptoService } from '../../crypto/ICryptoService';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { IPasswordResetMailer } from './IPasswordResetMailer';
import { resolvePasswordPolicy, validatePasswordComplexity, PasswordPolicy } from './password-policy';

/**
 * TASK-388 #8 — password reset. Reworked by TASK-400.
 *
 * Flows:
 *  - `setTemporaryPassword` — admin sets (or has the server generate) a
 *    policy-compliant bcrypt-hashed temporary password and receives the
 *    plaintext to convey out-of-band.
 *  - `createResetLink` — admin mints a reset token and (best-effort) emails
 *    it; the token/link is also returned so the flow works when email is
 *    unconfigured.
 *  - `requestSelfServiceReset` — PUBLIC forgot-password: looks the email up,
 *    mints + emails a token for each matching enabled user, and NEVER returns
 *    the token or reveals whether the account exists (always resolves).
 *  - `completeReset` — public: consumes the token to set a new password.
 *
 * TASK-400 token model: the raw token is 32 random bytes (base64url), only its
 * SHA-256 hex is persisted (`PasswordResetToken.tokenHash`). Tokens are
 * single-use (`usedAt`), TTL-bound (1h), and revocable: issuing a new token
 * revokes prior active ones and any password change revokes all outstanding
 * tokens — strictly via UPDATE `revokedAt`, never DELETE. Every password set
 * path enforces the GlobalSettings-configurable complexity policy and stamps
 * `User.passwordChangedAt` for the rotation check surfaced at login.
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
export interface RequestSelfServiceResetInput {
  email: string;
}
export interface CompleteResetInput {
  token: string;
  newPassword: string;
}
export interface CompleteResetResult {
  userId: string;
}

const RESET_PURPOSE = 'password_reset';
const RESET_EXPIRES_IN_SECONDS = 3600; // 1h TTL for reset tokens.
/** Cap fan-out if one email ever maps to many profiles (defensive). */
const MAX_SELF_SERVICE_MATCHES = 3;
const GENERIC_TOKEN_ERROR = 'Reset token is invalid or has expired';

interface UserWithProfileEmail {
  UserProfile?: { email?: string | null };
}

@Injectable()
export class UserPasswordService extends BaseService {
  private readonly logger = new Logger(UserPasswordService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly userProfileRepository: UserProfileRepository,
    private readonly passwordResetTokenRepository: PasswordResetTokenRepository,
    @Inject(ICryptoService) private readonly cryptoService: ICryptoService,
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional so the reset flow works (returning the link) when no provider is
    // wired; a delivery failure never blocks the reset.
    @Optional() @Inject(IPasswordResetMailer) private readonly mailer?: IPasswordResetMailer,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  async setTemporaryPassword(userId: string, options?: SetTemporaryPasswordOptions): Promise<SetTemporaryPasswordResult> {
    const policy = this.policy();
    const temporaryPassword = options?.temporaryPassword ?? UserPasswordService.generateTemporaryPassword(policy);
    this.assertPasswordPolicy(temporaryPassword, policy);

    const user = await this.userRepository.findById(userId);
    user.password = await this.cryptoService.hash(temporaryPassword);
    user.passwordChangedAt = new Date();
    await this.userRepository.update(userId, user);

    // The password changed out-of-band — any outstanding reset link is stale.
    await this.revokeActiveTokens(userId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: userId,
      data: { kind: 'password-reset', mode: 'temporary-password' },
    });

    return { temporaryPassword };
  }

  async createResetLink(userId: string): Promise<CreateResetLinkResult> {
    const user = await this.userRepository.findById(userId);

    const { raw, resetPath } = await this.issueToken(userId, {
      requestedVia: 'admin',
      requestedByUserId: this.requestUser?.id ?? null,
    });

    const email = (user as UserWithProfileEmail).UserProfile?.email ?? null;
    const emailSent = await this.tryDeliver(email, resetPath, raw);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: userId,
      data: { kind: 'password-reset', mode: 'reset-link', emailSent },
    });

    return { token: raw, resetPath, expiresInSeconds: RESET_EXPIRES_IN_SECONDS, emailSent };
  }

  /**
   * Public forgot-password. Anti-enumeration contract: identical outcome
   * (resolve, no payload) whether or not the email matches an account — the
   * token travels ONLY via email. Internal failures are swallowed and logged.
   */
  async requestSelfServiceReset(input: RequestSelfServiceResetInput): Promise<void> {
    const email = (input.email ?? '').trim();
    let issued = 0;

    if (email) {
      try {
        const profiles = await this.userProfileRepository.findAll({
          filters: {
            email: { equals: email, mode: 'insensitive' },
            resourceStatus: { equals: ResourceStatusType.ENABLED },
          } as never,
          limit: MAX_SELF_SERVICE_MATCHES,
        });

        for (const profile of profiles) {
          issued += await this.issueSelfServiceTokenFor(profile as unknown as { userId: string; email?: string | null });
        }
      } catch (error) {
        this.logger.warn(`forgot-password lookup failed (non-fatal): ${(error as Error).message}`);
      }
    }

    // Audit trail — digest only, never the raw email nor any token material.
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      data: {
        kind: 'password-reset',
        mode: 'forgot-password-request',
        emailDigest: UserPasswordService.digest(email.toLowerCase()),
        issued,
      },
    });
  }

  async completeReset(input: CompleteResetInput): Promise<CompleteResetResult> {
    this.assertPasswordPolicy(input.newPassword, this.policy());

    const tokenHash = UserPasswordService.hashToken(input.token ?? '');
    const record = await this.passwordResetTokenRepository.findByTokenHash(tokenHash);
    if (!record) {
      throw new BadRequestException(GENERIC_TOKEN_ERROR);
    }

    // Defence in depth: constant-time re-compare of the stored hash against the
    // recomputed one (the DB lookup above is exact-match already).
    const stored = Buffer.from(record.tokenHash, 'utf8');
    const computed = Buffer.from(tokenHash, 'utf8');
    if (stored.length !== computed.length || !timingSafeEqual(stored, computed)) {
      throw new BadRequestException(GENERIC_TOKEN_ERROR);
    }

    const now = new Date();
    if (record.purpose !== RESET_PURPOSE || !record.isActive(now)) {
      throw new BadRequestException(GENERIC_TOKEN_ERROR);
    }

    let user;
    try {
      user = await this.userRepository.findById(record.userId);
    } catch {
      throw new BadRequestException(GENERIC_TOKEN_ERROR);
    }

    user.password = await this.cryptoService.hash(input.newPassword);
    user.passwordChangedAt = now;
    await this.userRepository.update(record.userId, user);

    // Single-use: spend this token, then revoke any other stragglers.
    record.markUsed(now);
    await this.passwordResetTokenRepository.update(record.id, record);
    await this.revokeActiveTokens(record.userId, now);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: record.userId,
      data: { kind: 'password-reset', mode: 'completed' },
    });

    return { userId: record.userId };
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** Mint a fresh token for the user, revoking prior active ones first. */
  private async issueToken(
    userId: string,
    provenance: { requestedVia: 'admin' | 'self-service'; requestedByUserId?: string | null },
  ): Promise<{ raw: string; resetPath: string; entity: PasswordResetTokenEntity }> {
    await this.revokeActiveTokens(userId);

    const raw = randomBytes(32).toString('base64url');
    const entity = PasswordResetTokenFactory.CreatePasswordResetToken({
      userId,
      tokenHash: UserPasswordService.hashToken(raw),
      purpose: RESET_PURPOSE,
      expiresAt: new Date(Date.now() + RESET_EXPIRES_IN_SECONDS * 1000),
      requestedByUserId: provenance.requestedByUserId ?? null,
      requestedVia: provenance.requestedVia,
      requestIp: this.requestIp ?? null,
      createdBy: this.requestUser?.id,
    });
    await this.passwordResetTokenRepository.create(entity);

    return { raw, resetPath: `/reset-password?token=${encodeURIComponent(raw)}`, entity };
  }

  /** UPDATE-only revocation of all outstanding active tokens for a user. */
  private async revokeActiveTokens(userId: string, now: Date = new Date()): Promise<void> {
    try {
      const active = await this.passwordResetTokenRepository.findActiveForUser(userId);
      for (const token of active) {
        token.markRevoked(now);
        await this.passwordResetTokenRepository.update(token.id, token);
      }
    } catch (error) {
      this.logger.warn(`Failed to revoke prior reset tokens (non-fatal): ${(error as Error).message}`);
    }
  }

  /** @returns 1 when a token was issued, 0 when the user was skipped. */
  private async issueSelfServiceTokenFor(profile: { userId: string; email?: string | null }): Promise<number> {
    try {
      const user = await this.userRepository.findFirst({
        filters: { id: profile.userId, resourceStatus: { equals: ResourceStatusType.ENABLED } } as never,
      });
      if ((user as { isServiceAccount?: boolean }).isServiceAccount) return 0;

      const { raw, resetPath } = await this.issueToken(profile.userId, { requestedVia: 'self-service' });
      await this.tryDeliver(profile.email ?? null, resetPath, raw);
      return 1;
    } catch (error) {
      this.logger.warn(`forgot-password issue failed for a matched profile (non-fatal): ${(error as Error).message}`);
      return 0;
    }
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

  private policy(): PasswordPolicy {
    return resolvePasswordPolicy(this.appSettings);
  }

  private assertPasswordPolicy(password: string, policy: PasswordPolicy): void {
    const failures = validatePasswordComplexity(password ?? '', policy);
    if (failures.length > 0) {
      throw new BadRequestException(failures.join('. '));
    }
  }

  private static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private static digest(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  /** Random password guaranteed to satisfy the policy's character classes. */
  private static generateTemporaryPassword(policy: PasswordPolicy): string {
    const targetLength = Math.max(policy.minLength, 16);
    let body = '';
    while (`T3mp!${body}`.length < targetLength) {
      body += randomBytes(12).toString('base64url');
    }
    return `T3mp!${body}`.slice(0, Math.max(targetLength, 16));
  }
}
