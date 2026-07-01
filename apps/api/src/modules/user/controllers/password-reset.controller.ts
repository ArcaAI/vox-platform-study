import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserPasswordService, CompletePasswordResetRequest, CompletePasswordResetResponse } from '@arcaai/applications';
import { Public } from '../../../decorators';

/**
 * TASK-388 #8 — public completion of an admin-minted reset link.
 *
 * `@Public()` exempts this route from the user-JWT/CASL chain (and the boot-time
 * route-permission audit): the caller is an unauthenticated user finishing their
 * own reset. Authorisation is carried entirely by the single-use, expiring token
 * — an invalid/expired/spent token yields a generic 400 (no user enumeration).
 */
@ApiTags('auth')
@Controller('users/password-reset')
export class PasswordResetController {
  constructor(private readonly userPasswordService: UserPasswordService) {}

  @Public()
  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete a password reset using a single-use token' })
  @ApiResponse({ status: 200, description: 'Password reset', type: CompletePasswordResetResponse })
  @ApiResponse({ status: 400, description: 'Token invalid, expired, or already used' })
  async complete(@Body() request: CompletePasswordResetRequest): Promise<CompletePasswordResetResponse> {
    await this.userPasswordService.completeReset({ token: request.token, newPassword: request.newPassword });
    return new CompletePasswordResetResponse({ success: true });
  }
}
