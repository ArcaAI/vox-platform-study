import { render, screen } from '@testing-library/react';

import { ImpersonationGuard } from '../impersonation-guard';
import { useDoctorContext } from '@/features/summarization/hooks/use-doctor-context';

vi.mock('@/features/summarization/hooks/use-doctor-context', () => ({
  useDoctorContext: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardDescription: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardHeader: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  CardTitle: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, ...props }: any) => <button {...props}>{children}</button> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...props }: any) => <span {...props}>{children}</span> }));

const mockUseDoctorContext = vi.mocked(useDoctorContext);

const baseCtx = {
  effectiveUserId: '',
  isImpersonated: false,
  requiresImpersonation: false,
  isAdmin: false,
  isDoctor: false,
  primaryDepartmentId: undefined,
  roles: [] as string[],
};

describe('ImpersonationGuard', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders children when impersonation is NOT required', () => {
    mockUseDoctorContext.mockReturnValue({ ...baseCtx, requiresImpersonation: false });

    render(
      <ImpersonationGuard>
        <div data-testid="protected">DNA content</div>
      </ImpersonationGuard>,
    );

    expect(screen.getByTestId('protected')).toBeInTheDocument();
  });

  it('blocks children and shows the gate when impersonation IS required', () => {
    mockUseDoctorContext.mockReturnValue({ ...baseCtx, requiresImpersonation: true, isAdmin: true, roles: ['TENANT_ADMIN'] });

    render(
      <ImpersonationGuard featureName="DNA writing style">
        <div data-testid="protected">DNA content</div>
      </ImpersonationGuard>,
    );

    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
    expect(screen.getByText(/Impersonation Required/i)).toBeInTheDocument();
    expect(screen.getByText(/Go to User Impersonation/i)).toBeInTheDocument();
  });
});
