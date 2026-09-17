import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { SecretsService } from '../baseServices/_meta/secrets';

/**
 * KnowledgeVectorCleanupClient — institutional RAG delete-side sibling of
 * `KnowledgeIngestClient`.
 *
 * Calls the harness internal `DELETE /api/v1/internal/knowledge/{documentId}`
 * endpoint, which removes every Qdrant point belonging to one
 * document, tenant-scoped. `KnowledgeDocumentService.deleteDocument` calls
 * this BEFORE the Postgres soft-delete commits and aborts the delete if it
 * throws (fail-closed — see the service docstring for the reasoning). Mirrors
 * `KnowledgeIngestClient`: base URL from `HARNESS_URL`, authenticated with
 * `X-Service-Token: <HARNESS_INTERNAL_SERVICE_TOKEN>`. Non-2xx responses
 * (including the 503 the harness returns on a Qdrant outage) surface as a
 * thrown error.
 */
@Injectable()
export class KnowledgeVectorCleanupClient {
  private readonly logger = new Logger(KnowledgeVectorCleanupClient.name);
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

  async deleteByDocument(input: { tenantId: string; knowledgeDocumentId: string }): Promise<void> {
    const url = `${this.harnessUrl}/api/v1/internal/knowledge/${encodeURIComponent(input.knowledgeDocumentId)}`;
    const token = (await this.secretsService?.getSecretOptional('HARNESS_INTERNAL_SERVICE_TOKEN')) ?? '';

    await this.httpService.axiosRef.delete(url, {
      params: { tenantId: input.tenantId },
      timeout: 30000,
      headers: { 'X-Service-Token': token, 'X-Tenant-Id': input.tenantId },
    });

    this.logger.log({
      message: 'Knowledge document vectors deleted via harness',
      knowledgeDocumentId: input.knowledgeDocumentId,
      tenantId: input.tenantId,
    });
  }
}
