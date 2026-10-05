import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { resolveEffectiveLanguageMode } from '../../../../common/language/language-mode';
import { IActiveUserContext } from '../../../../interfaces';
import { IBlobStorageService } from '../../../baseServices/storage/IBlobStorageService';
import { IBillingService } from '../../../billing/IBillingService';
import { AsrAgentResolverService } from '../../../stt/agent-resolver/asr-agent-resolver.service';
import { TranscriptionJobService } from '../../../stt/job/transcriptionJob.service';
import { TranscriptionRealtimeService } from '../../../stt/realtime/transcriptionRealtime.service';
import { AttachmentProcessInput, AttachmentProcessOutcome } from './attachment-processor';

/**
 * `audio`: one batch transcription of the uploaded file. The same money gate, job and dispatch as
 * `POST agents/:slug/transcriptions`, minus the explicit agent: the ASR agent resolves from the
 * consultation (governing workflow → department → tenant assignment) and the spoken language from
 * the consultation's declaration. The job owner is the consultation's doctor, never the caller —
 * a machine identity is not a clinician. The transcript comes back through
 * {@link AttachmentTranscriptSink}, which turns it into ONE transcript item.
 */
@Injectable()
export class AudioAttachmentProcessor {
  private readonly logger = new Logger(AudioAttachmentProcessor.name);

  constructor(
    private readonly asrResolver: AsrAgentResolverService,
    private readonly jobService: TranscriptionJobService,
    private readonly realtimeService: TranscriptionRealtimeService,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    private readonly cls: ClsService<IActiveUserContext>,
    // Absent = the spend ceiling is not enforced (a gateway without the billing module).
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
  ) {}

  /** The tenant's monthly spend ceiling (402), checked before anything is written or dispatched. */
  async preflight(): Promise<void> {
    await this.billing?.assertSpendLimit(this.requireTenant());
  }

  async process(input: AttachmentProcessInput): Promise<AttachmentProcessOutcome> {
    const tenantId = this.requireTenant();
    const resolved = await this.asrResolver.resolve({ tenantId, consultationId: input.consultationId, departmentId: null });
    const { spec } = resolved;
    const effective = resolveEffectiveLanguageMode({ consultation: resolved.consultationLanguageMode ?? null });
    const language = effective.source === 'consultation' ? { languageMode: effective.mode, languageModeSource: effective.source } : {};

    const job = await this.jobService.createBatchJob({
      agentVersionId: spec.agent.versionId,
      resolvedSpec: spec as unknown as Record<string, unknown>,
      mediaId: input.mediaId,
      consultationId: input.consultationId,
    });
    try {
      // `null` for a SHARED tenant: the worker then uses its default client with the bucket name.
      // swallow-ok: an unresolvable descriptor degrades to that same default, as the upload route does.
      const storage = await this.blobStorage.resolveDescriptor(input.bucket).catch(() => null);
      await this.realtimeService.dispatchDramatiqJob({
        jobId: job.id,
        tenantId,
        resolvedSpec: spec,
        audioUri: `s3://${input.bucket}/${input.key}`,
        consultationId: input.consultationId,
        mediaId: input.mediaId,
        userId: input.doctorId ?? undefined,
        audioBucketName: input.bucket,
        storage,
        ...language,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Attachment audio transcription dispatch failed',
        jobId: job.id,
        attachmentId: input.attachmentId,
        error: message,
      });
      // swallow-ok: the dispatch error is what the caller must see; failing the job is best-effort.
      await this.jobService.failJob(job.id, message, 'SETUP_ERROR').catch(() => undefined);
      throw error instanceof HttpException ? error : new HttpException({ detail: 'Batch transcription dispatch failed' }, HttpStatus.BAD_GATEWAY);
    }
    return { pending: true, contextItemId: null, transcriptionJobId: job.id };
  }

  private requireTenant(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context required');
    return tenantId;
  }
}
