import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/**
 * The baked `build-info.json` (W3/W4) plus the two runtime facts only the
 * running process knows (`environment`, `instanceId`).
 *
 * `version` is the wire name of the SemVer; it persists to
 * `ServiceRelease.releaseVersion` — the model's `version` column is the OCC
 * counter and Prisma forbids the collision (see `platform.prisma`).
 */
export class RegisterInstanceRequest {
  @ApiProperty({ description: 'Service name, e.g. api | smr | stt-worker', example: 'smr' })
  @IsString()
  @IsNotEmpty()
  service!: string;

  @ApiProperty({ description: 'SemVer from the git tag, or 0.0.0-<branch>.<sha8>', example: '2.1.0' })
  @IsString()
  @IsNotEmpty()
  version!: string;

  @ApiPropertyOptional({ description: 'Release tag, e.g. SMR-2.1.0; null on untagged builds', nullable: true })
  @IsOptional()
  @IsString()
  releaseTag?: string | null;

  @ApiProperty({ example: 'main' })
  @IsString()
  @IsNotEmpty()
  gitBranch!: string;

  @ApiProperty({ description: 'Full 40-character commit SHA' })
  @IsString()
  @Matches(/^[0-9a-f]{40}$/)
  gitCommitSha!: string;

  @ApiProperty({ description: 'Build timestamp (ISO-8601)' })
  @IsDateString()
  buildAt!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  ciPipelineId?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  ciPipelineUrl?: string | null;

  @ApiProperty({ enum: ['dev', 'staging', 'prod'] })
  @IsIn(['dev', 'staging', 'prod'])
  environment!: string;

  @ApiProperty({ description: 'Pod name, or `hostname:pid` outside Kubernetes' })
  @IsString()
  @IsNotEmpty()
  instanceId!: string;
}
