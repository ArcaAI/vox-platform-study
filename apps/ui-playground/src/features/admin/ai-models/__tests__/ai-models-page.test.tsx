/**
 * AiModelsPage — TASK-356 Phase 1 (Catalog plane).
 *
 * Mirrors the sibling admin page tests: heavy/Radix UI deps are stubbed, but
 * `@arcaai/ui/form`'s `FormField` is backed by the REAL react-hook-form
 * controller so typed values + zod validation genuinely flow through to submit.
 *
 * @vitest-environment jsdom
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const createSpy = vi.fn();
let authState: { isGlobalScope: () => boolean; tenantId: string; tenantName: string } = {
  isGlobalScope: () => false,
  tenantId: 'tenant-1',
  tenantName: 'Acme Health',
};

vi.mock('@/store/auth-store', () => ({
  useAuthStore: (selector: any) => selector(authState),
}));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../../components', () => ({
  ConfirmDialog: () => null,
  StatusBadge: ({ status }: any) => <span>{status}</span>,
  // Lightweight table stub: renders the toolbar + a row per model name.
  AdminDataTable: ({ data, toolbar }: any) => (
    <div data-testid="admin-data-table">
      {toolbar}
      <ul>
        {data.map((m: any) => (
          <li key={m.id}>{m.name}</li>
        ))}
      </ul>
    </div>
  ),
}));

const useAiModelsMock = vi.fn();
vi.mock('../../api/ai-models', () => ({
  useAiModels: (...args: any[]) => useAiModelsMock(...args),
  useCreateAiModel: () => ({ mutateAsync: createSpy, isPending: false }),
  useUpdateAiModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAiModel: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// ── heavy/Radix UI stubs (avoid portals); @arcaai/ui/form stays REAL ──
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
  Button: ({ children, variant, size, asChild, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock('@arcaai/ui/input', () => ({ Input: (props: any) => <input {...props} /> }));
vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children }: any) => <span>{children}</span> }));
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children }: any) => <div>{children}</div>,
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: () => <span />,
}));
vi.mock('@arcaai/ui/form', async () => {
  const { useController } = await vi.importActual<typeof import('react-hook-form')>('react-hook-form');
  return {
    Form: ({ children }: any) => <div>{children}</div>,
    FormField: ({ control, name, render }: any) => {
      const { field, fieldState } = useController({ control, name });
      return (
        <>
          {render({ field })}
          {fieldState.error ? <div role="alert">{fieldState.error.message}</div> : null}
        </>
      );
    },
    FormItem: ({ children }: any) => <div>{children}</div>,
    FormLabel: ({ children }: any) => <label>{children}</label>,
    FormControl: ({ children }: any) => <>{children}</>,
    FormDescription: ({ children }: any) => <div>{children}</div>,
    FormMessage: () => <div />,
  };
});

const { default: AiModelsPage } = await import('../index');

describe('AiModelsPage (TASK-356 Phase 1)', () => {
  beforeEach(() => {
    createSpy.mockReset();
    authState = { isGlobalScope: () => false, tenantId: 'tenant-1', tenantName: 'Acme Health' };
    useAiModelsMock.mockReset();
    useAiModelsMock.mockReturnValue({
      data: [
        {
          id: 'm1',
          name: 'Whisper Large V3',
          slug: 'whisper-large-v3',
          category: 'AUDIO',
          taskType: 'AUTOMATIC_SPEECH_RECOGNITION',
          format: 'ONNX',
          resourceStatus: 'ENABLED',
          tags: [],
          version: 3,
        },
      ],
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    });
  });

  it('renders the catalog table for the selected tenant', () => {
    render(<AiModelsPage />);
    expect(screen.getByRole('heading', { name: 'AI Models' })).toBeInTheDocument();
    expect(screen.getByTestId('admin-data-table')).toBeInTheDocument();
    expect(screen.getByText('Whisper Large V3')).toBeInTheDocument();
  });

  it('global-scope admin without a tenant sees the select-a-tenant prompt (no table)', () => {
    authState = { isGlobalScope: () => true, tenantId: '', tenantName: '' };
    render(<AiModelsPage />);
    expect(screen.getByTestId('ai-models-select-tenant')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-data-table')).not.toBeInTheDocument();
  });

  it('opens the create dialog and blocks submit on zod validation, then submits when valid', async () => {
    render(<AiModelsPage />);

    fireEvent.click(screen.getByTestId('create-ai-model-btn'));

    // Submit with required text fields empty → zod blocks, no mutation fires.
    fireEvent.click(screen.getByTestId('ai-model-submit'));
    await waitFor(() => expect(screen.getByText('Name is required')).toBeInTheDocument());
    expect(createSpy).not.toHaveBeenCalled();

    // Fill the required text fields (selects keep their valid defaults).
    fireEvent.change(screen.getByPlaceholderText('e.g. Whisper Large V3'), { target: { value: 'My Model' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. openai/whisper-large-v3'), { target: { value: 'org/my-model' } });

    fireEvent.click(screen.getByTestId('ai-model-submit'));

    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      name: 'My Model',
      slug: 'my-model',
      sourceUri: 'org/my-model',
      category: 'AUDIO',
      format: 'SAFETENSOR',
    });
  });
});
