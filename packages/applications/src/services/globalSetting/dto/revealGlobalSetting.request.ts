import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { BaseRequest } from '../../../common';

/**
 * Step-up re-auth payload for revealing a single secret setting.
 *
 * The reveal endpoint is super-admin-only (CASL `manage all`) AND requires the
 * caller to re-enter their CURRENT account password. The password is verified
 * server-side against the stored bcrypt hash (the same primitive used at login),
 * is NEVER logged, and is NEVER persisted. A borrowed/left-open session cannot
 * exfiltrate a secret with a single click without knowing the password.
 */
export class RevealGlobalSettingRequest extends BaseRequest {
  @ApiProperty({
    description:
      "The caller's current account password (step-up re-authentication). Verified server-side against the stored hash; never logged, never persisted.",
    example: 'my-current-password',
  })
  @IsString()
  @IsNotEmpty()
  password!: string;
}
