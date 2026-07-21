import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Job } from 'bullmq';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { JobQueue, ContextItemRepository, NamedEntityRepository, NamedEntityFactory } from '@arcaai/domains';
import { SecretsService } from '../../../baseServices/_meta/secrets';
import { IConsultationJobService } from '../consultation-job.service';
import { ExtractNerJobPayload, NerJobResult } from '../dto';
import { ConsultationPipelineEvent, NerExtractedPayload } from '../../events';
import { IActiveUserContext } from '../../../../interfaces';
import { assertEqualTenants, createWorkerSession, encryptPhiFields } from '../../../../common';
import { namedEntityPropsFromNlp, type NlpNamedEntity } from '../../shared/namedEntityFromNlp';

@Processor(JobQueue.ExtractNamedEntities)
export class NerProcessor extends WorkerHost {
  private readonly logger = new Logger(NerProcessor.name);
  private readonly nlpServiceUrl: string;

  constructor(
    @Inject(IConsultationJobService) private readonly jobService: IConsultationJobService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService<IActiveUserContext>,
    // Application-level encryption for NamedEntity PHI spans.
    // Optional + trailing so existing positional test fixtures keep compiling;
    // production DI (ConsultationServiceModule) always supplies it.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    super();
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  async process(job: Job<ExtractNerJobPayload>): Promise<NerJobResult> {
    const { jobId, contextItemId, tenantId, userId } = job.data;
    // Fail-closed when tenantId is missing.
    if (!tenantId) {
      throw new Error(`Job ${jobId ?? job.id} is missing required tenantId`);
    }
    // Rebind tenantId + user into a fresh CLS scope so the
    // tenantScope Prisma extension sees the correct context.
    return this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId, tenantId, kind: 'ner' }));

      this.logger.log({
        message: 'Processing NER job',
        jobId,
        contextItemId,
      });

      try {
        // Step 1: Loading context item (10%)
        await this.jobService.notifyProgress(jobId, 10, 'Loading content');

        const contextItem = await this.contextItemRepository.findById(contextItemId);
        if (!contextItem) {
          throw new Error(`Context item ${contextItemId} not found`);
        }
        // Defense in depth: the loaded entity MUST belong to
        // the job's declared tenant, regardless of where it came from.
        assertEqualTenants(contextItem, { tenantId });

        if (!contextItem.content?.trim()) {
          throw new Error('Context item has no content for NER extraction');
        }

        // Step 2: Calling NLP service (30%)
        await this.jobService.notifyProgress(jobId, 30, 'Extracting named entities');

        const nlpResponse = await this.callNlpService(contextItem.content);

        // Step 3: Saving entities (70%)
        await this.jobService.notifyProgress(jobId, 70, 'Saving entities');

        const savedEntities: Array<{
          id: string;
          entityType: string;
          value: string;
          confidence?: number;
          startPosition?: number;
          endPosition?: number;
        }> = [];

        // Save each entity
        for (const entity of nlpResponse.entities) {
          const namedEntity = NamedEntityFactory.CreateNamedEntity(namedEntityPropsFromNlp(entity, { tenantId, contextItemId }));

          await this.encryptBestEffort('NamedEntity', () =>
            this.namedEntityRepository.encryptFieldsIntoEntity(namedEntity, this.secretsService!),
          );
          const saved = await this.namedEntityRepository.create(namedEntity);
          savedEntities.push({
            id: saved.id,
            entityType: saved.className,
            value: saved.text,
            confidence: saved.confidence ?? undefined,
            startPosition: saved.startOffset ?? undefined,
            endPosition: saved.endOffset ?? undefined,
          });
        }

        // Step 4: Complete (100%)
        const result: NerJobResult = {
          contextItemId,
          namedEntities: savedEntities,
        };

        await this.jobService.notifyComplete(jobId, result);

        // Emit NerExtracted event for auto-pipeline completion
        const isAutoGenerated = job.data.callbackUrl === undefined;
        const entityCountByClass = savedEntities.reduce<Record<string, number>>((acc, e) => {
          acc[e.entityType] = (acc[e.entityType] ?? 0) + 1;
          return acc;
        }, {});

        this.eventEmitter.emit(ConsultationPipelineEvent.NerExtracted, {
          consultationId: job.data.consultationId,
          tenantId,
          userId,
          timestamp: new Date().toISOString(),
          contextItemId,
          jobId,
          entityCount: savedEntities.length,
          isAutoGenerated,
          entityCountByClass,
        } satisfies NerExtractedPayload);

        this.logger.log({
          message: 'NER job completed',
          jobId,
          contextItemId,
          entityCount: savedEntities.length,
        });

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error({
          message: 'NER job failed',
          jobId,
          error: errorMessage,
        });
        await this.jobService.notifyFailed(jobId, errorMessage);
        throw error;
      }
    });
  }

  private async callNlpService(content: string): Promise<{
    entities: NlpNamedEntity[];
  }> {
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.nlpServiceUrl}/api/v1/classify/tokens`,
        {
          text: content,
        },
        {
          timeout: 60000, // 1 minute timeout
        },
      );
      return response.data;
    } catch (error) {
      this.logger.error({
        message: 'NLP service call failed',
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error('Failed to extract named entities from NLP service');
    }
  }
}
