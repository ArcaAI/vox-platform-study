import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConsultationHeaderMeta } from '../consultation-header-meta';

afterEach(() => vi.unstubAllGlobals());

const detail = {
  id: 'c-1',
  patientId: 'pat-123',
  doctorId: 'd-1',
  doctor: { id: 'd-1', username: 'auto_77' },
  department: { id: 'dep', name: 'Cardiology', code: 'CARD' },
  appointmentDate: '2026-10-09',
  parentConsultationId: 'c-0',
  approval: { id: 'a', approvedAt: '2026-10-09T10:00:00.000Z', approvedBy: 'u', snapshotHash: 'h', itemCount: 4 },
  closedReason: 'APPROVED',
  autoCloseAt: null,
  encounters: [{ seq: 1 }, { seq: 2 }],
  createdAt: '2026-10-09T09:00:00.000Z',
  updatedAt: '2026-10-09T09:00:00.000Z',
};

describe('ConsultationHeaderMeta', () => {
  it('renders the consultation fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(detail)));
    renderWithProviders(<ConsultationHeaderMeta consultationId="c-1" />);
    expect(await screen.findByText('pat-123')).toBeDefined();
    expect(screen.getByText('Auto-provisioned clinician')).toBeDefined();
    expect(screen.getByText(/Cardiology/)).toBeDefined();
    expect(screen.getByText('Revisit')).toBeDefined();
    expect(screen.getByText(/4 items/)).toBeDefined();
    expect(screen.getByText('APPROVED')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('shows a dash for absent fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...detail, department: undefined, approval: null, closedReason: null, encounters: undefined })));
    renderWithProviders(<ConsultationHeaderMeta consultationId="c-1" />);
    await screen.findByText('pat-123');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });
});
