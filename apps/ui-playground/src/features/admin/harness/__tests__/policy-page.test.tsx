/**
 * TASK-330 Phase 6 — Harness policy page: skeleton, tenant/global gating, and the
 * safety-weakening confirm gate. The real PolicyEditor runs; only the query layer,
 * toasts, auth store, and the shared ConfirmDialog are mocked.
 *
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  auth: { tenantId: 't1', isGlobalScope: false },
  tenant: {} as Record<string, unknown>,
  global: {} as Record<string, unknown>,
  updateTenant: vi.fn(),
  updateGlobal: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('../api/harness', () => ({
  useHarnessPolicy: () => h.tenant,
  useGlobalHarnessPolicy: () => h.global,
  useUpdateHarnessPolicy: () => ({ mutate: h.updateTenant, isPending: false }),
  useUpdateGlobalHarnessPolicy: () => ({ mutate: h.updateGlobal, isPending: false }),
}));

vi.mock('sonner', () => ({ toast: h.toast }));

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (s: { tenantId: string; isGlobalScope: () => boolean }) => unknown) =>
    selector({ tenantId: h.auth.tenantId, isGlobalScope: () => h.auth.isGlobalScope }),
}));

vi.mock('../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {
    status?: number;
  },
}));

vi.mock('../../components', () => ({
  ConfirmDialog: ({ open, title, onConfirm }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <button data-testid="confirm-ok" onClick={onConfirm}>
          confirm
        </button>
      </div>
    ) : null,
}));

vi.mock('@arcaai/ui', () => ({
  Badge: ({ children, variant: _v, ...props }: any) => <span {...props}>{children}</span>,
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Card: ({ children }: any) => <div>{children}</div>,
  CardContent: ({ children }: any) => <div>{children}</div>,
  Input: (props: any) => <input {...props} />,
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
  Separator: (props: any) => <hr {...props} />,
  Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
  Switch: ({ checked, onCheckedChange, ...props }: any) => (
    <input type="checkbox" checked={checked} onChange={(e: any) => onCheckedChange(e.target.checked)} {...props} />
  ),
  Textarea: (props: any) => <textarea {...props} />,
}));

const { default: HarnessPolicyPage } = await import('../policy');

const policy = {
  id: 'p1',
  tenantId: 't1',
  source: 'tenant' as const,
  version: 3,
  entityFaithfulnessThreshold: 0.8,
  numericDoseThreshold: 0.9,
  citationPresenceThreshold: 0.7,
  groundednessThreshold: 0.75,
  coverageThreshold: 0.6,
  safetyEnabled: true,
  phiEnabled: true,
  phiFailClosed: true,
  safetyProvider: 'lm-studio',
  safetyModel: 'granite-guardian',
  smrProvider: null,
  smrModel: null,
  maxRegen: 2,
  gateSlaSeconds: 3600,
  gateEscalationSeconds: 7200,
  toolAllowlist: null,
  createdAt: '2026-06-01T10:00:00.000Z',
  updatedAt: '2026-06-01T10:00:00.000Z',
};

const loaded = { data: policy, isLoading: false, isError: false, error: null };

function changeNumber(container: HTMLElement, id: string, value: string) {
  const input = container.querySelector(`#${id}`) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

describe('HarnessPolicyPage', () => {
  beforeEach(() => {
    h.updateTenant.mockReset();
    h.updateGlobal.mockReset();
    h.toast.success.mockReset();
    h.toast.error.mockReset();
    h.auth = { tenantId: 't1', isGlobalScope: false };
    h.tenant = { data: undefined, isLoading: true, isError: false, error: null };
    h.global = { data: undefined, isLoading: false, isError: false, error: null };
  });

  it('shows a skeleton while the tenant policy loads', () => {
    render(<HarnessPolicyPage />);
    expect(screen.getByTestId('policy-skeleton')).toBeInTheDocument();
  });

  it('renders the tenant editor and hides the global section for a tenant admin', () => {
    h.tenant = loaded;
    render(<HarnessPolicyPage />);
    expect(screen.getByTestId('tenant-policy-editor')).toBeInTheDocument();
    expect(screen.getByTestId('tenant-policy-save')).toBeDisabled();
    expect(screen.queryByTestId('global-policy-section')).not.toBeInTheDocument();
  });

  it('renders the platform global-default editor for a global-scope admin', () => {
    h.auth.isGlobalScope = true;
    h.tenant = loaded;
    h.global = { data: { ...policy, id: 'g1', source: 'system-default' as const }, isLoading: false, isError: false, error: null };
    render(<HarnessPolicyPage />);
    expect(screen.getByTestId('global-policy-section')).toBeInTheDocument();
    expect(screen.getByTestId('global-policy-editor')).toBeInTheDocument();
  });

  it('requires confirmation before lowering a safety threshold, then PATCHes with version', () => {
    h.tenant = loaded;
    const { container } = render(<HarnessPolicyPage />);

    changeNumber(container, 'tenant-entityFaithfulnessThreshold', '0.5');
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('tenant-policy-save'));
    expect(screen.getByTestId('confirm-dialog')).toHaveTextContent('Weaken clinical safety guardrails?');
    expect(h.updateTenant).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-ok'));
    expect(h.updateTenant).toHaveBeenCalledWith(
      { body: { entityFaithfulnessThreshold: 0.5 }, version: 3, tenantId: 't1' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('saves a non-weakening change directly without a confirm dialog', () => {
    h.tenant = loaded;
    const { container } = render(<HarnessPolicyPage />);

    // Raising a threshold strengthens guardrails -> no confirmation required.
    changeNumber(container, 'tenant-entityFaithfulnessThreshold', '0.9');
    fireEvent.click(screen.getByTestId('tenant-policy-save'));

    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
    expect(h.updateTenant).toHaveBeenCalledWith(
      { body: { entityFaithfulnessThreshold: 0.9 }, version: 3, tenantId: 't1' },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });
});
