import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConsultationStatusBadge, consultationStatusMeta } from '../consultation-status-badge';

afterEach(cleanup);

describe('ConsultationStatusBadge note ready', () => {
  it('shows a "Note ready" chip for STOPPED + IDLE + NOTE_READY, with the status label beside it', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="IDLE" processingReason="NOTE_READY" />);
    expect(screen.getByText('Stopped')).toBeDefined();
    expect(screen.getByText('Note ready')).toBeDefined();
  });

  it('shows no chip for a bare STOPPED + IDLE', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="IDLE" />);
    expect(screen.queryByText('Note ready')).toBeNull();
  });

  it('keeps "Awaiting review" for AWAITING_REVIEW', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="AWAITING_REVIEW" />);
    expect(screen.getByText('Awaiting review')).toBeDefined();
    expect(screen.queryByText('Note ready')).toBeNull();
  });

  it('does not show the chip once approved, even with a stale reason', () => {
    renderWithProviders(<ConsultationStatusBadge status="APPROVED" processing="IDLE" processingReason="NOTE_READY" />);
    expect(screen.queryByText('Note ready')).toBeNull();
  });

  it('reads a legacy PENDING_REVIEW as a ready note', () => {
    expect(consultationStatusMeta('PENDING_REVIEW').processing?.label).toBe('Note ready');
  });

  it('uses a success role so the chip is not colour-only', () => {
    expect(consultationStatusMeta('STOPPED', 'IDLE', 'NOTE_READY').processing).toEqual({ label: 'Note ready', role: 'success' });
  });
});

// TASK-1059 C-03 — every processingReason is visible, in human words.
describe('ConsultationStatusBadge processing reasons', () => {
  it.each([
    ['GUARDRAIL_HOLD', 'Guardrail hold'],
    ['NOTE_GENERATION_FAILED', 'Note generation failed'],
    ['NOTE_COVERAGE_GAPS:3', 'Note coverage gaps (3)'],
    ['SOMETHING_NEW', 'Something new'],
  ])('shows %s as "%s"', (reason, label) => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="AWAITING_REVIEW" processingReason={reason} />);
    expect(screen.getByText('Awaiting review')).toBeDefined();
    expect(screen.getByText(label)).toBeDefined();
  });

  it('shows the reason chip on an IDLE consultation too', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="IDLE" processingReason="NOTE_COVERAGE_GAPS:1" />);
    expect(screen.getByText('Note coverage gaps (1)')).toBeDefined();
  });

  it('does not duplicate NOTE_READY as a reason chip', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="IDLE" processingReason="NOTE_READY" />);
    expect(screen.getAllByText(/note ready/i)).toHaveLength(1);
  });
});

// BUG-041 — a failed governing run on a consultation still recording leaves `processing` alone
// (doctrine: a failed run is not a failed consultation), so the badge must say so itself.
describe('ConsultationStatusBadge governing-run failure', () => {
  const failed = {
    workflowDefinitionSlug: 'arcaai-bren-consultation',
    workflowRunId: 'wr-1',
    status: 'FAILED' as const,
    degraded: false,
    decidedAt: '2026-10-09T16:43:10.000Z',
    failureReason: 'MODEL_ERROR',
  };

  it('shows "Workflow failed" beside a RECORDING status', () => {
    renderWithProviders(<ConsultationStatusBadge status="RECORDING" processing="IDLE" governingRun={failed} />);
    expect(screen.getByText('Recording')).toBeDefined();
    expect(screen.getByText('Workflow failed')).toBeDefined();
  });

  it('shows "Workflow timed out" for a timed-out run', () => {
    renderWithProviders(<ConsultationStatusBadge status="RECORDING" processing="IDLE" governingRun={{ ...failed, status: 'TIMED_OUT' }} />);
    expect(screen.getByText('Workflow timed out')).toBeDefined();
  });

  it('says nothing extra while the run is running or completed', () => {
    for (const status of ['RUNNING', 'COMPLETED'] as const) {
      const { unmount } = renderWithProviders(<ConsultationStatusBadge status="RECORDING" processing="IDLE" governingRun={{ ...failed, status }} />);
      expect(screen.queryByText(/Workflow (failed|timed out)/)).toBeNull();
      unmount();
    }
  });

  it('does not repeat itself once processing already reads failed', () => {
    renderWithProviders(<ConsultationStatusBadge status="STOPPED" processing="FAILED" governingRun={failed} />);
    expect(screen.getByText('Processing failed')).toBeDefined();
    expect(screen.queryByText('Workflow failed')).toBeNull();
  });
});
