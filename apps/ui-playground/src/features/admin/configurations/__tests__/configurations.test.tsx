import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { TenantConfig } from '../../api/tenants';

// ---------------------------------------------------------------------------
// Mock @arcaai/ui components
// ---------------------------------------------------------------------------

vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...props }: any) => (
    <span data-testid="badge" {...props}>{children}</span>
  ),
}));

vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('@arcaai/ui/input', () => ({
  Input: (props: any) => <input data-testid="input" {...props} />,
}));

vi.mock('@arcaai/ui/multi-column-layout', () => ({
  MultiColumnLayout: ({
    columns,
    columnStates,
  }: {
    columns: any[];
    columnStates: any[];
  }) => {
    const renderItemFns = columns.map((c: any) => c.renderItem).filter(Boolean);
    const renderContentFn = columns.find((c: any) => c.renderContent)?.renderContent ?? null;
    const onSelectFns = columnStates.map((s: any) => s.onSelect);
    const columnData = columnStates.map((s: any) => s.data ?? []);
    const columnLoadingStates = columnStates.map((s: any) => s.isLoading);

    return createElement('div', { 'data-testid': 'multi-column-layout' },
      columnLoadingStates.some(Boolean)
        ? createElement('div', { 'data-testid': 'loading-indicator' }, 'Loading...')
        : null,
      createElement('div', { 'data-testid': 'column-tenants' },
        ...(columnData[0] ?? []).map((item: any) =>
          createElement('div', {
            key: item.id,
            'data-testid': `tenant-item-${item.id}`,
            onClick: () => onSelectFns[0]?.(item.id),
          }, renderItemFns[0]?.(item)),
        ),
      ),
      createElement('div', { 'data-testid': 'column-configs' },
        ...(columnData[1] ?? []).map((item: any) =>
          createElement('div', {
            key: item.id,
            'data-testid': `config-item-${item.id}`,
            onClick: () => onSelectFns[1]?.(item.id),
          }, renderItemFns[1]?.(item)),
        ),
      ),
      renderContentFn
        ? createElement('div', { 'data-testid': 'column-detail' }, renderContentFn())
        : null,
    );
  },
}));

// ---------------------------------------------------------------------------
// Mock data & helpers
// ---------------------------------------------------------------------------

const TENANT_ID = 't-abc-123';
const TENANT_NAME = 'Test Clinic';

function makeTenantConfig(overrides?: Partial<TenantConfig>): TenantConfig {
  return {
    id: 'cfg-001',
    name: 'Default Language',
    key: 'default-language',
    value: 'en',
    dataType: 'String',
    namespace: 'general',
    tenantId: TENANT_ID,
    tenantCode: 'TEST',
    // TASK-302 Stream D Phase D.5 — every config must carry a version so
    // the editor can build the CAS body + `If-Match` header. The default
    // is the first-write version (1); per-test overrides can stress the
    // conflict path.
    version: 1,
    ...overrides,
  };
}

const sampleConfigs: TenantConfig[] = [
  makeTenantConfig({ id: 'cfg-01', key: 'default-language', name: 'Default Language', value: 'en', dataType: 'String' }),
  makeTenantConfig({ id: 'cfg-02', key: 'enable-ner', name: 'Enable NER', value: 'true', dataType: 'Boolean' }),
  makeTenantConfig({ id: 'cfg-03', key: 'pipeline-config', name: 'Pipeline Config', value: '{"timeout":30}', dataType: 'JSON' }),
  makeTenantConfig({ id: 'cfg-04', key: 'max-sessions', name: 'Max Sessions', value: '10', dataType: 'Integer' }),
  makeTenantConfig({ id: 'cfg-05', key: 'locked-setting', name: 'Locked Setting', value: 'admin-only', dataType: 'String', locked: true } as any),
];

const paginatedConfigs = { data: sampleConfigs, count: sampleConfigs.length, limit: 300, page: 1 };

// ---------------------------------------------------------------------------
// Mock tenant API hooks
// ---------------------------------------------------------------------------

const mockMutateTenantConfigs = vi.fn();
const mockMutateMyTenantConfigs = vi.fn();

vi.mock('../../api/tenants', async () => {
  const actual = await vi.importActual<typeof import('../../api/tenants')>('../../api/tenants');
  return {
    ...actual,
    useTenantsInfinite: vi.fn(() => ({
      data: {
        pages: [{
          data: [{ id: TENANT_ID, name: TENANT_NAME, key: 'test-clinic', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' }],
          count: 1, limit: 25, page: 1,
        }],
      },
      isLoading: false,
      hasNextPage: false,
      fetchNextPage: vi.fn(),
      isFetchingNextPage: false,
    })),
    useTenantConfigs: vi.fn(() => ({
      data: paginatedConfigs,
      isLoading: false,
      isSuccess: true,
    })),
    useMyTenantConfigs: vi.fn(() => ({
      data: paginatedConfigs,
      isLoading: false,
      isSuccess: true,
    })),
    useUpdateTenantConfigs: vi.fn(() => ({
      mutate: mockMutateTenantConfigs,
      // TASK-302 Stream D Phase D.5 — the page now uses `mutateAsync`
      // so it can await the result and branch on 412 conflicts. Mirror
      // the mock for both APIs to preserve the legacy assertions.
      mutateAsync: mockMutateTenantConfigs,
      isPending: false,
    })),
    useUpdateMyTenantConfigs: vi.fn(() => ({
      mutate: mockMutateMyTenantConfigs,
      mutateAsync: mockMutateMyTenantConfigs,
      isPending: false,
    })),
  };
});

import {
  useTenantsInfinite,
  useTenantConfigs,
  useMyTenantConfigs,
  useUpdateTenantConfigs,
  useUpdateMyTenantConfigs,
} from '../../api/tenants';

// ---------------------------------------------------------------------------
// Mock auth store
// ---------------------------------------------------------------------------

const mockAuthState = {
  user: { id: 'u-1', email: 'admin@test.com', username: 'admin', roles: ['SUPER_ADMIN'], permissions: [] },
  tenantId: TENANT_ID,
  tenantName: TENANT_NAME,
};

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: (state: any) => any) => selector(mockAuthState),
}));

// ---------------------------------------------------------------------------
// Mock layout component
// ---------------------------------------------------------------------------

vi.mock('@/components/layout/main', () => ({
  Main: ({ children, ...props }: any) => (
    <main data-testid="main-layout" {...props}>{children}</main>
  ),
}));

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------

import ConfigurationManagementPage from '../index';

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    createElement(QueryClientProvider, { client: queryClient },
      createElement(ConfigurationManagementPage),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigurationManagementPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.user.roles = ['SUPER_ADMIN'];
  });

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------
  describe('rendering', () => {
    it('should render page title "Configuration Management"', () => {
      renderPage();
      expect(
        screen.getByRole('heading', { name: /configuration management/i }),
      ).toBeInTheDocument();
    });

    it('should render page subtitle', () => {
      renderPage();
      expect(
        screen.getByText(/manage tenant settings/i),
      ).toBeInTheDocument();
    });

    it('should render the multi-column layout', () => {
      renderPage();
      expect(screen.getByTestId('multi-column-layout')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------
  describe('loading state', () => {
    it('should display loading indicator while configs are loading', () => {
      (useTenantConfigs as ReturnType<typeof vi.fn>).mockReturnValue({
        data: undefined,
        isLoading: true,
        isSuccess: false,
      });

      renderPage();
      expect(screen.getByTestId('loading-indicator')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Config display
  // -----------------------------------------------------------------------
  describe('config display', () => {
    it('should display tenant configs in the configs column', () => {
      (useTenantConfigs as ReturnType<typeof vi.fn>).mockReturnValue({
        data: paginatedConfigs,
        isLoading: false,
        isSuccess: true,
      });

      renderPage();
      expect(screen.getByTestId('column-configs')).toBeInTheDocument();
      expect(screen.getByText('Default Language')).toBeInTheDocument();
      expect(screen.getByText('Enable NER')).toBeInTheDocument();
    });

    it('should show config key in mono font area', () => {
      renderPage();
      expect(screen.getByText('default-language')).toBeInTheDocument();
      expect(screen.getByText('enable-ner')).toBeInTheDocument();
    });

    it('should show dataType badges for configs', () => {
      renderPage();
      const badges = screen.getAllByTestId('badge');
      const badgeTexts = badges.map((b) => b.textContent);
      expect(badgeTexts).toContain('String');
      expect(badgeTexts).toContain('Boolean');
    });
  });

  // -----------------------------------------------------------------------
  // Lock indicator (TASK-244)
  // -----------------------------------------------------------------------
  describe('locked configs (TASK-244)', () => {
    it('should include locked config in the data set', () => {
      renderPage();
      expect(screen.getByTestId('config-item-cfg-05')).toBeInTheDocument();
      expect(screen.getByText('Locked Setting')).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // Config selection & editing
  // -----------------------------------------------------------------------
  describe('config editing', () => {
    it('should show detail placeholder when no config is selected', () => {
      renderPage();
      expect(
        screen.getByText(/select a configuration to view/i),
      ).toBeInTheDocument();
    });

    it('should show editor when a config is selected', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-01'));

      const detail = screen.getByTestId('column-detail');
      expect(detail).toBeInTheDocument();
      expect(detail.querySelector('.text-sm.font-semibold')).toHaveTextContent('Default Language');
    });

    it('should render select element for Boolean config', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-02'));

      const select = screen.getByLabelText(/boolean configuration value/i);
      expect(select).toBeInTheDocument();
      expect(select.tagName).toBe('SELECT');
    });

    it('should render input for String config', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-04'));

      const inputs = screen.getAllByTestId('input');
      expect(inputs.length).toBeGreaterThan(0);
    });

    it('should render textarea for JSON config', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-03'));

      const textarea = screen.getByLabelText(/configuration value editor/i);
      expect(textarea).toBeInTheDocument();
      expect(textarea.tagName).toBe('TEXTAREA');
    });

    it('should keep Save disabled when JSON is only reformatted for display', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-03'));

      const textarea = screen.getByLabelText(/configuration value editor/i) as HTMLTextAreaElement;
      expect(textarea).toHaveValue('{\n  "timeout": 30\n}');
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });

    it('should show validation error and disable Save for invalid JSON', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-03'));

      const textarea = screen.getByLabelText(/configuration value editor/i);
      fireEvent.change(textarea, { target: { value: '{"timeout":' } });

      expect(screen.getByText(/invalid json/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // Save flow — SUPER_ADMIN
  // -----------------------------------------------------------------------
  describe('save as SUPER_ADMIN', () => {
    it('should enable Save button only when value is dirty', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-01'));

      const saveBtn = screen.getByRole('button', { name: /save/i });
      expect(saveBtn).toBeDisabled();

      const input = screen.getAllByTestId('input').find(
        (el) => (el as HTMLInputElement).value === 'en',
      );
      if (input) {
        fireEvent.change(input, { target: { value: 'fr' } });
      }

      expect(screen.getByRole('button', { name: /save/i })).not.toBeDisabled();
    });

    it('should call useUpdateTenantConfigs.mutate on Save', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-01'));

      const input = screen.getAllByTestId('input').find(
        (el) => (el as HTMLInputElement).value === 'en',
      );
      if (input) {
        fireEvent.change(input, { target: { value: 'de' } });
      }

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(mockMutateTenantConfigs).toHaveBeenCalledTimes(1);
      expect(mockMutateTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({
          identifier: expect.any(String),
          // TASK-302 Stream D Phase D.5 — payload now carries the
          // server's strong validator (If-Match: "<version>") AND the
          // per-row expectedVersion for the CAS body. Both derived
          // from `selectedConfig.version`.
          ifMatch: '"1"',
          configs: expect.arrayContaining([
            expect.objectContaining({ id: 'cfg-01', value: 'de', expectedVersion: 1 }),
          ]),
        }),
      );
    });

    it('should normalize JSON string before saving', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-03'));

      const textarea = screen.getByLabelText(/configuration value editor/i);
      fireEvent.change(textarea, {
        target: {
          value: '{\n  "timeout": 45,\n  "enabled": true\n}',
        },
      });

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(mockMutateTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({
          ifMatch: '"1"',
          configs: expect.arrayContaining([
            expect.objectContaining({
              id: 'cfg-03',
              value: '{"timeout":45,"enabled":true}',
              expectedVersion: 1,
            }),
          ]),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Save flow — TENANT_ADMIN (non-super)
  // -----------------------------------------------------------------------
  describe('save as TENANT_ADMIN', () => {
    beforeEach(() => {
      mockAuthState.user.roles = ['TENANT_ADMIN'];
    });

    it('should call useUpdateMyTenantConfigs.mutate on Save', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-01'));

      const input = screen.getAllByTestId('input').find(
        (el) => (el as HTMLInputElement).value === 'en',
      );
      if (input) {
        fireEvent.change(input, { target: { value: 'ja' } });
      }

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(mockMutateMyTenantConfigs).toHaveBeenCalledTimes(1);
      expect(mockMutateMyTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({
          ifMatch: '"1"',
          configs: expect.arrayContaining([
            expect.objectContaining({ id: 'cfg-01', value: 'ja', expectedVersion: 1 }),
          ]),
        }),
      );
      expect(mockMutateTenantConfigs).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    it('should restore original value when Reset is clicked', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-01'));

      const input = screen.getAllByTestId('input').find(
        (el) => (el as HTMLInputElement).value === 'en',
      );
      if (input) {
        fireEvent.change(input, { target: { value: 'changed' } });
      }

      fireEvent.click(screen.getByRole('button', { name: /reset/i }));

      const saveBtn = screen.getByRole('button', { name: /save/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // Boolean config save
  // -----------------------------------------------------------------------
  describe('boolean config save', () => {
    it('should save toggled Boolean value via select change', () => {
      renderPage();
      fireEvent.click(screen.getByTestId('config-item-cfg-02'));

      const select = screen.getByLabelText(/boolean configuration value/i) as HTMLSelectElement;
      expect(select.value).toBe('true');

      fireEvent.change(select, { target: { value: 'false' } });
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      expect(mockMutateTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({
          ifMatch: '"1"',
          configs: expect.arrayContaining([
            expect.objectContaining({ id: 'cfg-02', value: 'false', expectedVersion: 1 }),
          ]),
        }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Role-based behavior
  // -----------------------------------------------------------------------
  describe('role-based behavior', () => {
    it('should enable infinite tenant list for SUPER_ADMIN', () => {
      mockAuthState.user.roles = ['SUPER_ADMIN'];
      renderPage();
      expect(useTenantsInfinite).toHaveBeenCalledWith(25, { enabled: true });
    });

    it('should disable infinite tenant list for non-admin roles', () => {
      mockAuthState.user.roles = ['TENANT_ADMIN'];
      renderPage();
      expect(useTenantsInfinite).toHaveBeenCalledWith(25, { enabled: false });
    });

    it('should use useTenantConfigs for GLOBAL_ADMIN', () => {
      mockAuthState.user.roles = ['GLOBAL_ADMIN'];
      renderPage();
      expect(useTenantConfigs).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ enabled: true }),
      );
    });

    it('should use useMyTenantConfigs for TENANT_ADMIN', () => {
      mockAuthState.user.roles = ['TENANT_ADMIN'];
      renderPage();
      expect(useMyTenantConfigs).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
    });
  });
});
