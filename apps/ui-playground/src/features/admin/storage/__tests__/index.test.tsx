/**
 * StorageManagementPage — bucket-loading skeleton (TASK-331 doc-03 F9)
 *
 * Pins the rule-10 skeleton-loading contract: while the bucket list is being
 * fetched the bucket column renders `<Skeleton/>` placeholders that mirror the
 * loaded bucket-row shape — never a "Loading…" text loader.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ── auth store ──────────────────────────────────────────────────────
const authState = { user: { roles: [] as string[] }, tenantId: 't1', tenantName: 'Tenant One' };
vi.mock('@/store/auth-store', () => ({
    useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

// ── api hooks ───────────────────────────────────────────────────────
let bucketsLoading = true;
const refetch = vi.fn();
vi.mock('../../api/tenant-storage', () => ({
    useTenantBuckets: () => ({ data: [], isLoading: bucketsLoading, refetch }),
    useTenantBucketTree: () => ({ data: undefined, refetch }),
    useTenantBucketObjects: () => ({ data: [], isLoading: false, refetch }),
    useCreateTenantBucket: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteTenantBucket: () => ({ mutate: vi.fn(), isPending: false }),
    useCreateTenantFolder: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
    useUploadTenantObject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../../api/tenants', () => ({
    useTenantsInfinite: () => ({
        data: undefined,
        isLoading: false,
        hasNextPage: false,
        fetchNextPage: vi.fn(),
        isFetchingNextPage: false,
        refetch,
    }),
}));

// ── feature components ──────────────────────────────────────────────
vi.mock('../../components', () => ({
    AdminDataTable: () => <div data-testid="admin-data-table" />,
    ConfirmDialog: () => null,
    StatusBadge: () => <span />,
}));
vi.mock('../../components/folder-tree-view', () => ({ FolderTreeView: () => <div data-testid="folder-tree" /> }));
vi.mock('../object-actions', () => ({ ObjectActions: () => <div /> }));
vi.mock('../provider-config-panel', () => ({ ProviderConfigPanel: () => <div /> }));
vi.mock('../access-keys-panel', () => ({ AccessKeysPanel: () => <div /> }));

// ── @arcaai/ui stubs (vitest stubs the real package subpaths to {}) ──
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (props: any) => <div data-testid="skeleton" {...props} /> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({ Button: ({ children, onClick }: any) => <button onClick={onClick}>{children}</button> }));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/separator', () => ({ Separator: () => <hr /> }));
vi.mock('@arcaai/ui/select', () => ({
    Select: ({ children }: any) => <div>{children}</div>,
    SelectTrigger: ({ children }: any) => <div>{children}</div>,
    SelectValue: () => null,
    SelectContent: ({ children }: any) => <div>{children}</div>,
    SelectItem: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/dialog', () => ({
    Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
    DialogContent: ({ children }: any) => <div>{children}</div>,
    DialogDescription: ({ children }: any) => <div>{children}</div>,
    DialogFooter: ({ children }: any) => <div>{children}</div>,
    DialogHeader: ({ children }: any) => <div>{children}</div>,
    DialogTitle: ({ children }: any) => <div>{children}</div>,
}));
// MultiColumnLayout drives each content column's renderContent(), where the
// bucket-loading skeleton lives.
vi.mock('@arcaai/ui/multi-column-layout', () => ({
    MultiColumnLayout: ({ columns }: any) => (
        <div>
            {columns.map((col: any, i: number) => (
                <div key={col.id ?? i}>{typeof col.renderContent === 'function' ? col.renderContent() : null}</div>
            ))}
        </div>
    ),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { default: StorageManagementPage } = await import('../index');

describe('StorageManagementPage — bucket loading (TASK-331 doc-03 F9)', () => {
    beforeEach(() => {
        bucketsLoading = true;
        vi.clearAllMocks();
    });

    it('renders skeleton placeholders (not a text loader) while buckets load', () => {
        render(<StorageManagementPage scopedTenantId="t1" embedded />);

        expect(screen.getAllByTestId('bucket-skeleton').length).toBeGreaterThan(0);
        expect(screen.queryByText(/loading buckets/i)).toBeNull();
    });

    it('stops rendering the bucket skeletons once loading completes', () => {
        bucketsLoading = false;
        render(<StorageManagementPage scopedTenantId="t1" embedded />);

        expect(screen.queryAllByTestId('bucket-skeleton').length).toBe(0);
    });
});
