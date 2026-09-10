import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateUserProfileRequest extends BaseRequest {
  @ApiProperty({ description: 'First name of the user', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'Last name of the user', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ description: 'Email address', required: false })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Avatar media ID', required: false })
  @IsString()
  @IsOptional()
  avatarId?: string;

  // Widened to `string | null` so the doctor
  // self-service "set my preferred template" path can CLEAR the preference
  // (null reverts resolution to the department/tenant default tier). `@IsOptional`
  // skips `@IsString` for null, so an explicit null body still validates.
  @ApiProperty({ description: 'Preferred backend prompt template ID (null clears).', required: false, nullable: true })
  @IsString()
  @IsOptional()
  preferredPromptTemplateId?: string | null;

  // TASK-950 — widened to `string | null` for the same reason
  // `preferredPromptTemplateId` was: an admin must be able to CLEAR a staff id (an integration
  // was retired, the identifier was reassigned), and an omitted field cannot express that.
  // `@IsOptional` skips `@IsString` for null, so an explicit null body still validates.
  // Uniqueness is per TENANT and is enforced in the service (409 `STAFF_ID_TAKEN`).
  @ApiPropertyOptional({
    description: "Tenant staff identifier (null clears). Unique within the tenant; 409 STAFF_ID_TAKEN when another of the tenant's users already holds it.",
    nullable: true,
  })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  staffId?: string | null;

  @ApiProperty({ description: 'ID of the associated user', required: false })
  @IsString()
  @IsOptional()
  userId?: string;
}
