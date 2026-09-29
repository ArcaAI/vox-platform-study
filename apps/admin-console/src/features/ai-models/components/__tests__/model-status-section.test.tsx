/** TASK-1019 (Lane C) — the drawer's "Status" section: per-service state with device, memory, load, error. */

import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ModelStatusSection } from '../model-status-section';
import { modelWith, stubFetch } from './fixtures.task1019';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ModelStatusSection', () => {
  it('lists every service with state, device, memory, in-flight, req/min and the recorded error', async () => {
    const model = modelWith('m-1', 'Whisper ML-EN', 'LOAD_FAILED', {}, {
      services: [
        { service: 'stt', state: 'loaded', device: 'cuda:0', bytes: 2 * 1024 ** 3, inFlight: 1, requestsPerMin: 12, error: null },
        {
          service: 'stt-worker',
          state: 'failed',
          device: null,
          bytes: null,
          inFlight: null,
          requestsPerMin: null,
          error: { code: 'CUDA_OOM', message: 'out of memory', at: '2026-09-29T10:00:00.000Z' },
        },
      ],
    });
    stubFetch(() => Response.json(model, { headers: { etag: '"4"' } }));
    renderWithProviders(<ModelStatusSection model={model} />);

    const table = await screen.findByRole('table', { name: 'Per-service status' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('stt')).toBeDefined();
    expect(within(rows[1]).getByText('Loaded')).toBeDefined();
    expect(within(rows[1]).getByText('cuda:0')).toBeDefined();
    expect(within(rows[1]).getByText('2 GB')).toBeDefined();
    expect(within(rows[1]).getByText('12')).toBeDefined();
    expect(within(rows[2]).getByText('Failed')).toBeDefined();
    expect(within(rows[2]).getByText('CUDA_OOM')).toBeDefined();
    expect(within(rows[2]).getByText(/out of memory/)).toBeDefined();
    expect(screen.getByText('Load failed')).toBeDefined();
  });

  it('shows skeletons until the first read, and an honest note when no engine reports the model', async () => {
    stubFetch(() => new Promise<Response>(() => {}));
    const { container, unmount } = renderWithProviders(<ModelStatusSection model={{ ...modelWith('m-1', 'X', 'SERVING'), lifecycle: null }} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    unmount();

    const model = modelWith('m-1', 'X', 'NOT_OBSERVED');
    stubFetch(() => Response.json(model, { headers: { etag: '"4"' } }));
    renderWithProviders(<ModelStatusSection model={model} />);
    expect(await screen.findByText('No serving engine reports this model.')).toBeDefined();
  });
});
