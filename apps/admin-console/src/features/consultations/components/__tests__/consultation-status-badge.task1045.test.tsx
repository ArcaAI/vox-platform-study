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
