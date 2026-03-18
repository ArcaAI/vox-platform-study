/**
 * ConfigurationManagementPage Tests (TASK-244)
 *
 * Covers:
 * 1. Role-based access: SUPER_ADMIN/GLOBAL_ADMIN see tenant picker; TENANT_ADMIN sees own tenant only
 * 2. Config listing, searching, and filtering
 * 3. Config editing: type-aware editor (boolean select, JSON textarea, string input)
 * 4. Save flow with dirty state detection
 * 5. Reset / cancel behavior
 */

import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// ── UI mocks ────────────────────────────────────────────────────────

vi.mock('@arcaai/ui/badge', () => ({
    Badge: ({ children, variant, ...props }: any) => (
        <span data-testid="badge" data-variant={variant} {...props}>{children}</span>
    ),
}));

vi.mock('@arcaai/ui/button', () => ({
    Button: ({ children, onClick, disabled, variant, ...props }: any) => (
        <button onClick={onClick} disabled={disabled} data-variant={variant} {...props}>
            {children}
        </button>
    ),
}));

vi.mock('@arcaai/ui/input', () => ({
    Input: ({ value, onChange, placeholder, ...props }: any) => (
        <input value={value} onChange={onChange} placeholder={placeholder} {...props} />
    ),
}));

vi.mock('@arcaai/ui/multi-column-layout', () => ({
    MultiColumnLayout: ({ columns, columnStates }: any) => {
        return (
            <div data-testid="multi-column-layout">
                {columns.map((col: any, idx: number) => {
                    const state = columnStates[idx];
                    const isContentCol = col.type === 'content';
                    return (
                        <div key={col.id} data-testid={`column-${col.id}`}>
                            <h4 data-testid="column-title">{col.title}</h4>
                            {col.headerControls}
                            {isContentCol ? (
                                <div data-testid="content-panel">
                                    {col.renderContent?.()}
                                </div>
                            ) : (
                                <div data-testid="item-list">
                                    {state?.data?.map((item: any) => {
                                        const key = col.keyExtractor(item);
                                        return (
                                            <div
                                                key={key}
                                                data-testid={`item-${key}`}
                                                role="button"
                                                onClick={() => state.onSelect?.(key)}
                                            >
                                                {col.renderItem(item)}
                                            </div>
                                        );
                                    })}
                                    {(!state?.data || state.data.length === 0) && !state?.isLoading && (
                                        <p data-testid="empty">{col.emptyTitle}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    },
}));

vi.mock('@/components/layout/main', () => ({
    Main: ({ children }: any) => <main>{children}</main>,
}));

// ── Store mocks ─────────────────────────────────────────────────────

let mockRoles: string[] = ['SUPER_ADMIN'];
let mockTenantId = 'tenant-001';
let mockTenantName = 'Test Tenant';

vi.mock('@/store/auth-store', () => ({
    useAuthStore: (selector: any) =>
        selector({
            user: { roles: mockRoles },
            tenantId: mockTenantId,
            tenantName: mockTenantName,
        }),
}));

// ── API mocks ───────────────────────────────────────────────────────

const mockTenants = [
    { id: 'tenant-001', name: 'Test Tenant', key: 'test-tenant', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' },
    { id: 'tenant-002', name: 'Other Tenant', key: 'other-tenant', resourceStatus: 'ENABLED', createdAt: '', updatedAt: '' },
];

const mockConfigs = [
    { id: 'cfg-1', name: 'STT Provider', key: 'stt-provider', value: 'local', dataType: 'STRING', namespace: 'stt' },
    { id: 'cfg-2', name: 'Noise Suppression', key: 'noise-suppression', value: 'true', dataType: 'BOOLEAN', namespace: 'audio' },
    { id: 'cfg-3', name: 'Pipeline Config', key: 'pipeline-config', value: '{"chunkSize": 4096}', dataType: 'JSON', namespace: 'pipeline' },
];

const mockMutateTenantConfigs = vi.fn();
const mockMutateMyConfigs = vi.fn();

vi.mock('../../api/tenants', () => ({
    useTenantsInfinite: () => ({
        data: { pages: [{ data: mockTenants, count: mockTenants.length }] },
        isLoading: false,
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        isFetchingNextPage: false,
    }),
    useTenantConfigs: () => ({
        data: { data: mockConfigs, count: mockConfigs.length },
        isLoading: false,
    }),
    useMyTenantConfigs: () => ({
        data: { data: mockConfigs, count: mockConfigs.length },
        isLoading: false,
    }),
    useUpdateTenantConfigs: () => ({
        mutate: mockMutateTenantConfigs,
        isPending: false,
    }),
    useUpdateMyTenantConfigs: () => ({
        mutate: mockMutateMyConfigs,
        isPending: false,
    }),
}));

// ── Import component under test ─────────────────────────────────────

import ConfigurationManagementPage from '../index';

// ── Helpers ─────────────────────────────────────────────────────────

function renderPage() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={qc}>
            <ConfigurationManagementPage />
        </QueryClientProvider>,
    );
}

// ── Tests ───────────────────────────────────────────────────────────

describe('ConfigurationManagementPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRoles = ['SUPER_ADMIN'];
        mockTenantId = 'tenant-001';
        mockTenantName = 'Test Tenant';
    });

    describe('page header', () => {
        it('should render the page title', () => {
            renderPage();
            expect(screen.getByText('Configuration Management')).toBeInTheDocument();
        });

        it('should render the page description', () => {
            renderPage();
            expect(
                screen.getByText('Manage tenant settings with type-aware editing and API-backed persistence.'),
            ).toBeInTheDocument();
        });
    });

    describe('role-based access', () => {
        it('SUPER_ADMIN should see the tenant picker column', () => {
            mockRoles = ['SUPER_ADMIN'];
            renderPage();

            const tenantColumn = screen.getByTestId('column-config-tenants');
            expect(tenantColumn).toBeInTheDocument();
            expect(within(tenantColumn).getByText('Tenants')).toBeInTheDocument();
        });

        it('GLOBAL_ADMIN should see the tenant picker column', () => {
            mockRoles = ['GLOBAL_ADMIN'];
            renderPage();

            const tenantColumn = screen.getByTestId('column-config-tenants');
            expect(tenantColumn).toBeInTheDocument();
        });

        it('TENANT_ADMIN should see only own tenant in picker', () => {
            mockRoles = ['TENANT_ADMIN'];
            mockTenantId = 'tenant-001';
            mockTenantName = 'Test Tenant';
            renderPage();

            const tenantColumn = screen.getByTestId('column-config-tenants');
            const items = within(tenantColumn).getByTestId('item-list');
            expect(within(items).getByText('Test Tenant')).toBeInTheDocument();
        });
    });

    describe('configuration listing', () => {
        it('should display configurations in the second column', () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            expect(within(configColumn).getByText('Configurations')).toBeInTheDocument();
        });

        it('should list config items with name and key', () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            expect(within(configColumn).getByText('STT Provider')).toBeInTheDocument();
            expect(within(configColumn).getByText('stt-provider')).toBeInTheDocument();
            expect(within(configColumn).getByText('Noise Suppression')).toBeInTheDocument();
        });

        it('should show dataType badge for each config', () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            const badges = within(configColumn).getAllByTestId('badge');
            const badgeTexts = badges.map((b) => b.textContent);
            expect(badgeTexts).toContain('STRING');
            expect(badgeTexts).toContain('BOOLEAN');
            expect(badgeTexts).toContain('JSON');
        });
    });

    describe('configuration detail panel', () => {
        it('should show empty state when no config is selected', () => {
            renderPage();

            const detailColumn = screen.getByTestId('column-config-detail');
            expect(
                within(detailColumn).getByText('Select a configuration to view and edit its value.'),
            ).toBeInTheDocument();
        });

        it('should show config details when a config is clicked', async () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            const sttItem = within(configColumn).getByTestId('item-cfg-1');
            fireEvent.click(sttItem);

            await waitFor(() => {
                const detailColumn = screen.getByTestId('column-config-detail');
                expect(within(detailColumn).getByText('STT Provider')).toBeInTheDocument();
                expect(within(detailColumn).getByText('stt-provider')).toBeInTheDocument();
            });
        });
    });

    describe('type-aware editing', () => {
        it('should render <select> for BOOLEAN config', async () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            fireEvent.click(within(configColumn).getByTestId('item-cfg-2'));

            await waitFor(() => {
                const detailColumn = screen.getByTestId('column-config-detail');
                const boolSelect = within(detailColumn).getByTitle('Boolean configuration value');
                expect(boolSelect.tagName.toLowerCase()).toBe('select');
            });
        });

        it('should render <textarea> for JSON config', async () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            fireEvent.click(within(configColumn).getByTestId('item-cfg-3'));

            await waitFor(() => {
                const detailColumn = screen.getByTestId('column-config-detail');
                const textarea = within(detailColumn).getByTitle('Configuration value editor');
                expect(textarea.tagName.toLowerCase()).toBe('textarea');
            });
        });

        it('should render <input> for STRING config', async () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            fireEvent.click(within(configColumn).getByTestId('item-cfg-1'));

            await waitFor(() => {
                const detailColumn = screen.getByTestId('column-config-detail');
                const input = within(detailColumn).getByDisplayValue('local');
                expect(input.tagName.toLowerCase()).toBe('input');
            });
        });
    });

    describe('save flow', () => {
        it('Save button should be disabled when value has not changed', async () => {
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const buttons = screen.getAllByRole('button');
                const saveBtn = buttons.find((b) => b.textContent === 'Save');
                expect(saveBtn).toBeDisabled();
            });
        });

        it('Save button should be enabled when value is dirty', async () => {
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const input = screen.getByDisplayValue('local');
                fireEvent.change(input, { target: { value: 'remote' } });
            });

            const buttons = screen.getAllByRole('button');
            const saveBtn = buttons.find((b) => b.textContent === 'Save');
            expect(saveBtn).not.toBeDisabled();
        });

        it('should call updateTenantConfigs.mutate for SUPER_ADMIN on save', async () => {
            mockRoles = ['SUPER_ADMIN'];
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const input = screen.getByDisplayValue('local');
                fireEvent.change(input, { target: { value: 'remote' } });
            });

            const saveBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Save')!;
            fireEvent.click(saveBtn);

            expect(mockMutateTenantConfigs).toHaveBeenCalledWith({
                identifier: expect.any(String),
                configs: [{ id: 'cfg-1', value: 'remote' }],
            });
        });

        it('should call updateMyTenantConfigs.mutate for TENANT_ADMIN on save', async () => {
            mockRoles = ['TENANT_ADMIN'];
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const input = screen.getByDisplayValue('local');
                fireEvent.change(input, { target: { value: 'remote' } });
            });

            const saveBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Save')!;
            fireEvent.click(saveBtn);

            expect(mockMutateMyConfigs).toHaveBeenCalledWith([
                { id: 'cfg-1', value: 'remote' },
            ]);
        });
    });

    describe('reset behavior', () => {
        it('Reset button should revert value to original', async () => {
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const input = screen.getByDisplayValue('local');
                fireEvent.change(input, { target: { value: 'changed' } });
            });

            expect(screen.getByDisplayValue('changed')).toBeInTheDocument();

            const resetBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Reset')!;
            fireEvent.click(resetBtn);

            expect(screen.getByDisplayValue('local')).toBeInTheDocument();
        });
    });

    describe('search and filter', () => {
        it('should filter tenants by search text', () => {
            renderPage();

            const tenantColumn = screen.getByTestId('column-config-tenants');
            const searchInput = within(tenantColumn).getByPlaceholderText('Search tenant...');
            fireEvent.change(searchInput, { target: { value: 'Other' } });

            const itemList = within(tenantColumn).getByTestId('item-list');
            expect(within(itemList).queryByText('Test Tenant')).not.toBeInTheDocument();
            expect(within(itemList).getByText('Other Tenant')).toBeInTheDocument();
        });

        it('should filter configs by search text', () => {
            renderPage();

            const configColumn = screen.getByTestId('column-config-items');
            const searchInput = within(configColumn).getByPlaceholderText('Search configuration...');
            fireEvent.change(searchInput, { target: { value: 'Noise' } });

            const itemList = within(configColumn).getByTestId('item-list');
            expect(within(itemList).getByText('Noise Suppression')).toBeInTheDocument();
            expect(within(itemList).queryByText('STT Provider')).not.toBeInTheDocument();
        });
    });

    describe('namespace badges', () => {
        it('should show namespace badge in detail view', async () => {
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));

            await waitFor(() => {
                const detailColumn = screen.getByTestId('column-config-detail');
                const badges = within(detailColumn).getAllByTestId('badge');
                const texts = badges.map((b) => b.textContent);
                expect(texts).toContain('stt');
            });
        });
    });
});
