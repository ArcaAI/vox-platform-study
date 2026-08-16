import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { KnowledgeDocumentStatus } from '@arcaai/domains';
import { PaginatedResponse } from '../../../common';

export class KnowledgeDocumentResponse {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty() title: string;
  @ApiProperty({ description: 'Origin reference (filename / URL / path).' }) source: string;
  @ApiProperty({ description: 'Loader/source category, e.g. "text", "markdown", "upload".' }) sourceType: string;
  @ApiProperty() mimeType: string;
  @ApiProperty({ description: 'Content hash for dedup / change detection.' }) checksum: string;
  @ApiProperty({ enum: KnowledgeDocumentStatus }) status: KnowledgeDocumentStatus;
  @ApiPropertyOptional({ nullable: true }) approvedBy: string | null;
  @ApiPropertyOptional({ nullable: true }) approvedAt: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'Set once the harness ingest job has completed.' })
  ingestedAt: string | null;
  @ApiProperty({ description: 'Number of KnowledgeChunk rows the last ingest produced.' }) chunkCount: number;
  @ApiProperty({ description: 'Optimistic-concurrency counter; rendered as the strong `ETag` by the global interceptor.' })
  version: number;
  @ApiProperty() createdAt: string;
  @ApiProperty() updatedAt: string;
}

export class PaginatedKnowledgeDocumentResponse extends PaginatedResponse<KnowledgeDocumentResponse> {
  @ApiProperty({ type: [KnowledgeDocumentResponse] })
  override readonly data!: readonly KnowledgeDocumentResponse[];
}

export class KnowledgeChunkResponse {
  @ApiProperty() id: string;
  @ApiProperty() tenantId: string;
  @ApiProperty() knowledgeDocumentId: string;
  @ApiProperty() chunkIndex: number;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Decrypted chunk text (Vault-Transit ciphertext, decrypted server-side via decrypt-on-read). Null when the ' +
      'platform runs without Vault-mode secrets (local dev) — see KnowledgeChunk.encryptedText.',
  })
  text: string | null;
  @ApiProperty() tokenCount: number;
  @ApiProperty() startOffset: number;
  @ApiProperty() endOffset: number;
  @ApiProperty({ description: 'The point id in the harness-owned Qdrant `knowledge_chunks` collection.' }) qdrantPointId: string;
  @ApiProperty() embeddingModel: string;
  @ApiProperty() embeddingDim: number;
  @ApiProperty() status: string;
  @ApiProperty() createdAt: string;
}

export class PaginatedKnowledgeChunkResponse extends PaginatedResponse<KnowledgeChunkResponse> {
  @ApiProperty({ type: [KnowledgeChunkResponse] })
  override readonly data!: readonly KnowledgeChunkResponse[];
}
