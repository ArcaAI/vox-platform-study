import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UserPasswordService, ForgotPasswordRequest, ForgotPasswordResponse } from '@arcaai/applications';
import { Public } from '../../../decorators';

const GENERIC_MESSAGE = 'If an account exists for that email, a password reset link has been sent.';

/**
 * TASK-400 — public self-service forgot-password.
 *
 * Anti-enumeration contract: ALWAYS 202 with the identical generic body —
 * email matched, email unknown, or internal failure. The reset token travels
 * ONLY via the mailer (MS Graph or the non-prod dev outbox); it never appears
 * in the response. Throttled to the same 5 req/min envelope as `/auth/login`
 * (when the app-wide throttler is enabled). Lives in the user module (which
 * wires `UserPasswordServiceModule`) but is mounted under `auth/` to match the
 * public auth route conventions.
 */
@ApiTags('auth')
@Controller('auth')
export class ForgotPasswordController {
  private readonly logger = new Logger(ForgotPasswordController.name);

  constructor(private readonly userPasswordService: UserPasswordService) {}

  @Public()
  @Post('forgot-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Request a self-service password reset link (always 202)' })
  @ApiResponse({ status: 202, description: 'Accepted — same response whether or not the account exists', type: ForgotPasswordResponse })
  async request(@Body() request: ForgotPasswordRequest): Promise<ForgotPasswordResponse> {
    try {
      await this.userPasswordService.requestSelfServiceReset({ email: request.email });
    } catch (error) {
      // The service already swallows expected failures; this is a last-resort
      // guard so an unexpected error can never turn into a 5xx that would
      // differ from the "email unknown" response shape.
      this.logger.warn(`forgot-password request failed internally (masked): ${(error as Error).message}`);
    }
    return new ForgotPasswordResponse({ success: true, message: GENERIC_MESSAGE });
  }
}
