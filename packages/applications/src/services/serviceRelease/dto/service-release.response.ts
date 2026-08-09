import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginatedResponse } from '../../../common';

export class ServiceReleaseResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'smr' })
  serviceName!: string;

  /** Wire name of `ServiceRelease.releaseVersion` (see `platform.prisma`). */
  @ApiProperty({ example: '2.1.0' })
  version!: string;

  @ApiProperty({ nullable: true, example: 'SMR-2.1.0' })
  releaseTag!: string | null;

  @ApiProperty({ example: 'main' })
  gitBranch!: string;

  @ApiProperty()
  gitCommitSha!: string;

  @ApiProperty({ description: 'ISO-8601' })
  buildAt!: string;

  @ApiProperty({ nullable: true })
  imageRepository!: string | null;

  @ApiProperty({ nullable: true, description: 'Attached by the CI publish/promote step — a digest does not exist until after the push.' })
  imageDigest!: string | null;

  @ApiProperty({ nullable: true })
  ciPipelineUrl!: string | null;

  @ApiPropertyOptional({ isArray: true, nullable: true, description: 'Generated technical changelog.' })
  changelog!: Record<string, unknown>[] | null;
}

export class PaginatedServiceReleaseResponse extends PaginatedResponse<ServiceReleaseResponse> {
  @ApiProperty({ isArray: true, type: ServiceReleaseResponse })
  declare readonly data: readonly ServiceReleaseResponse[];
}
