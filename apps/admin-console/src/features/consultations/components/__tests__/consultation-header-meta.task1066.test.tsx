import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConsultationHeaderMeta } from '../activity/consultation-header-meta';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ConsultationHeaderMeta workflow row', () => {
  it('shows "Awaiting review gate" for a running run on an awaiting-review consultation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('settings/features')
          ? Response.json({ items: [] })
          : Response.json({
              id: 'c-1',
              patientId: 'p-1',
              processing: 'AWAITING_REVIEW',
              status: 'STOPPED',
              governingRun: { workflowDefinitionSlug: 'soap', workflowRunId: 'wr-1', status: 'RUNNING', degraded: false, decidedAt: '2026-10-01T00:00:00Z', failureReason: null },
            }),
      ),
    );
    renderWithProviders(<ConsultationHeaderMeta consultationId="c-1" />);
    await waitFor(() => expect(screen.getByText('Awaiting review gate')).toBeTruthy());
  });
});
