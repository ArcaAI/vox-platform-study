import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { EntityIdProperty } from '../../../decorators';

export class UserSession {
  @EntityIdProperty()
  id: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  firstName?: string | null;

  @ApiProperty()
  @IsString()
  @IsOptional()
  lastName?: string | null;

  @ApiProperty()
  @IsString()
  email!: string;

  @ApiProperty()
  @IsString()
  @IsOptional()
  phone?: string | null;

  @ApiProperty()
  @IsString()
  @IsOptional()
  tenantId?: string | null;

  @ApiProperty()
  @IsString()
  @IsOptional()
  tenantCode?: string | null;

  @ApiProperty()
  @IsString()
  @IsOptional()
  token?: string | null;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsOptional()
  roles?: string[];

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsOptional()
  permissions?: string[];

  /**
   * When the session is the result of an impersonation grant, this holds the
   * admin user id who initiated the impersonation. Carried through JWT claim
   * `impersonatedBy` (see TASK-295 H-2).
   */
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  impersonatedBy?: string;

  /**
   * JWT `jti` claim of the active token. Required by `JwtRevocationService`
   * to mark this exact token revoked when `/auth/revoke-impersonation` runs.
   */
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  jti?: string;

  /**
   * JWT `exp` claim (epoch seconds). Bounds the Redis TTL of the revocation
   * entry so revoked-jti rows self-clean.
   */
  @ApiProperty({ required: false })
  @IsOptional()
  exp?: number;

  /**
   * Refresh-token family id carried through the access-token JWT (TASK-307
   * W1.2 / W1.4). Set at login (and preserved across refresh rotations) so
   * `/auth/logout` can call `RefreshTokenService.revokeFamily(family)` and
   * kill every still-active refresh token in the chain (RFC 6749 §10.4).
   */
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  refreshFamily?: string;

  constructor(init: UserSession) {
    this.id = init.id;
    this.firstName = init.firstName;
    this.lastName = init.lastName;
    this.email = init.email;
    this.phone = init.phone;
    this.tenantId = init.tenantId;
    this.tenantCode = init.tenantCode;
    this.token = init.token;
    this.roles = init.roles || [];
    this.permissions = init.permissions || [];
    this.impersonatedBy = init.impersonatedBy;
    this.jti = init.jti;
    this.exp = init.exp;
    this.refreshFamily = init.refreshFamily;
  }
}
