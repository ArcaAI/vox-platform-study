import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * Request body sent to the harness internal knowledge-ingest endpoint. The
 * harness owns the chunking + embedding + Qdrant upsert; apps/api supplies the
 * tenant, the target document id, the metadata, and the raw `text` (which is
 * NOT a persisted column — it travels in the BullMQ job payload).
 */
export interface KnowledgeIngestRequest {
  tenantId: string;
  knowledgeDocumentId: string;
  title: string;
  source: string;
  mimeType: string;
  text: string;
}

/** One chunk descriptor returned by the harness (one row per chunk). */
export interface KnowledgeIngestChunk {
  chunkIndex: number;
  text: string;
  qdrantPointId: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
  embeddingModel: string;
  embeddingDim: number;
  status: string;
}

/** Response body from the harness internal knowledge-ingest endpoint. */
export interface KnowledgeIngestResponse {
  chunkCount: number;
  chunks: KnowledgeIngestChunk[];
}

/**
 * KnowledgeIngestClient — institutional RAG.
 *
 * Thin outbound HTTP client the BullMQ ingestion worker uses to call the harness
 * internal chunk+embed+upsert endpoint. Mirrors HarnessGatewayService: base URL
 * resolves from `HARNESS_URL` (default `http://localhost:8866`), authenticated
 * with `X-Service-Token: <HARNESS_INTERNAL_SERVICE_TOKEN>`.
 *
 * Non-2xx responses (including the 503 the harness returns when its
 * embedder/Qdrant is unavailable) surface as a thrown error, so the worker's
 * `process()` rejects and BullMQ retries the job per its `attempts` policy.
 */
@Injectable()
export class KnowledgeIngestClient {
  private readonly logger = new Logger(KnowledgeIngestClient.name);
  private readonly harnessUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    // Optional so unit fixtures compile without a mock. When unset we send an
    // empty token, which the harness-side service-token guard rejects.
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {
    this.harnessUrl = this.configService.get<string>('HARNESS_URL') ?? 'http://localhost:8866';
  }

  async ingest(request: KnowledgeIngestRequest): Promise<KnowledgeIngestResponse> {
    // The harness mounts this route under its global `/api/v1` prefix
    // (`/api/v1/internal/knowledge/ingest`), exactly like HarnessGatewayService's
    // `/api/v1/internal/...` calls. `HARNESS_URL` is the base host only.
    const url = `${this.harnessUrl}/api/v1/internal/knowledge/ingest`;
    const token = (await this.secretsService?.getSecretOptional('HARNESS_INTERNAL_SERVICE_TOKEN')) ?? '';

    const response = await this.httpService.axiosRef.post<KnowledgeIngestResponse>(url, request, {
      timeout: 120000,
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Token': token,
        'X-Tenant-Id': request.tenantId,
      },
    });

    this.logger.log({
      message: 'Knowledge document ingested via harness',
      knowledgeDocumentId: request.knowledgeDocumentId,
      chunkCount: response.data?.chunkCount,
    });
    return response.data;
  }
}
