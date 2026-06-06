/**
 * CC-04 (TASK-336) — the Create Department modal must forward
 * `defaultSummaryTemplate` into the create payload.
 *
 * The modal already collects the field (schema + form input), but the page's
 * `handleCreate` previously dropped it when building the mutation payload, so a
 * template typed at create-time was silently lost. This renders the real page
 * with real react-hook-form, opens the Create dialog, types a summary template,
 * submits, and asserts the create mutation receives it.
 *
 * `@arcaai/ui/form` is stubbed, but `FormField` is wired to the REAL
 * react-hook-form `useController` (the page keeps its real `useForm`), so typed
 * values genuinely flow through to submit — a naive FormField stub that
 * hardcodes `value:''` could not drive the inputs. Heavy/unrelated UI + data
 * deps are stubbed, mirroring the sibling prompts page tests.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createSpy = vi.fn();

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector({ tenantKey: 'tenant-abc' }),
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../../components', () => ({
  ConfirmDialog: () => null,
  StatusBadge: ({ status }: any) => <span>{status}</span>,
}));

vi.mock('../../api/prompts', () => ({
  usePromptTemplates: () => ({ data: { data: [] }, isRefetching: false, refetch: vi.fn() }),
}));
vi.mock('../../api/departments', () => ({
  useCreateTenantDepartment: () => ({ mutate: createSpy, isPending: false }),
  useDeleteTenantDepartment: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateTenantDepartment: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateTenantDepartmentPromptConfig: () => ({ mutate: vi.fn(), isPending: false }),
  useRefreshTenantDepartmentDetail: () => vi.fn(),
  useTenantDepartment: () => ({ data: undefined, isLoading: false, isRefetching: false, refetch: vi.fn() }),
  useTenantDepartments: () => ({ data: [], isLoading: false, isRefetching: false, refetch: vi.fn() }),
}));

// ── heavy/Radix UI stubs (avoid portals); @arcaai/ui/form stays REAL ──
vi.mock('@arcaai/ui/multi-column-layout', () => ({
  MultiColumnLayout: ({ columns }: any) => (
    <div>{columns.map((c: any) => <div key={c.id}>{c.headerActions}</div>)}</div>
  ),
}));
vi.mock('@arcaai/ui/dialog', () => ({
  Dialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, type }: any) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (props: any) => <textarea {...props} /> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/separator', () => ({ Separator: () => <hr /> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: () => <div /> }));
vi.mock('@arcaai/ui/switch', () => ({ Switch: (props: any) => <input type="checkbox" {...props} /> }));
vi.mock('@arcaai/ui/tabs', () => ({
  Tabs: ({ children }: any) => <div>{children}</div>,
  TabsList: ({ children }: any) => <div>{children}</div>,
  TabsTrigger: ({ children }: any) => <button type="button">{children}</button>,
  TabsContent: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/tooltip', () => ({
  Tooltip: ({ children }: any) => <div>{children}</div>,
  TooltipContent: ({ children }: any) => <div>{children}</div>,
  TooltipProvider: ({ children }: any) => <div>{children}</div>,
  TooltipTrigger: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
}));

// Stub the form primitives, but back FormField with the real react-hook-form
// controller so typed values actually update the page's (real) form state.
vi.mock('@arcaai/ui/form', async () => {
  const { useController } = await vi.importActual<typeof import('react-hook-form')>('react-hook-form');
  return {
    Form: ({ children }: any) => <div>{children}</div>,
    FormField: ({ control, name, render }: any) => {
      const { field } = useController({ control, name });
      return render({ field });
    },
    FormItem: ({ children }: any) => <div>{children}</div>,
    FormLabel: ({ children }: any) => <label>{children}</label>,
    FormControl: ({ children }: any) => <>{children}</>,
    FormDescription: ({ children }: any) => <div>{children}</div>,
    FormMessage: () => <div />,
  };
});

const { default: DepartmentManagementPage } = await import('../index');

describe('DepartmentManagementPage — CC-04 create payload', () => {
  beforeEach(() => {
    createSpy.mockReset();
  });

  it('forwards the typed defaultSummaryTemplate into the create mutation payload', async () => {
    render(<DepartmentManagementPage />);

    // Open the Create dialog (the "New" button lives in the list headerActions).
    fireEvent.click(screen.getByRole('button', { name: /new/i }));

    fireEvent.change(screen.getByPlaceholderText('e.g. Cardiology'), {
      target: { value: 'Cardiology' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. SOAP'), {
      target: { value: 'SOAP discharge template' },
    });

    fireEvent.click(screen.getByRole('button', { name: /create department/i }));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      name: 'Cardiology',
      defaultSummaryTemplate: 'SOAP discharge template',
    });
  });
});
