/**
 * LoopContextTextService.resolveExtractedText.
 *
 * Backs the loop's `document.extract_text` action. Two properties matter and
 * both are load-bearing:
 *
 *  * it NEVER throws — a missing, cross-tenant or not-yet-extracted item all
 *    resolve to `null`, which the loop reads as "nothing derived" and treats as
 *    the end of that cascade branch;
 *  * it is scoped by BOTH tenant and consultation — the tenant-scope extension
 *    already hides a cross-tenant row, but an id belonging to a different
 *    consultation of the SAME tenant would otherwise leak one consultation's
 *    document text into another's loop.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { LoopContextTextService } from '../loop-context-text.service';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockContextItemRepository = { findById: vi.fn() };

function buildService(): LoopContextTextService {
  return new LoopContextTextService(
    mockContextItemRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
  );
}

const ITEM = {
  id: 'ci-1',
  tenantId: 'tenant-1',
  consultationId: 'consult-1',
  metaData: { extractedText: '  Referral letter: patient has AF.  ' },
};

describe('LoopContextTextService.resolveExtractedText', () => {
  let service: LoopContextTextService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = buildService();
  });

  it('returns the trimmed extracted text for an in-scope item', async () => {
    mockContextItemRepository.findById.mockResolvedValue(ITEM);

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBe('Referral letter: patient has AF.');
  });

  it('returns null — never throws — when the item does not exist', async () => {
    mockContextItemRepository.findById.mockRejectedValue(new DataNotFoundException('ContextItem', 'ci-1'));

    await expect(service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1')).resolves.toBeNull();
  });

  it('returns null for an item belonging to another tenant', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, tenantId: 'other-tenant' });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('returns null for an item belonging to another consultation of the SAME tenant', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, consultationId: 'consult-2' });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('returns null when OCR has not run yet (no extractedText)', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, metaData: {} });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('returns null when metaData is absent entirely', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, metaData: null });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('treats a whitespace-only extraction as nothing extracted', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, metaData: { extractedText: '   \n  ' } });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('treats a non-string extractedText as nothing extracted rather than coercing it', async () => {
    mockContextItemRepository.findById.mockResolvedValue({ ...ITEM, metaData: { extractedText: { nested: 'x' } } });

    const text = await service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1');

    expect(text).toBeNull();
  });

  it('propagates a genuine infrastructure error rather than hiding it as "no text"', async () => {
    // A DB outage is NOT "nothing extracted" — the activity's own try/except
    // decides the cascade outcome, and it must be able to tell the two apart.
    mockContextItemRepository.findById.mockRejectedValue(new Error('db-down'));

    await expect(service.resolveExtractedText('tenant-1', 'consult-1', 'ci-1')).rejects.toThrow('db-down');
  });
});
