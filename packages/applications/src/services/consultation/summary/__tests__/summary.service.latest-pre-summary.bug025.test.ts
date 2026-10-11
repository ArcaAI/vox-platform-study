/**
 * BUG-025 — the "latest pre-summary" read (`GET consultations/:id/summary/pre-summary/latest`, used by
 * the console's Pre-summary panel and the SDK) must never answer with the live note's durable
 * snapshot, which is stored as a PRE_SUMMARY row with `metaData.subType = 'LIVE_SOAP_SNAPSHOT'`.
 */
import { describe, expect, it, vi } from 'vitest';
import { SummaryService } from '../summary.service';

function serviceWith(findLatestPreSummary: ReturnType<typeof vi.fn>): SummaryService {
  const service = Object.create(SummaryService.prototype) as SummaryService;
  (service as unknown as { contextItemRepository: unknown }).contextItemRepository = { findLatestPreSummary };
  return service;
}

describe('SummaryService.getLatestPreSummary (BUG-025)', () => {
  it('excludes the live note snapshot from the latest-pre-summary read', async () => {
    const findLatestPreSummary = vi.fn().mockResolvedValue(null);
    const result = await serviceWith(findLatestPreSummary).getLatestPreSummary('consultation-1');

    expect(result).toBeNull();
    expect(findLatestPreSummary).toHaveBeenCalledWith('consultation-1', { excludeSubTypes: ['LIVE_SOAP_SNAPSHOT'] });
  });
});
