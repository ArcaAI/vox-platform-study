/**
 * TASK-327 T6 — the overview page surfaces live backend health by mounting
 * the shared <ServiceStatusGrid/> (previously only on the Introduction page).
 *
 * Heavy children are stubbed so this verifies wiring, not their internals.
 */
import { render, screen } from '@testing-library/react';

vi.mock('@/components/layout/playground-layout', () => ({
  PlaygroundLayout: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('../components/user-list', () => ({ UserList: () => <div data-testid="user-list" /> }));
vi.mock('@/features/introduction/components/service-status-grid', () => ({
  ServiceStatusGrid: () => <div data-testid="service-status-grid" />,
}));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  CardDescription: ({ children }: any) => <div>{children}</div>,
  CardHeader: ({ children }: any) => <div>{children}</div>,
  CardTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector?: any) => {
    const state = { tenantId: 'tenant-1', user: { roles: ['GLOBAL_ADMIN'] } };
    return selector ? selector(state) : state;
  },
}));

import OverviewPage from '../index';

describe('OverviewPage service health (TASK-327 T6)', () => {
  it('mounts the ServiceStatusGrid alongside the user list', () => {
    render(<OverviewPage />);
    expect(screen.getByTestId('service-status-grid')).toBeInTheDocument();
    expect(screen.getByTestId('user-list')).toBeInTheDocument();
  });
});
