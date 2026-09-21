/**
 * TASK-999 Lane C — the consultation detail pane's telemetry blocks
 * (`GET admin/consultations/:id/telemetry`, contract C-1). The whole point of
 * `Block<T>` is that an empty block must say WHY: a fabricated zero would
 * tell a clinician a summary cost nothing when nobody ever measured it.
 *
 * Before this change none of `api/telemetry.ts`,
 * `components/telemetry/telemetry-blocks.tsx` or
 * `components/telemetry/consultation-telemetry-section.tsx` existed, so every
 * one of these tests failed on "Cannot find module" — the RED state noted
 * per test below is that non-existence.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { ConsultationTelemetryResponse } from '../../../api/telemetry';
import { ConsultationTelemetrySection } from '../consultation-telemetry-section';

function stubFetch(body: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(body, { status })),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** A fully "available" telemetry response — tests override just the block(s) they care about. */
function buildTelemetry(overrides: Partial<ConsultationTelemetryResponse> = {}): ConsultationTelemetryResponse {
  return {
    consultationId: 'c-1',
    generatedAt: '2026-09-22T10:00:00.000Z',
    session: { available: true, source: 'context-item', data: { startedAt: '2026-09-22T09:00:00.000Z', lastActivityAt: '2026-09-22T09:15:00.000Z', durationMs: 900_000 } },
    caseNotes: { available: true, source: 'context-item', data: { count: 3, measuredCount: 3, wordCount: 120, charCount: 640 } },
    transcription: { available: true, source: 'audio-recording', data: { jobCount: 1, durationMs: 60_000, wordCount: 200, charCount: 1100, model: 'whisper-large', provider: 'openai' } },
    preSummary: { available: true, source: 'summary-meta', data: { inputTokens: 500, outputTokens: 80, model: 'gpt-4o-mini', provider: 'azure', durationMs: 1200 } },
    partialSummary: { available: true, source: 'agent-trajectory', data: { callCount: 4, inputTokens: 2000, outputTokens: 300, models: ['gpt-4o-mini'], provider: 'azure', avgDurationMs: 500, totalDurationMs: 2000 } },
    finalSummary: { available: true, source: 'summary-meta', data: { inputTokens: 900, outputTokens: 150, model: 'gpt-4o', provider: 'azure', durationMs: 1800 } },
    ner: { available: true, source: 'named-entity', data: { entityCount: 12, byLabel: { DRUG: 5, SYMPTOM: 7 }, callCount: 1, totalDurationMs: 300 } },
    guardrail: { available: true, source: 'usage-ledger', data: { callCount: 2, inputTokens: 400, outputTokens: 20, models: ['guardian-4'], provider: 'system', avgDurationMs: 100, totalDurationMs: 200 } },
    ...overrides,
  };
}

async function heading(name: string) {
  return screen.findByRole('heading', { name, level: 3 });
}

describe('ConsultationTelemetrySection', () => {
  it('shows skeletons, not a spinner or "Loading…", while pending', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const { container } = renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(screen.queryByText(/loading/i)).toBeNull();
  });

  it('renders the values of an available block', async () => {
    stubFetch(buildTelemetry());
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    const preSummary = (await heading('Pre-summary')).closest('section');
    expect(preSummary).not.toBeNull();
    expect(preSummary!.textContent).toContain('500'); // inputTokens
    expect(preSummary!.textContent).toContain('80'); // outputTokens
    expect(preSummary!.textContent).toContain('gpt-4o-mini');
    expect(preSummary!.textContent).toContain('1,200 ms');
  });

  it('renders the NOT_RECORDED explanation, never a fabricated zero, for an unavailable block', async () => {
    stubFetch(buildTelemetry({ guardrail: { available: false, source: null, reason: 'NOT_RECORDED' } }));
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    const guardrail = (await heading('Guardrail')).closest('section');
    expect(guardrail!.textContent).toContain('not recorded by the platform');
    // A missing call count must never read as a real zero call count.
    expect(guardrail!.textContent).not.toMatch(/\b0\b/);
  });

  it('renders a null field inside an available block as an em dash, never a zero', async () => {
    stubFetch(
      buildTelemetry({
        finalSummary: { available: true, source: 'summary-meta', data: { inputTokens: null, outputTokens: 40, model: null, provider: null, durationMs: null } },
      }),
    );
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    const finalSummary = (await heading('Final summary')).closest('section');
    // Every unmeasured field is an em dash — never a "0" masquerading as a real count.
    expect(finalSummary!.textContent).toContain('—');
    expect(finalSummary!.textContent).not.toMatch(/\b0\b/);
    expect(finalSummary!.textContent).toContain('40'); // the one field that WAS measured still renders
  });

  it('renders PRUNED distinctly from NO_ACTIVITY', async () => {
    stubFetch(
      buildTelemetry({
        partialSummary: { available: false, source: 'agent-trajectory', reason: 'PRUNED' },
        ner: { available: false, source: null, reason: 'NO_ACTIVITY' },
      }),
    );
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    const partialSummary = (await heading('Partial (live) summary')).closest('section');
    const ner = (await heading('NER / entities')).closest('section');
    expect(partialSummary!.textContent).toContain('beyond the telemetry retention window');
    expect(ner!.textContent).toContain('no activity for this consultation');
    expect(partialSummary!.textContent).not.toContain('no activity for this consultation');
    expect(ner!.textContent).not.toContain('beyond the telemetry retention window');
  });

  it('treats a 404 as an unavailable surface, never an error toast', async () => {
    stubFetch({ message: 'Not Found' }, 404);
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    expect(await screen.findByText('Telemetry is not available for this consultation.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders a retryable error card for a genuine failure', async () => {
    stubFetch({ message: 'boom' }, 500);
    renderWithProviders(<ConsultationTelemetrySection consultationId="c-1" />);

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
  });
});
