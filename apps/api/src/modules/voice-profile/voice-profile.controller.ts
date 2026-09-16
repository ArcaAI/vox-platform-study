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
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { TenantOwnedResource } from '../../common';
import { Authorize, ForbidApiKey } from '../../decorators';
import { EnrollBodyDto, VoiceProfileEnrollmentTargetResponse, VoiceProfileResponse } from './dto';

const MAX_AUDIO_SIZE = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 3;

// TASK-977 — the refusal the enrollment target answers with, documented identically on both routes
// because `enroll` resolves the very same target before any audio leaves the gateway. TASK-980
// retired the `sortformer` backend, and with it the 400 both routes used to document for it: an
// agent still declaring that backend is an agent conflict, answered by the ASR resolver's own 409.
const DIARIZATION_DISABLED_409 =
  '`ASR_AGENT_DIARIZATION_DISABLED` — the agent has speaker diarization switched off ' +
  '(`audioFrontEnd.diarization.enabled` is false), so voice embedding is off for it and no voice profile can be ' +
  'enrolled until an admin enables it. Body: `{ code, message }`. Other ASR agent conflicts answer 409 with their ' +
  'own `code` — e.g. `ASR_AGENT_DIARIZATION_MODEL_MISSING` (diarization on, no speaker-embedding model bound) or ' +
  '`ASR_AGENT_DIARIZATION_BACKEND_UNSUPPORTED` (the agent declares a retired backend such as `sortformer`).';

@ApiBearerAuth()
@ApiTags('voice-profile')
@Controller('voice-profiles')
// API-KEY-NOTE — REASONED EXEMPTION from policy A1 (JWT + API key on the
// business plane), recorded and policed by the boot audit
// `BUSINESS_PLANE_KEY_FORBIDDEN` (bootstrap/business-plane-apikey-exemptions-audit.ts).
// Voice biometrics: enrolment audio IS a biometric identifier, and a tenant
// API key has no MFA, no session expiry and no revocation-on-logout. A
// credential that can sit in a CI log must never enrol or read a voice
// profile. JWT only — this is a decision, not pending default.
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
  @ApiResponse({
    status: 400,
    description: 'Missing, oversized or non-audio samples, samples the embedding model rejected, or a request with no tenant context.',
  })
  @ApiResponse({ status: 409, description: DIARIZATION_DISABLED_409 })
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
      // TASK-887 — the agent decides the embedding model, and therefore the space the
      // profile lands in. Absent ⇒ the tenant's assigned ASR agent, resolved by the same
      // cascade a session uses (404-over-403 for another tenant's agent).
      agentSlug: body.agentSlug,
    });

    return VoiceProfileResponse.fromEntity(entity);
  }

  @Get('enrollment-target')
  @Authorize(['read', 'UserVoiceProfile'])
  @ApiOperation({
    summary: 'The embedding model a new enrollment would use',
    description:
      'TASK-887 — resolves the SPEECH_TO_TEXT agent (explicit `agentSlug`, else the tenant’s assigned one) and ' +
      'reports the SPEAKER_EMBEDDING model it declares. A profile whose `modelId` differs from this will never be ' +
      'matched by that agent, so a client uses this to prompt a re-enrollment. TASK-977: refused with 409 ' +
      '`ASR_AGENT_DIARIZATION_DISABLED` while the agent has speaker diarization switched off.',
  })
  @ApiQuery({ name: 'agentSlug', required: false, type: String })
  @ApiResponse({ status: 200, description: 'The enrollment target', type: VoiceProfileEnrollmentTargetResponse })
  @ApiResponse({ status: 400, description: 'The request carries no tenant context.' })
  @ApiResponse({ status: 409, description: DIARIZATION_DISABLED_409 })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent.' })
  async enrollmentTarget(@Query('agentSlug') agentSlug?: string): Promise<VoiceProfileEnrollmentTargetResponse> {
    return VoiceProfileEnrollmentTargetResponse.from(await this.voiceProfileService.enrollmentTarget(agentSlug));
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
