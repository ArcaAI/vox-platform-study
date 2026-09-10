import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, MaxLength } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateUserProfileRequest extends BaseRequest {
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

  @ApiProperty({ description: 'Preferred backend prompt template ID', required: false })
  @IsString()
  @IsOptional()
  preferredPromptTemplateId?: string;

  // TASK-950 — the tenant's own staff identifier for this clinician, and the value a
  // context-schema user-identity field is mapped to. Unique PER TENANT, enforced in the service
  // (`STAFF_ID_TAKEN`, 409) rather than by a DB unique: `UserProfile` carries no tenant column,
  // so a user's tenant IS its role assignment and no single-table constraint can express it.
  @ApiPropertyOptional({ description: "Tenant staff identifier. Unique within the tenant; 409 STAFF_ID_TAKEN when another of the tenant's users already holds it." })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  staffId?: string;

  @ApiProperty({ description: 'ID of the associated user' })
  @IsString()
  userId!: string;
}
