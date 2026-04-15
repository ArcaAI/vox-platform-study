import {
  EntityId,
  ResourceType,
  SysEventType,
  UserVoiceProfileEntity,
  UserVoiceProfileFactory,
  UserVoiceProfileRepository,
} from '@arcaai/domains';
import { InternalServerErrorException } from '@arcaai/exceptions';
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom } from 'rxjs';
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { IConfigService } from '../../baseServices/_meta/config';
import { IVoiceProfileService } from './IVoiceProfileService';
import { EnrollVoiceProfileRequest } from './dto';

interface ExtractionResponse {
  embedding: number[];
  model_id: string;
}

@Injectable()
export class VoiceProfileService extends BaseService implements IVoiceProfileService {
  private readonly logger = new Logger(VoiceProfileService.name);
  private readonly sttBaseUrl: string;

  constructor(
    private readonly voiceProfileRepository: UserVoiceProfileRepository,
    private readonly httpService: HttpService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserVoiceProfile);
    this.sttBaseUrl = this.configService?.config?.STT_V2_URL || 'http://localhost:8861';
  }

  async enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity> {
    const extraction = await this.extractEmbeddings(request.audioBuffers);

    const entity = UserVoiceProfileFactory.CreateUserVoiceProfile({
      userId: request.userId,
      isActive: false,
      label: request.label,
      modelId: extraction.model_id,
      createdBy: this.requestUser?.id,
    });

    const created = await this.voiceProfileRepository.createWithEmbedding(entity, extraction.embedding);
    if (!created) {
      throw new InternalServerErrorException('Failed to create voice profile');
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: created.id,
      createdAt: created.createdAt,
      data: created.toObject() as object,
    });

    return created;
  }

  async listByUserId(userId: string): Promise<UserVoiceProfileEntity[]> {
    return this.voiceProfileRepository.findAllByUserId(userId);
  }

  async activate(profileId: EntityId): Promise<void> {
    const profile = await this.voiceProfileRepository.findById(profileId);

    await this.voiceProfileRepository.deactivateAllForUser(profile.userId);
    await this.voiceProfileRepository.activateById(profileId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: profileId,
      data: { isActive: true },
    });
  }

  async deactivate(profileId: EntityId): Promise<void> {
    const profile = await this.voiceProfileRepository.findById(profileId);

    await this.voiceProfileRepository.deactivateAllForUser(profile.userId);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: profileId,
      data: { isActive: false },
    });
  }

  async deleteById(profileId: EntityId): Promise<UserVoiceProfileEntity> {
    const deleted = await this.voiceProfileRepository.softDelete(profileId);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: deleted.toObject() as object,
    });

    return deleted;
  }

  private async extractEmbeddings(audioBuffers: Buffer[]): Promise<ExtractionResponse> {
    const formData = new FormData();
    for (let i = 0; i < audioBuffers.length; i++) {
      const uint8 = new Uint8Array(audioBuffers[i]);
      const blob = new Blob([uint8], { type: 'audio/wav' });
      formData.append('files', blob, `sample-${i}.wav`);
    }

    const { data } = await firstValueFrom(
      this.httpService.post<ExtractionResponse>(
        `${this.sttBaseUrl}/internal/voice-profile/extract`,
        formData,
        {
          timeout: 60000,
        },
      ),
    );

    return data;
  }
}
