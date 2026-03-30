import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../common';

export class TagResponse extends BaseResponse {
  @ApiProperty({ description: 'Resource type name', required: false })
  resourceTypeName?: string;

  @ApiProperty({ description: 'Resource ID', required: false })
  resourceId?: string;

  @ApiProperty({ description: 'Tag key', required: false })
  tagKey?: string;

  @ApiProperty({ description: 'Tag value' })
  tagValue!: string;

  @ApiProperty({ description: 'Description of the tag', required: false })
  description?: string;

  @ApiProperty({ description: 'Color code for the tag', required: false })
  color?: string;

  @ApiProperty({ description: 'Icon identifier for the tag', required: false })
  icon?: string;

  constructor(init: TagResponse & BaseResponseProps) {
    super(init);
    this.resourceTypeName = init.resourceTypeName;
    this.resourceId = init.resourceId;
    this.tagKey = init.tagKey;
    this.tagValue = init.tagValue;
    this.description = init.description;
    this.color = init.color;
    this.icon = init.icon;
  }
}
