import { ApiProperty } from '@nestjs/swagger';

type VoiceProfileEntityLike = {
  id: string;
  userId: string;
  isActive: boolean;
  label: string | null;
  modelId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class VoiceProfileResponse {
  @ApiProperty() id!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ nullable: true }) label!: string | null;
  @ApiProperty({ nullable: true }) modelId!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static fromEntity(entity: VoiceProfileEntityLike): VoiceProfileResponse {
    const r = new VoiceProfileResponse();
    r.id = entity.id;
    r.userId = entity.userId;
    r.isActive = entity.isActive;
    r.label = entity.label ?? null;
    r.modelId = entity.modelId ?? null;
    r.createdAt = entity.createdAt;
    r.updatedAt = entity.updatedAt;
    return r;
  }
}
