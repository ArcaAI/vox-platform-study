import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Keyed on (service, gitCommitSha) — NOT on the tag: a `v<X.Y.Z>` promotion
 * pipeline builds nothing, so the commit SHA is the only stable identity
 * across build and promotion.
 */
export class AttachDigestRequest {
  @ApiProperty({ example: 'smr' })
  @IsString()
  @IsNotEmpty()
  service!: string;

  @ApiProperty({ description: 'Full 40-character commit SHA' })
  @IsString()
  @Matches(/^[0-9a-f]{40}$/)
  gitCommitSha!: string;

  @ApiPropertyOptional({ nullable: true, example: 'registry.gitlab/arca/hope/smr' })
  @IsOptional()
  @IsString()
  imageRepository?: string | null;

  @ApiProperty({ description: 'Resolved manifest digest', example: 'sha256:<64 hex>' })
  @IsString()
  @Matches(/^sha256:[0-9a-f]{64}$/)
  imageDigest!: string;
}
