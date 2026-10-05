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
