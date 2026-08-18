import { IVoiceProfileService } from '@arcaai/applications';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  Get,
  Inject,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  Patch,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { TenantOwnedResource } from '../../common';
import { Authorize, ForbidApiKey } from '../../decorators';
import { EnrollBodyDto, VoiceProfileResponse } from './dto';

const MAX_AUDIO_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 3;

@ApiBearerAuth()
@ApiTags('voice-profile')
@Controller('voice-profile')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: voice enrolment; ownership-checked but with no dedicated scope, and reached today by the browser SDK over JWT.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class VoiceProfileController {
  constructor(
    @Inject(IVoiceProfileService)
    private readonly voiceProfileService: IVoiceProfileService,
    private readonly cls: ClsService,
  ) {}

  private getUserId(): string {
    const user = this.cls.get('user');
    if (!user?.id) {
      throw new BadRequestException('User context is required');
    }
    return user.id;
  }

  @Post('enroll')
  @Authorize(['create', 'UserVoiceProfile'])
  @ApiOperation({ summary: 'Enroll a voice profile from audio samples' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'Voice profile created', type: VoiceProfileResponse })
  @UseInterceptors(FilesInterceptor('files', MAX_FILES))
  async enroll(
    @UploadedFiles(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: MAX_AUDIO_SIZE }), new FileTypeValidator({ fileType: /^audio\// })],
        fileIsRequired: true,
      }),
    )
    files: Express.Multer.File[],
    @Body() body: EnrollBodyDto,
  ): Promise<VoiceProfileResponse> {
    if (!files?.length) {
      throw new BadRequestException('At least one audio file is required');
    }
    if (files.length > MAX_FILES) {
      throw new BadRequestException(`At most ${MAX_FILES} audio files allowed`);
    }

    const userId = this.getUserId();
    const entity = await this.voiceProfileService.enroll({
      userId,
      audioBuffers: files.map((f) => f.buffer),
      label: body.label,
    });

    return VoiceProfileResponse.fromEntity(entity);
  }

  @Get()
  @Authorize(['read', 'UserVoiceProfile'])
  @ApiOperation({ summary: 'List voice profiles for current user' })
  @ApiResponse({ status: 200, description: 'Voice profiles', type: [VoiceProfileResponse] })
  async list(): Promise<VoiceProfileResponse[]> {
    const userId = this.getUserId();
    const profiles = await this.voiceProfileService.listByUserId(userId);
    return profiles.map(VoiceProfileResponse.fromEntity);
  }

  @Patch(':id/activate')
  @TenantOwnedResource({ modelName: 'UserVoiceProfile', paramName: 'id' })
  @Authorize(['update', 'UserVoiceProfile'])
  @ApiOperation({ summary: 'Activate a voice profile' })
  @ApiParam({ name: 'id', description: 'Voice profile ID', type: String })
  @ApiResponse({ status: 200, description: 'Voice profile activated' })
  async activate(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.voiceProfileService.activate(id);
    return { success: true };
  }

  @Patch(':id/deactivate')
  @TenantOwnedResource({ modelName: 'UserVoiceProfile', paramName: 'id' })
  @Authorize(['update', 'UserVoiceProfile'])
  @ApiOperation({ summary: 'Deactivate a voice profile' })
  @ApiParam({ name: 'id', description: 'Voice profile ID', type: String })
  @ApiResponse({ status: 200, description: 'Voice profile deactivated' })
  async deactivate(@Param('id') id: string): Promise<{ success: boolean }> {
    await this.voiceProfileService.deactivate(id);
    return { success: true };
  }

  @Delete(':id')
  @TenantOwnedResource({ modelName: 'UserVoiceProfile', paramName: 'id' })
  @Authorize(['delete', 'UserVoiceProfile'])
  @ApiOperation({ summary: 'Delete a voice profile' })
  @ApiParam({ name: 'id', description: 'Voice profile ID', type: String })
  @ApiResponse({ status: 200, description: 'Voice profile deleted', type: VoiceProfileResponse })
  async deleteById(@Param('id') id: string): Promise<VoiceProfileResponse> {
    const entity = await this.voiceProfileService.deleteById(id);
    return VoiceProfileResponse.fromEntity(entity);
  }
}
