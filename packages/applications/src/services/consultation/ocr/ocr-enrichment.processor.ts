import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ContextItemRepository, ContextItemType } from '@arcaai/domains';
import { IBlobStorageService } from '../../baseServices/storage';
import { assertEqualTenants, createWorkerSession, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { ConsultationPipelineEvent, ContextAddedPayload } from '../events';

/** NLP `/extract` response shape. */
interface NlpExtractResult {
  text: string;
  pageCount: number;
  ocrUsed: boolean;
}

/**
 * OcrEnrichmentProcessor — server-side OCR orchestration.
 *
 * Event-driven heavy-OCR enrichment that needs NO new apps/api route. Reacts to
 * `ConsultationPipelineEvent.ContextAdded`: when the added item is an ATTACHMENT
 * that has a `mediaId` but NO `metaData.extractedText` (i.e. the client-side
 * text-layer extractor found nothing — a scanned/image lab), it:
 *
 *   1. fetches the file bytes from the tenant bucket via `IBlobStorageService`,
 *   2. calls the NLP `/api/v1/extract` endpoint (PyMuPDF + RapidOCR, in-cluster),
 *   3. persists the result onto `ContextItem.metaData.extractedText`, and
 *   4. re-emits the live `ContextAdded` preview so `LiveDocumentationService`
 *      folds the OCR text into the running summary.
 *
 * The harness `assemble` already reads `metaData.extractedText`, so the
 * authoritative SOAP lights up with no harness change.
 *
 * LOOP GUARD: it only acts when `extractedText` is absent. After step 3 persists
 * it, the re-emitted `ContextAdded` re-fires this handler, which now finds
 * `extractedText` present and no-ops — so there is no re-OCR and no infinite loop.
 *
 * PHI posture (§C): bytes stay in-cluster (tenant bucket → NLP); no third-party
 * egress. Gated behind `OCR_ENABLED`, which DEFAULTS TO ENABLED because the
 * in-cluster RapidOCR path has no PHI egress. Every failure degrades gracefully
 * to the filename-label fallback — it never throws and never blocks the upload.
 */
@Injectable()
export class OcrEnrichmentProcessor {
  private readonly logger = new Logger(OcrEnrichmentProcessor.name);
  private readonly nlpServiceUrl: string;
  private readonly ocrEnabled: boolean;
  private readonly ocrBucket: string;

  constructor(
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageService,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cls: ClsService<IActiveUserContext>,
    // Optional + trailing so existing positional fixtures keep their
    // arity; when wired, the OCR-extracted text is encrypted into
    // `ContextItem.encryptedContent` before persist (F-031).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
    // Default ENABLED — the in-cluster RapidOCR path has no PHI egress (§C). Only
    // an explicit falsey value disables it; the A3 managed-cloud OCR provider (which
    // WOULD egress PHI) is intentionally out of scope and left as a config hook.
    this.ocrEnabled = !this.isFalsey(this.configService.get<string>('OCR_ENABLED'));
    // The logical bucket the client uploads lab attachments to (frontend
    // STORAGE_BUCKET = 'attachments'); the per-tenant provider is resolved by the
    // blob-storage service from CLS, so only the bucket NAME is needed here.
    this.ocrBucket = this.configService.get<string>('OCR_STORAGE_BUCKET') ?? 'attachments';
  }

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  @OnEvent(ConsultationPipelineEvent.ContextAdded, { async: true })
  async handleContextAdded(payload: ContextAddedPayload): Promise<void> {
    if (!this.ocrEnabled) return;
    // Only uploaded attachments carry file bytes worth OCR-ing.
    if (payload.contextType !== ContextItemType.ATTACHMENT) return;

    const { consultationId, tenantId, contextItemId } = payload;
    if (!tenantId) {
      this.logger.error({ message: 'ContextAdded (OCR) payload missing tenantId — aborting', consultationId, contextItemId });
      return;
    }

    // EventEmitter2 async handlers run in a microtask that does NOT inherit the
    // caller's AsyncLocalStorage scope — re-establish CLS so the tenantScope Prisma
    // extension scopes the repo reads/writes correctly (mirrors ConsultationEventHandler).
    await this.cls.run(async () => {
      this.cls.set('tenantId', tenantId);
      this.cls.set('user', createWorkerSession({ userId: payload.userId, tenantId, kind: 'ocr-enrichment' }));

      try {
        const item = await this.contextItemRepository.findById(contextItemId);
        if (!item) return;
        // Defense in depth: the loaded item MUST belong to the event's tenant.
        assertEqualTenants(item, { tenantId });

        const mediaId = item.mediaId;
        if (!mediaId) return; // media-less attachment → nothing to OCR

        // LOOP GUARD: only act when extractedText is absent. A re-fired ContextAdded
        // (from our own re-emit below) finds it present and no-ops here.
        const meta = (item.metaData ?? {}) as Record<string, unknown>;
        const existing = typeof meta.extractedText === 'string' ? meta.extractedText.trim() : '';
        if (existing) return;

        const bytes = await this.blobStorage.getObject({ bucket: this.ocrBucket, key: mediaId });
        const fileName = typeof meta.fileName === 'string' ? meta.fileName : 'upload';
        const extracted = await this.callNlpExtract(bytes, fileName);
        const text = (extracted.text ?? '').trim();
        if (!text) {
          // OCR yielded nothing (truly unreadable scan) → keep the filename label.
          this.logger.debug({ message: 'OCR produced no text — keeping label fallback', consultationId, contextItemId });
          return;
        }

        // Persist metaData.extractedText (merge, preserving subType/fileName).
        item.metaData = { ...meta, extractedText: text };
        // Also fold the OCR text onto the entity's canonical `content` (encrypted
        // below) — readers of the standard ContextItem response (`content`) would
        // otherwise see nothing even after a successful OCR, since metaData is a
        // secondary, harness-only surface (see class doc above).
        item.content = text;
        // Encrypt `content` into `encryptedContent` before
        // persistence — the plaintext `content` column was dropped by the PHI
        // field-encryption migration, so an unencrypted update here would
        // silently lose the OCR'd clinical text at rest (mirrors
        // context.service.ts `encryptContent`).
        await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(item, this.secretsService!));
        await this.contextItemRepository.update(contextItemId, item);

        // Re-emit the live preview so LiveDocumentationService folds the OCR text
        // into the running summary. The loop guard above makes the re-fire a no-op.
        const subType = typeof meta.subType === 'string' ? (meta.subType as string) : undefined;
        this.eventEmitter.emit(ConsultationPipelineEvent.ContextAdded, {
          consultationId,
          tenantId,
          userId: payload.userId,
          timestamp: new Date().toISOString(),
          contextItemId,
          contextType: payload.contextType,
          subType,
          contentPreview: text.slice(0, 2000),
        } satisfies ContextAddedPayload);

        this.logger.log({
          message: 'OCR enrichment complete',
          consultationId,
          contextItemId,
          chars: text.length,
          pageCount: extracted.pageCount,
          ocrUsed: extracted.ocrUsed,
        });
      } catch (error) {
        // Never throw out of an @OnEvent handler — degrade to the filename label.
        this.logger.warn({
          message: 'OCR enrichment failed — degrading to filename label',
          consultationId,
          contextItemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  private async callNlpExtract(bytes: Buffer, fileName: string): Promise<NlpExtractResult> {
    // Multipart upload — bytes are sent directly so the NLP service never needs
    // storage credentials (keeps the PHI path in-cluster, no third-party egress).
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), fileName);

    const response = await this.httpService.axiosRef.post<NlpExtractResult>(`${this.nlpServiceUrl}/api/v1/extract`, form, {
      timeout: 120000, // OCR is CPU-bound (~0.9s/scanned page) — allow a generous budget
    });
    return response.data;
  }

  /** Treat unset as ENABLED; only an explicit falsey string disables OCR. */
  private isFalsey(value: string | undefined): boolean {
    if (value === undefined) return false;
    return ['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
  }
}
