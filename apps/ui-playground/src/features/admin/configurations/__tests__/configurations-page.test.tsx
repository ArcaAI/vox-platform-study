/**
 * ConfigurationManagementPage Tests (TASK-244)
 *
 * Covers:
 * 1. Role-based access: SUPER_ADMIN sees the cross-tenant picker; TENANT_ADMIN sees own tenant only
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

// TASK-302 Stream D Phase D.5 — the global vitest config stubs
// `@arcaai/vox` to `export default {}`. Override here with a real
// `ConfigConflictError` class so the page's `instanceof` check works
// in tests. The class is structurally identical to the SDK's; the SDK
// version is pinned by `useGlobalSettings.optimistic-locking.test.ts`.
vi.mock('@arcaai/vox', () => {
    class ConfigConflictError extends Error {
        readonly code = 'CONFIG_CONFLICT';
        constructor(
            public readonly settingId: string,
            public readonly expectedVersion: number,
            public readonly currentVersion: number,
        ) {
            super(
                `Setting ${settingId} was changed by someone else ` +
                    `(yourVersion=${expectedVersion}, currentVersion=${currentVersion}).`,
            );
            this.name = 'ConfigConflictError';
        }
    }
    return { ConfigConflictError };
});

vi.mock('@arcaai/ui/dialog', () => ({
    Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
        open ? <div role="dialog">{children}</div> : null,
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogHeader: ({ children }: any) => <div>{children}</div>,
    DialogFooter: ({ children }: any) => <div>{children}</div>,
    DialogTitle: ({ children }: any) => <h2>{children}</h2>,
    DialogDescription: ({ children }: any) => <p>{children}</p>,
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

const mockConfigs = [
    { id: 'cfg-1', name: 'STT Provider', key: 'stt-provider', value: 'local', dataType: 'STRING', namespace: 'stt', version: 1 },
    { id: 'cfg-2', name: 'Noise Suppression', key: 'noise-suppression', value: 'true', dataType: 'BOOLEAN', namespace: 'audio', version: 1 },
    { id: 'cfg-3', name: 'Pipeline Config', key: 'pipeline-config', value: '{"chunkSize": 4096}', dataType: 'JSON', namespace: 'pipeline', version: 1 },
];

const mockMutateTenantConfigs = vi.fn();
const mockMutateMyConfigs = vi.fn();

// TASK-335 — the in-page tenant picker column was removed; the working tenant
// now comes from the header ScopeSwitcher (store `tenantId`). `useTenantConfigs`
// is a spy so we can assert the config list is scoped to that header tenant.
vi.mock('../../api/tenants', () => ({
    useTenantConfigs: vi.fn(() => ({
        data: { data: mockConfigs, count: mockConfigs.length },
        isLoading: false,
    })),
    useMyTenantConfigs: () => ({
        data: { data: mockConfigs, count: mockConfigs.length },
        isLoading: false,
    }),
    useUpdateTenantConfigs: () => ({
        mutate: mockMutateTenantConfigs,
        // TASK-302 Stream D Phase D.5 — the page now `await`s the mutation
        // so it can branch on 412 conflicts. Expose `mutateAsync` as the
        // same spy so assertions on call shape still pass.
        mutateAsync: mockMutateTenantConfigs,
        isPending: false,
    }),
    useUpdateMyTenantConfigs: () => ({
        mutate: mockMutateMyConfigs,
        mutateAsync: mockMutateMyConfigs,
        isPending: false,
    }),
}));

// ── Import component under test ─────────────────────────────────────

import { useTenantConfigs } from '../../api/tenants';
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

    // TASK-335 — the redundant in-page "Tenants" column was removed. The
    // working tenant is selected exclusively via the header ScopeSwitcher
    // (store `tenantId`), so the page must NOT render a tenant picker and
    // must scope the config list to that header tenant for every role.
    describe('tenant scoping (header ScopeSwitcher)', () => {
        it('does NOT render an in-page tenant picker column', () => {
            mockRoles = ['SUPER_ADMIN'];
            renderPage();

            expect(screen.queryByTestId('column-config-tenants')).not.toBeInTheDocument();
            expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
        });

        it('renders only the configurations and detail columns', () => {
            renderPage();

            expect(screen.getByTestId('column-config-items')).toBeInTheDocument();
            expect(screen.getByTestId('column-config-detail')).toBeInTheDocument();
            expect(screen.queryByTestId('column-config-tenants')).not.toBeInTheDocument();
        });

        it('scopes configs to the header store tenantId for SUPER_ADMIN', () => {
            mockRoles = ['SUPER_ADMIN'];
            mockTenantId = 'tenant-001';
            renderPage();

            expect(vi.mocked(useTenantConfigs)).toHaveBeenCalledWith(
                'tenant-001',
                expect.any(Object),
                expect.objectContaining({ enabled: true }),
            );
        });

        it('TENANT_ADMIN also has no in-page tenant picker column', () => {
            mockRoles = ['TENANT_ADMIN'];
            renderPage();

            expect(screen.queryByTestId('column-config-tenants')).not.toBeInTheDocument();
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
                ifMatch: '"1"',
                configs: [{ id: 'cfg-1', value: 'remote', expectedVersion: 1 }],
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

            expect(mockMutateMyConfigs).toHaveBeenCalledWith({
                ifMatch: '"1"',
                configs: [{ id: 'cfg-1', value: 'remote', expectedVersion: 1 }],
            });
        });
    });

    describe('OCC conflict handling (TASK-302 Stream D Phase D.5)', () => {
        // The page wraps the save in try/catch and converts the
        // server's `412 Precondition Failed` into a
        // `ConfigConflictError`, which mounts the conflict modal.
        // These tests pin that conversion + modal-mount contract
        // end-to-end (mutation -> AdminApiError -> modal in DOM).
        it('shows the conflict modal when the server returns 412', async () => {
            const { AdminApiError } = await import('../../api/admin-client');
            mockMutateTenantConfigs.mockRejectedValueOnce(
                new AdminApiError('Resource changed', 412, {
                    code: 'OCC_CONFLICT',
                    message: 'Resource changed',
                    metadata: { expectedVersion: 1, currentVersion: 4 },
                }),
            );
            renderPage();

            fireEvent.click(screen.getByTestId('item-cfg-1'));
            await waitFor(() => {
                const input = screen.getByDisplayValue('local');
                fireEvent.change(input, { target: { value: 'remote' } });
            });

            const saveBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Save')!;
            fireEvent.click(saveBtn);

            await waitFor(() => {
                expect(screen.getByRole('dialog')).toBeInTheDocument();
                expect(screen.getByText(/changed by someone else/i)).toBeInTheDocument();
            });

            // The modal copy must surface the server's `currentVersion`
            // (4), not the client's stale snapshot (1). Otherwise the
            // admin learns nothing actionable.
            const desc = screen.getByText(/version 1/i);
            expect(desc.textContent).toMatch(/version is 4/i);
        });

        it('does NOT show the conflict modal for non-412 errors (rethrows)', async () => {
            // Validation / 5xx errors must NOT route through the OCC
            // modal — they have their own UX (toast / boundary). This
            // test pins the discriminator: only 412 → modal.
            const { AdminApiError } = await import('../../api/admin-client');
            mockMutateTenantConfigs.mockRejectedValueOnce(
                new AdminApiError('Invalid body', 400, { code: 'VALIDATION_ERROR' }),
            );
            // Silence the rethrow — react's unhandled-rejection
            // listener would otherwise log noise into the test output.
            const onUnhandled = vi.fn();
            window.addEventListener('unhandledrejection', onUnhandled);
            try {
                renderPage();
                fireEvent.click(screen.getByTestId('item-cfg-1'));
                await waitFor(() => {
                    const input = screen.getByDisplayValue('local');
                    fireEvent.change(input, { target: { value: 'remote' } });
                });
                const saveBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Save')!;
                fireEvent.click(saveBtn);

                // Give the rejected mutation time to settle.
                await new Promise((r) => setTimeout(r, 50));

                expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
            } finally {
                window.removeEventListener('unhandledrejection', onUnhandled);
            }
        });

        it('refuses to save a row that has no version (defensive)', async () => {
            // Without a version, the page cannot build the CAS body or
            // the `If-Match` header — surface a draft error rather
            // than send a malformed PATCH that the server would reject
            // ambiguously.
            const originalConfigs = mockConfigs.slice();
            // Mutate in place so the existing API mock returns the
            // versionless row; restore after the test.
            (mockConfigs[0] as any).version = undefined;
            try {
                renderPage();
                fireEvent.click(screen.getByTestId('item-cfg-1'));
                await waitFor(() => {
                    const input = screen.getByDisplayValue('local');
                    fireEvent.change(input, { target: { value: 'remote' } });
                });
                const saveBtn = screen.getAllByRole('button').find((b) => b.textContent === 'Save')!;
                fireEvent.click(saveBtn);

                expect(mockMutateTenantConfigs).not.toHaveBeenCalled();
                expect(mockMutateMyConfigs).not.toHaveBeenCalled();
                expect(screen.getByText(/missing a version/i)).toBeInTheDocument();
            } finally {
                // Restore so subsequent tests aren't affected.
                mockConfigs.splice(0, mockConfigs.length, ...originalConfigs);
                (mockConfigs[0] as any).version = 1;
            }
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
