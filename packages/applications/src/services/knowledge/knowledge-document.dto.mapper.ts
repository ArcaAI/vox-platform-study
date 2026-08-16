import { KnowledgeChunkEntity, KnowledgeDocumentEntity } from '@arcaai/domains';
import { FetchResponse } from '../../common';
import { KnowledgeChunkResponse, KnowledgeDocumentResponse, PaginatedKnowledgeChunkResponse, PaginatedKnowledgeDocumentResponse } from './dto';

export class KnowledgeDocumentDtoMapper {
  static toResponse(entity: KnowledgeDocumentEntity): KnowledgeDocumentResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      title: entity.title,
      source: entity.source,
      sourceType: entity.sourceType,
      mimeType: entity.mimeType,
      checksum: entity.checksum,
      status: entity.status,
      approvedBy: entity.approvedBy ?? null,
      approvedAt: toIso(entity.approvedAt) ?? null,
      ingestedAt: toIso(entity.ingestedAt) ?? null,
      chunkCount: entity.chunkCount,
      version: entity.version,
      createdAt: toIso(entity.createdAt) as string,
      updatedAt: toIso(entity.updatedAt) as string,
    };
  }

  static toPaginatedResponse({ data, count, limit, page }: FetchResponse<KnowledgeDocumentEntity>): PaginatedKnowledgeDocumentResponse {
    return new PaginatedKnowledgeDocumentResponse({
      page,
      limit,
      count,
      data: data.map((entity) => this.toResponse(entity)),
    });
  }

  /**
   * `entity.text` is the transient plaintext property repopulated by
   * decrypt-on-read (`phi-read-decrypt.ts`) when the platform runs in
   * Vault-secrets mode. It is `null` when no `SecretsService` has been wired
   * (local dev / unit tests) — the ciphertext itself (`encryptedText`) is
   * NEVER surfaced on this DTO.
   */
  static toChunkResponse(entity: KnowledgeChunkEntity): KnowledgeChunkResponse {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      knowledgeDocumentId: entity.knowledgeDocumentId,
      chunkIndex: entity.chunkIndex,
      text: entity.text ?? null,
      tokenCount: entity.tokenCount,
      startOffset: entity.startOffset,
      endOffset: entity.endOffset,
      qdrantPointId: entity.qdrantPointId,
      embeddingModel: entity.embeddingModel,
      embeddingDim: entity.embeddingDim,
      status: entity.status,
      createdAt: toIso(entity.createdAt) as string,
    };
  }

  static toPaginatedChunkResponse({ data, count, limit, page }: FetchResponse<KnowledgeChunkEntity>): PaginatedKnowledgeChunkResponse {
    return new PaginatedKnowledgeChunkResponse({
      page,
      limit,
      count,
      data: data.map((entity) => this.toChunkResponse(entity)),
    });
  }
}

/** Timestamps are ISO strings on the wire. Tolerates a plain object from a hand-built test fixture. */
function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}
