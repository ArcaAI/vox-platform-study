import { Body, Controller, HttpCode, HttpStatus, Inject, NotFoundException, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IConfigService, IRegistrationService, RegisterRequest, RegisterVerifyRequest, RegisterVerifyResponse } from '@arcaai/applications';
import { Public } from '../../decorators';

const REGISTRATION_DISABLED_MESSAGE = 'Not found';

/**
 * Verified self-signup — public registration.
 *
 * Feature-flag gate: both routes 404 when `REGISTRATION_SELF_SIGNUP_ENABLED`
 * is OFF (default), mirroring `ConsultationController.isSharingEnabled`'s
 * inline-check shape — no dedicated guard/decorator exists for a boolean
 * `IConfigService` flag yet, and this is the first consumer.
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
  ) {}

  private assertEnabled(): void {
    if (!this.configService.getConfigValue('REGISTRATION_SELF_SIGNUP_ENABLED')) {
      throw new NotFoundException(REGISTRATION_DISABLED_MESSAGE);
    }
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
