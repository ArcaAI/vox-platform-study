import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KnowledgeController } from '../knowledge.controller';

/**
 * Thin pass-through controller — the service owns tenancy/audit/fail-closed
 * behavior (see `knowledge-document.service.test.ts`). These tests only
 * assert each route delegates to the right service method with the right
 * arguments.
 */
const createMockService = () => ({
  registerDocument: vi.fn(),
  approveDocument: vi.fn(),
  getDocument: vi.fn(),
  listDocuments: vi.fn(),
  listChunks: vi.fn(),
  archiveDocument: vi.fn(),
  deleteDocument: vi.fn(),
});

describe('KnowledgeController', () => {
  let controller: KnowledgeController;
  let mockService: ReturnType<typeof createMockService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockService = createMockService();
    controller = new KnowledgeController(mockService as never);
  });

  it('GET / delegates to service.listDocuments with the query', async () => {
    mockService.listDocuments.mockResolvedValue({ data: [], count: 0, limit: 10, page: 0 });
    const query = { page: 0, limit: 10 };

    await controller.list(query);

    expect(mockService.listDocuments).toHaveBeenCalledWith(query);
  });

  it('GET /:id delegates to service.getDocument', async () => {
    mockService.getDocument.mockResolvedValue({ id: 'doc-1' });

    const result = await controller.getById('doc-1');

    expect(mockService.getDocument).toHaveBeenCalledWith('doc-1');
    expect(result).toEqual({ id: 'doc-1' });
  });

  it('GET /:id/chunks delegates to service.listChunks with id and query', async () => {
    mockService.listChunks.mockResolvedValue({ data: [], count: 0, limit: 10, page: 0 });
    const query = { page: 0, limit: 20 };

    await controller.listChunks('doc-1', query);

    expect(mockService.listChunks).toHaveBeenCalledWith('doc-1', query);
  });

  it('POST /:id/archive delegates to service.archiveDocument', async () => {
    mockService.archiveDocument.mockResolvedValue({ id: 'doc-1', status: 'ARCHIVED' });

    const result = await controller.archive('doc-1');

    expect(mockService.archiveDocument).toHaveBeenCalledWith('doc-1');
    expect(result).toEqual({ id: 'doc-1', status: 'ARCHIVED' });
  });

  it('DELETE /:id delegates to service.deleteDocument', async () => {
    mockService.deleteDocument.mockResolvedValue({ id: 'doc-1' });

    await controller.deleteById('doc-1');

    expect(mockService.deleteDocument).toHaveBeenCalledWith('doc-1');
  });
});
