import { Inject, Injectable, Logger, Optional, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash, randomBytes } from 'crypto';
import { DataNotFoundException } from '@arcaai/exceptions';
import {
  PasswordResetTokenFactory,
  PasswordResetTokenRepository,
  ResourceStatusType,
  ResourceType,
  UserEntity,
  UserRepository,
} from '@arcaai/domains';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IUserService } from '../../user/user/IUserService';
import { ITenantOnboardingService } from '../../tenant/onboarding';
import { IPasswordResetMailer } from '../../user/userPassword/IPasswordResetMailer';
import { IRegistrationService } from './IRegistrationService';
import { RegisterRequest, RegisterVerifyResponse } from './dto';

const VERIFICATION_PURPOSE = 'email_verification';
/** 24h — a first-touch signup link is more generous than a password-reset link (1h). */
const VERIFICATION_EXPIRES_IN_SECONDS = 24 * 60 * 60;
const GENERIC_TOKEN_ERROR = 'Verification link is invalid or has expired';

/** Reserved SYSTEM tenant/user bootstrap principal. Local literal — mirrors `TenantService`'s own precedent (avoids a cross-package import). */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_USER_ID = '60000000-0000-0000-0000-000000000000';

/**
 * Verified self-signup service.
 *
 * Reuses the `PasswordResetToken` mechanism with a distinct
 * `purpose` discriminator (`email_verification`) rather than a new table —
 * same hashed-at-rest, single-use, TTL-bound token shape. The pending tenant
 * name captured at `register()` is stashed on the token's `metaData` column
 * (see `PasswordResetTokenEntity`'s class doc)
 * so `verify()`'s body can stay `{ token }` only.
 *
 * Mailer reuse: `IPasswordResetMailer.sendResetLink` is repurposed for the
 * verification email (its payload shape — email/path/token/TTL — fits either
 * message; introducing a parallel mailer abstraction for one more email type
 * was not worth the duplication).
 */
@Injectable()
export class RegistrationService extends BaseService implements IRegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    private readonly userRepository: UserRepository,
    private readonly passwordResetTokenRepository: PasswordResetTokenRepository,
    @Inject(IUserService) private readonly userService: IUserService,
    @Inject(ITenantOnboardingService) private readonly tenantOnboardingService: ITenantOnboardingService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IPasswordResetMailer) private readonly mailer?: IPasswordResetMailer,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  /** Anti-enumeration: resolves identically whether or not the email already has an account. */
  async register(request: RegisterRequest): Promise<void> {
    const email = request.email.trim().toLowerCase();

    const existing = await this.findByUsername(email);
    if (existing) {
      return;
    }

    const user = await this.userService.create({
      username: email,
      email,
      password: request.password,
      resourceStatus: ResourceStatusType.SUSPENDED,
    });

    const raw = randomBytes(32).toString('base64url');
    const tokenEntity = PasswordResetTokenFactory.CreatePasswordResetToken({
      userId: user.id,
      tokenHash: RegistrationService.hashToken(raw),
      purpose: VERIFICATION_PURPOSE,
      expiresAt: new Date(Date.now() + VERIFICATION_EXPIRES_IN_SECONDS * 1000),
      requestedVia: 'self-service',
      requestIp: this.requestIp ?? null,
      metaData: { pendingTenantName: request.tenantName },
    });
    await this.passwordResetTokenRepository.create(tokenEntity);

    const verifyPath = `/verify-email?token=${encodeURIComponent(raw)}`;
    if (this.mailer) {
      try {
        await this.mailer.sendResetLink({ email, resetPath: verifyPath, token: raw, expiresInSeconds: VERIFICATION_EXPIRES_IN_SECONDS });
      } catch (error) {
        this.logger.warn(`Verification email delivery failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async verify(token: string): Promise<RegisterVerifyResponse> {
    const tokenHash = RegistrationService.hashToken(token ?? '');
    const record = await this.passwordResetTokenRepository.findByTokenHash(tokenHash);
    if (!record || record.purpose !== VERIFICATION_PURPOSE || !record.isActive()) {
      throw new BadRequestException(GENERIC_TOKEN_ERROR);
    }

    const tenantName = (record.metaData as { pendingTenantName?: string } | null)?.pendingTenantName;
    if (!tenantName) {
      throw new InternalServerErrorException('Verification token is missing its pending tenant name');
    }

    // Activate BEFORE provisioning — TenantOnboardingService's existing-admin
    // path requires the admin to already be ENABLED.
    await this.userService.update(record.userId, { resourceStatus: ResourceStatusType.ENABLED });

    const provisioned = await this.tenantOnboardingService.provisionTenantWithAdmin({
      tenantName,
      admin: { kind: 'existing', userId: record.userId },
      actor: { userId: SYSTEM_USER_ID, tenantId: SYSTEM_TENANT_ID },
    });

    record.markUsed();
    await this.passwordResetTokenRepository.update(record.id, record);

    return new RegisterVerifyResponse({ userId: record.userId, tenantId: provisioned.tenant.id, tenantKey: provisioned.tenantKey });
  }

  private async findByUsername(username: string): Promise<UserEntity | null> {
    try {
      return await this.userRepository.findFirst({ where: { username } });
    } catch (error) {
      if (error instanceof DataNotFoundException) {
        return null;
      }
      throw error;
    }
  }

  private static hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
