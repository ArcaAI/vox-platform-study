import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsOptional, IsString } from 'class-validator';
import { ResourceStatusType } from '@arcaai/domains';
import { EntityIdProperty, EntityIdPropertyOptional } from '../../decorators';

export interface BaseResponseProps {
  id: string;
  projectId: string | null;
  createdAt: Date;
  updatedAt: Date;
  resourceStatus: ResourceStatusType | null;
  resourceStatusUpdatedAt: Date | null;
  resourceStatusUpdatedBy: string;
  createdBy: string | null;
  updatedBy: string | null;
}

export class BaseResponse {
  @EntityIdProperty()
  readonly id: string;

  @EntityIdPropertyOptional()
  readonly projectId: string | null;

  @ApiProperty({ example: '2024-02-29T17:43:15.970Z' })
  @IsOptional()
  @IsString()
  @Expose()
  readonly createdAt: string;

  @ApiProperty({ example: '2024-02-29T17:43:15.970Z' })
  @IsOptional()
  @IsString()
  @Expose()
  readonly updatedAt: string;

  @ApiProperty({ example: '2024-02-29T17:43:15.970Z' })
  @IsOptional()
  @IsString()
  @Expose()
  readonly resourceStatus: ResourceStatusType | null;

  @ApiProperty({ example: '2024-02-29T17:43:15.970Z' })
  @IsOptional()
  @IsString()
  @Expose()
  readonly resourceStatusUpdatedAt: string | null;

  @EntityIdPropertyOptional()
  @Expose()
  readonly resourceStatusUpdatedBy: string | null;

  @EntityIdPropertyOptional()
  @Expose()
  readonly createdBy: string | null;

  @EntityIdPropertyOptional()
  @Expose()
  readonly updatedBy: string | null;

  constructor(props: BaseResponseProps) {
    this.id = props.id;
    this.projectId = props.projectId;
    this.createdAt = props.createdAt ? new Date(props.createdAt).toISOString() : '';
    this.updatedAt = props.createdAt ? new Date(props.updatedAt).toISOString() : '';
    this.resourceStatus = props.resourceStatus || null;
    this.resourceStatusUpdatedAt = props.resourceStatusUpdatedAt ? new Date(props.resourceStatusUpdatedAt).toISOString() : '';
    this.resourceStatusUpdatedBy = props.resourceStatusUpdatedBy;
    this.createdBy = props.createdBy;
    this.updatedBy = props.updatedBy;
  }
}
