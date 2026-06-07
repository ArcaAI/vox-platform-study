import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import type { TenantConfig } from '../../api/tenants';

// ---------------------------------------------------------------------------
// Mock @arcaai/ui components (Radix Select → a testable native <select>)
// ---------------------------------------------------------------------------

vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...props }: any) => <span data-testid="badge" {...props}>{children}</span>,
}));

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

vi.mock('@arcaai/ui/input', () => ({
  Input: (props: any) => <input {...props} />,
}));

vi.mock('@arcaai/ui/label', () => ({
  Label: ({ children, ...props }: any) => <label {...props}>{children}</label>,
}));

vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (props: any) => <div data-testid="skeleton" {...props} />,
}));

vi.mock('@arcaai/ui/select', () => ({
  Select: ({ value, onValueChange, disabled, children }: any) => (
    <select data-testid="select" value={value} disabled={disabled} onChange={(e: any) => onValueChange(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ value, disabled, children }: any) => (
    <option value={value} disabled={disabled}>
      {children}
    </option>
  ),
}));

// ---------------------------------------------------------------------------
// Mock admin-client (minimal AdminApiError for instanceof checks)
// ---------------------------------------------------------------------------

vi.mock('../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {
    status: number;
    body?: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = 'AdminApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock data hooks
// ---------------------------------------------------------------------------

const mockUseGuardrailProviders = vi.fn();
vi.mock('../../api/guardrail', () => ({
  useGuardrailProviders: () => mockUseGuardrailProviders(),
}));

const mockMutateTenantConfigs = vi.fn();
const mockMutateMyTenantConfigs = vi.fn();
vi.mock('../../api/tenants', () => ({
  useUpdateTenantConfigs: () => ({ mutateAsync: mockMutateTenantConfigs, isPending: false }),
  useUpdateMyTenantConfigs: () => ({ mutateAsync: mockMutateMyTenantConfigs, isPending: false }),
}));

import { GuardrailConfigSection } from '../guardrail-section';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROVIDERS = [
  {
    name: 'lm-studio',
    models: [
      { name: 'granite-guardian-4.1-8b', size: '4.9 GB' },
      { name: 'ibm-granite/granite-guardian-3.2-5b', size: '3.1 GB' },
    ],
    is_available: true,
    is_default: true,
    default_model: 'granite-guardian-4.1-8b',
  },
  {
    name: 'ollama',
    models: [{ name: 'granite3-guardian:8b', size: '4.9 GB' }],
    is_available: true,
    default_model: 'granite3-guardian:8b',
  },
  { name: 'azure-openai', models: [{ name: 'gpt-4o-mini', size: '' }], is_available: true },
];

function guardrailConfigs(): TenantConfig[] {
  return [
    { id: 'g-provider', key: 'default-guardrail-provider', name: 'Default Guardrail Provider', value: 'lm-studio', dataType: 'String', namespace: 'guardrail', version: 3 },
    { id: 'g-model', key: 'default-guardrail-model', name: 'Default Guardrail Model', value: 'granite-guardian-4.1-8b', dataType: 'String', namespace: 'guardrail', version: 4 },
    { id: 'g-azure', key: 'guardrail-azure-deployment', name: 'Guardrail Azure Deployment', value: '', dataType: 'String', namespace: 'guardrail', version: 2 },
  ];
}

function renderSection(props?: Partial<Parameters<typeof GuardrailConfigSection>[0]>) {
  return render(
    createElement(GuardrailConfigSection, {
      configs: guardrailConfigs(),
      isSuperAdmin: true,
      effectiveTenantIdentifier: 'tenant-xyz',
      ...props,
    }),
  );
}

describe('GuardrailConfigSection (TASK-338)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseGuardrailProviders.mockReturnValue({ data: PROVIDERS, isLoading: false });
    mockMutateTenantConfigs.mockResolvedValue({});
    mockMutateMyTenantConfigs.mockResolvedValue({});
  });

  it('renders nothing when no guardrail config rows are present', () => {
    const { container } = render(
      createElement(GuardrailConfigSection, {
        configs: [{ id: 'x', key: 'default-language', name: 'Lang', value: 'en', version: 1 } as TenantConfig],
        isSuperAdmin: true,
        effectiveTenantIdentifier: 'tenant-xyz',
      }),
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the provider, model, and azure-deployment controls', () => {
    renderSection();
    expect(screen.getByText('Guardrail Engine')).toBeInTheDocument();
    expect(screen.getByLabelText('Azure Deployment Name')).toBeInTheDocument();
    expect(screen.getAllByTestId('select')).toHaveLength(2);
  });

  it('shows a loading skeleton while providers are loading', () => {
    mockUseGuardrailProviders.mockReturnValue({ data: undefined, isLoading: true });
    renderSection();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('disables provider/model selects for non-super-admins (locked settings)', () => {
    renderSection({ isSuperAdmin: false });
    const selects = screen.getAllByTestId('select') as HTMLSelectElement[];
    expect(selects[0]).toBeDisabled();
    expect(selects[1]).toBeDisabled();
    expect(screen.getByText(/only SUPER_ADMIN users may change them/i)).toBeInTheDocument();
  });

  it('keeps the azure-deployment field editable for non-super-admins', () => {
    renderSection({ isSuperAdmin: false });
    const azure = screen.getByLabelText('Azure Deployment Name') as HTMLInputElement;
    expect(azure).not.toBeDisabled();
  });

  it('Save is disabled until a value changes', () => {
    renderSection();
    expect(screen.getByRole('button', { name: /save guardrail settings/i })).toBeDisabled();
  });

  it('persists the azure deployment via the admin PATCH with its OCC version', async () => {
    renderSection();
    const azure = screen.getByLabelText('Azure Deployment Name');
    fireEvent.change(azure, { target: { value: 'my-deployment' } });

    fireEvent.click(screen.getByRole('button', { name: /save guardrail settings/i }));

    await waitFor(() => expect(mockMutateTenantConfigs).toHaveBeenCalledTimes(1));
    expect(mockMutateTenantConfigs).toHaveBeenCalledWith({
      identifier: 'tenant-xyz',
      configs: [{ id: 'g-azure', value: 'my-deployment', expectedVersion: 2 }],
      ifMatch: '"2"',
    });
  });

  it('persists provider + model when the provider changes (each with its own version)', async () => {
    renderSection();
    const selects = screen.getAllByTestId('select') as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: 'ollama' } });

    fireEvent.click(screen.getByRole('button', { name: /save guardrail settings/i }));

    await waitFor(() => expect(mockMutateTenantConfigs).toHaveBeenCalledTimes(2));
    expect(mockMutateTenantConfigs).toHaveBeenCalledWith({
      identifier: 'tenant-xyz',
      configs: [{ id: 'g-provider', value: 'ollama', expectedVersion: 3 }],
      ifMatch: '"3"',
    });
    // Changing provider resets the model to the new provider's default.
    expect(mockMutateTenantConfigs).toHaveBeenCalledWith({
      identifier: 'tenant-xyz',
      configs: [{ id: 'g-model', value: 'granite3-guardian:8b', expectedVersion: 4 }],
      ifMatch: '"4"',
    });
  });

  it('uses the my-tenant PATCH for non-super-admins editing azure', async () => {
    renderSection({ isSuperAdmin: false });
    const azure = screen.getByLabelText('Azure Deployment Name');
    fireEvent.change(azure, { target: { value: 'tenant-dep' } });

    fireEvent.click(screen.getByRole('button', { name: /save guardrail settings/i }));

    await waitFor(() => expect(mockMutateMyTenantConfigs).toHaveBeenCalledTimes(1));
    expect(mockMutateMyTenantConfigs).toHaveBeenCalledWith({
      configs: [{ id: 'g-azure', value: 'tenant-dep', expectedVersion: 2 }],
      ifMatch: '"2"',
    });
    expect(mockMutateTenantConfigs).not.toHaveBeenCalled();
  });

  it('surfaces an error when the PATCH fails', async () => {
    const { AdminApiError } = await import('../../api/admin-client');
    mockMutateTenantConfigs.mockRejectedValue(new AdminApiError('locked', 403));
    renderSection();
    fireEvent.change(screen.getByLabelText('Azure Deployment Name'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /save guardrail settings/i }));

    await waitFor(() => expect(screen.getByText(/save failed \(403\)/i)).toBeInTheDocument());
  });

  it('resets edits back to the persisted values', () => {
    renderSection();
    const azure = screen.getByLabelText('Azure Deployment Name') as HTMLInputElement;
    fireEvent.change(azure, { target: { value: 'temp' } });
    expect(azure.value).toBe('temp');

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect((screen.getByLabelText('Azure Deployment Name') as HTMLInputElement).value).toBe('');
  });
});
