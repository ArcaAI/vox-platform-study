/**
 * TASK-331 doc-02 F4 — "Activate this version" affordance.
 *
 * The version detail view surfaces an Activate button for any NON-current
 * version (compared to the template's `currentVersionNumber`). Clicking it
 * fires the activate mutation handler; the already-active version hides it.
 *
 * `InlinePromptVersionDetail` is exported from the page module and rendered in
 * isolation. The form/select primitives are stubbed so the edit form mounts
 * without Radix portals; the page's heavy sibling imports are stubbed so the
 * module loads under jsdom.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// ── page-module sibling imports (loaded when ../index is imported) ──
vi.mock('@/store/auth-store', () => ({ useAuthStore: (s: any) => s({ tenantId: '', isGlobalScope: () => true, setTenant: vi.fn() }) }));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/version-diff-panel', () => ({ VersionDiffPanel: () => <div /> }));
vi.mock('./prompt-test-panel', () => ({ PromptTestPanel: () => <div /> }));
vi.mock('../prompt-test-panel', () => ({ PromptTestPanel: () => <div /> }));
vi.mock('./prompt-usage-analytics-panel', () => ({ PromptUsageAnalyticsPanel: () => <div /> }));
vi.mock('../prompt-usage-analytics-panel', () => ({ PromptUsageAnalyticsPanel: () => <div /> }));
vi.mock('../components', () => ({ ConfirmDialog: () => null, StatusBadge: ({ status }: any) => <span>{status}</span> }));
vi.mock('../../components', () => ({ ConfirmDialog: () => null, StatusBadge: ({ status }: any) => <span>{status}</span> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@arcaai/ui/multi-column-layout', () => ({ MultiColumnLayout: () => <div /> }));

vi.mock('../api/tenants', () => ({ useTenantsInfinite: () => ({ data: undefined, hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false, isRefetching: false, refetch: vi.fn() }) }));
vi.mock('../api/prompts', () => ({
  useActivatePromptVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useCreatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  useDeletePrompt: () => ({ mutate: vi.fn(), isPending: false }),
  usePromptTemplate: () => ({ data: undefined, isLoading: false }),
  usePromptTemplatesInfinite: () => ({ data: undefined, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn(), isFetchingNextPage: false, isRefetching: false, refetch: vi.fn() }),
  usePromptUsageStats: () => ({ data: undefined, isLoading: false }),
  usePromptVersions: () => ({ data: [], isLoading: false, isRefetching: false, refetch: vi.fn() }),
  useRefreshPromptDetails: () => vi.fn(),
  useTogglePromptStatus: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdatePrompt: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ── form/select primitive stubs (avoid Radix portals + FormProvider) ──
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/input', () => ({ Input: () => <input /> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: () => <textarea /> }));
vi.mock('@arcaai/ui/separator', () => ({ Separator: () => <hr /> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
}));
vi.mock('@arcaai/ui/form', () => ({
  Form: ({ children }: any) => <div>{children}</div>,
  FormField: ({ render, name, control }: any) =>
    render({ field: { value: '', onChange: vi.fn(), onBlur: vi.fn(), name, ref: vi.fn(), control } }),
  FormItem: ({ children }: any) => <div>{children}</div>,
  FormLabel: ({ children }: any) => <label>{children}</label>,
  FormControl: ({ children }: any) => <div>{children}</div>,
  FormMessage: () => <div />,
}));

const { InlinePromptVersionDetail } = await import('../index');

const prompt: any = {
  id: 'tpl-1',
  name: 'Greeting',
  category: 'CUSTOM',
  status: 'DRAFT',
  content: 'Hello',
  currentVersionNumber: 3,
  version: 5,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const makeVersion = (versionNumber: number): any => ({
  id: `v-${versionNumber}`,
  promptTemplateId: 'tpl-1',
  versionNumber,
  content: 'Hello',
  variables: [],
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('InlinePromptVersionDetail — activate version (TASK-331 doc-02 F4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fires onActivate with the version number for a non-current version', () => {
    const onActivate = vi.fn();
    render(
      <InlinePromptVersionDetail
        prompt={prompt}
        version={makeVersion(2)} // current is 3 → version 2 is NOT active
        isPending={false}
        onSubmit={vi.fn()}
        onActivate={onActivate}
        isActivating={false}
      />,
    );

    const btn = screen.getByRole('button', { name: /activate this version/i });
    fireEvent.click(btn);

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith(2);
  });

  it('does not render the Activate button on the already-active version', () => {
    const onActivate = vi.fn();
    render(
      <InlinePromptVersionDetail
        prompt={prompt}
        version={makeVersion(3)} // equals currentVersionNumber → active
        isPending={false}
        onSubmit={vi.fn()}
        onActivate={onActivate}
        isActivating={false}
      />,
    );

    expect(screen.queryByRole('button', { name: /activate this version/i })).not.toBeInTheDocument();
  });
});
