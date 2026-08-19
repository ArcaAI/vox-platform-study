import {
  IKnowledgeDocumentService,
  KnowledgeDocumentResponse,
  PaginatedKnowledgeChunkResponse,
  PaginatedKnowledgeDocumentResponse,
  PaginatedQuery,
} from '@arcaai/applications';
import { Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Authorize, CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Admin governance for the institutional-RAG knowledge corpus, at
 * `/admin/knowledge/documents` (TASK-728).
 *
 * `tenantId` is never a route, query or body parameter: every handler is
 * scoped by whatever `IKnowledgeDocumentService` reads off CLS, so a caller
 * can neither forge nor read another tenant's document. Cross-tenant ids
 * answer **404, never 403** (404-over-403) — enforced in the service's
 * `findOwnedOrThrow`, which runs before any other work on every by-id path.
 *
 * No `POST`/`PATCH` create-or-approve route here: document
 * registration/approval stays on the existing (worker-triggering) ingest
 * flow, which this ticket does not change — see the service docstring.
 *
 * The class-level `@CanManage('KnowledgeDocument')` is the whole gate: this
 * resource carries no imperative privilege check beyond it.
 */
@ApiBearerAuth()
@ApiTags('admin-knowledge')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:knowledge:manage')
@Controller('admin/knowledge/documents')
@CanManage('KnowledgeDocument')
export class KnowledgeController {
  constructor(
    @Inject(IKnowledgeDocumentService)
    private readonly service: IKnowledgeDocumentService,
  ) {}

  @Get()
  @ApiOperation({ summary: "Paginated list of the caller tenant's institutional-knowledge documents" })
  @ApiResponse({ status: 200, type: PaginatedKnowledgeDocumentResponse })
  async list(@Query() query: PaginatedQuery): Promise<PaginatedKnowledgeDocumentResponse> {
    return this.service.listDocuments(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one knowledge document by id' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: KnowledgeDocumentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async getById(@Param('id') id: string): Promise<KnowledgeDocumentResponse> {
    return this.service.getDocument(id);
  }

  @Get(':id/chunks')
  @Authorize(['read', 'KnowledgeDocument'])
  @ApiOperation({
    summary: 'Paginated, decrypted chunk content for one document, ordered by chunkIndex',
    description:
      'Chunk TEXT is the sensitive read this route exists for — every call is force-audited (an AuditLog row is ' +
      'always written, unlike an ordinary list read).',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: PaginatedKnowledgeChunkResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async listChunks(@Param('id') id: string, @Query() query: PaginatedQuery): Promise<PaginatedKnowledgeChunkResponse> {
    return this.service.listChunks(id, query);
  }

  @Post(':id/archive')
  @ApiOperation({
    summary: 'Archive a document (status -> ARCHIVED)',
    description: 'A soft-touch, NOT a delete — the document stays listed and its chunks/vectors are untouched.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 201, type: KnowledgeDocumentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  async archive(@Param('id') id: string): Promise<KnowledgeDocumentResponse> {
    return this.service.archiveDocument(id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Soft-delete a document and remove its vectors from Qdrant',
    description:
      'FAIL-CLOSED: the Qdrant vector cleanup is called first; if the harness cannot confirm the vectors are gone, ' +
      'the whole delete is aborted (the document stays listed) rather than leaving retrievable content behind a ' +
      '"deleted" row.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: 200, type: KnowledgeDocumentResponse })
  @ApiResponse({ status: 404, description: 'Not found (or owned by another tenant).' })
  @ApiResponse({ status: 500, description: 'The harness vector-cleanup call failed; nothing was deleted.' })
  async deleteById(@Param('id') id: string): Promise<KnowledgeDocumentResponse> {
    return this.service.deleteDocument(id);
  }
}
