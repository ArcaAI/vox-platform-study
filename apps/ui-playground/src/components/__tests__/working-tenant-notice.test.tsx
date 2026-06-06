import { render, screen } from '@testing-library/react';

import { WorkingTenantNotice } from '../working-tenant-notice';
import { useAuthStore } from '@/store/auth-store';

vi.mock('@/store/auth-store', () => ({
  useAuthStore: vi.fn(),
}));

const mockUseAuthStore = vi.mocked(useAuthStore);

function mockState(state: { tenantId: string; tenantName?: string; isGlobalScope?: boolean }) {
  const full = {
    tenantId: state.tenantId,
    tenantName: state.tenantName ?? '',
    isGlobalScope: () => state.isGlobalScope ?? false,
  };
  mockUseAuthStore.mockImplementation((selector: any) => selector(full));
}

describe('WorkingTenantNotice (TASK-335 #3)', () => {
  afterEach(() => vi.clearAllMocks());

  it('names the selected working tenant so the gate reflects header scope', () => {
    mockState({ tenantId: 't-1', tenantName: 'Acme Hospital' });
    render(<WorkingTenantNotice />);
    expect(screen.getByText(/Working tenant/i)).toBeInTheDocument();
    expect(screen.getByText('Acme Hospital')).toBeInTheDocument();
  });

  it('falls back to a short tenant id when the name is unknown', () => {
    mockState({ tenantId: '50000000-aaaa-bbbb-cccc-000000000000', tenantName: '' });
    render(<WorkingTenantNotice />);
    expect(screen.getByText(/50000000/)).toBeInTheDocument();
  });

  it('points a global-scope admin with no tenant at the header switcher', () => {
    mockState({ tenantId: '', tenantName: '', isGlobalScope: true });
    render(<WorkingTenantNotice />);
    expect(screen.getByText(/header switcher/i)).toBeInTheDocument();
  });

  it('shows a neutral prompt for a tenant-locked admin with no tenant', () => {
    mockState({ tenantId: '', tenantName: '', isGlobalScope: false });
    render(<WorkingTenantNotice />);
    expect(screen.getByText(/Impersonate a clinician to continue/i)).toBeInTheDocument();
  });
});
