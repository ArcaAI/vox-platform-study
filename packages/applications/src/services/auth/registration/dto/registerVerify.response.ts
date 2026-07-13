import { ApiProperty } from '@nestjs/swagger';

/** TASK-497 §3.4 — result of a successful `POST /auth/register/verify`. */
export class RegisterVerifyResponse {
  @ApiProperty({ description: 'Id of the now-activated, now-TENANT_ADMIN user' })
  userId!: string;

  @ApiProperty({ description: 'Id of the newly provisioned tenant' })
  tenantId!: string;

  @ApiProperty({ description: "The provisioned tenant's key" })
  tenantKey!: string;

  constructor(init: RegisterVerifyResponse) {
    this.userId = init.userId;
    this.tenantId = init.tenantId;
    this.tenantKey = init.tenantKey;
  }
}
