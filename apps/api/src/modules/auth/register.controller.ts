import { Body, Controller, HttpCode, HttpStatus, Inject, NotFoundException, Optional, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  IConfigService,
  IRegistrationService,
  REGISTRATION_SELF_SIGNUP_ENABLED_KEY,
  RegisterRequest,
  RegisterVerifyRequest,
  RegisterVerifyResponse,
  TenantSettingsService,
} from '@arcaai/applications';
import { Public } from '../../decorators';

const REGISTRATION_DISABLED_MESSAGE = 'Not found';

/**
 * Verified self-signup — public registration.
 *
 * Feature gate: both routes 404 when `registration.selfSignupEnabled` is OFF
 * (default), so the endpoint's existence is not disclosed.
 *
 * TASK-932 D-4 — that key MIGRATED from the `REGISTRATION_SELF_SIGNUP_ENABLED`
 * environment variable to the `global-kv` settings tier, so a platform admin
 * opens self-signup from the Feature availability matrix instead of by
 * redeploying. It resolves on the PLATFORM lane only, and its descriptor is
 * `maxScope: 'system'` for the same reason: both routes are `@Public()` and
 * carry no tenant, so there is no tenant row a cascade could honour here.
 *
 * `POST /auth/register` mirrors `ForgotPasswordController`'s anti-enumeration
 * contract (`RegistrationService.register` already resolves identically
 * whether or not the email exists); throttled to the same envelope as
 * `/auth/login` / `/auth/forgot-password`.
 */
@ApiTags('auth')
@Controller('auth')
export class RegisterController {
  constructor(
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Inject(IRegistrationService) private readonly registrationService: IRegistrationService,
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  private assertEnabled(): void {
    if (!this.isSelfSignupEnabled()) {
      throw new NotFoundException(REGISTRATION_DISABLED_MESSAGE);
    }
  }

  /**
   * With the settings graph unwired (a minimal test fixture), fall back to the
   * pre-TASK-932 env read rather than to a DI error or to the descriptor
   * default: a fixture that pinned the flag must keep meaning what it said.
   */
  private isSelfSignupEnabled(): boolean {
    if (!this.tenantSettings) {
      return this.configService.getConfigValue('REGISTRATION_SELF_SIGNUP_ENABLED') === true;
    }
    return this.tenantSettings.resolvePlatform<boolean>(REGISTRATION_SELF_SIGNUP_ENABLED_KEY).value === true;
  }

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Self-service registration — creates an unverified account and emails a verification link' })
  @ApiResponse({ status: 202, description: 'Accepted — same response whether or not the email already has an account' })
  async register(@Body() request: RegisterRequest): Promise<{ success: true }> {
    this.assertEnabled();
    await this.registrationService.register(request);
    return { success: true };
  }

  @Public()
  @Post('register/verify')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Consume an email-verification token — activates the account and provisions its tenant' })
  @ApiResponse({ status: 200, description: 'The provisioned account + tenant', type: RegisterVerifyResponse })
  async verify(@Body() request: RegisterVerifyRequest): Promise<RegisterVerifyResponse> {
    this.assertEnabled();
    return this.registrationService.verify(request.token);
  }
}
