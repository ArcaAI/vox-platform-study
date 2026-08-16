import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import { ConsentGrantMethod, ConsentPurpose } from '@arcaai/domains';
import { BaseRequest } from '../../../common';

export class CreateConsentGrantRequest extends BaseRequest {
  @ApiProperty({ description: 'External patient identifier (Consultation.patientId’s identifier space — no FK)', example: 'EHR-A:12345' })
  @IsString()
  @MaxLength(200)
  externalPatientId!: string;

  @ApiProperty({ description: 'Purpose-of-use this grant authorizes', enum: ConsentPurpose })
  @IsEnum(ConsentPurpose)
  purpose!: ConsentPurpose;

  @ApiPropertyOptional({ description: 'Minimum-necessary scope bag, e.g. { "dateRangeDays": 365, "sourceSystems": ["EHR-A"] }' })
  @IsOptional()
  @IsObject()
  scope?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'When the grant was given; defaults to now' })
  @IsOptional()
  @IsDateString()
  grantedAt?: string;

  @ApiProperty({ description: 'How the grant was captured', enum: ConsentGrantMethod })
  @IsEnum(ConsentGrantMethod)
  grantMethod!: ConsentGrantMethod;

  @ApiPropertyOptional({ description: 'Object-store pointer to the signed/recorded evidence artifact' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  evidenceRef?: string;

  @ApiPropertyOptional({ description: 'Grant expiry (time-limited consent)' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
