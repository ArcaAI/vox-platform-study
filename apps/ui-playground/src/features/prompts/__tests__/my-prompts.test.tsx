import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * TASK-356 Phase 6 (S7) — "My Prompts" doctor page (plan test #22).
 *
 * Verifies the page lists the caller's personals + the read-only defaults,
 * the set-preferred happy path (success toast + Preferred badge), and the
 * ownership-error toast on a rejected delete. Heavy mocking mirrors the
 * dna-impersonation-guard test: @arcaai/ui subpaths are stubbed to `{}` by the
 * vitest config, so every UI primitive used by the page is mocked here.
 */

const h = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  // Resolve the success path so the page promotes the preferred id.
  setPreferredMutate: vi.fn((id: string | null, opts?: { onSuccess?: (d: { preferredPromptTemplateId: string | null }) => void }) =>
    opts?.onSuccess?.({ preferredPromptTemplateId: id }),
  ),
  // Reject so the ownership-error toast fires.
  deleteMutate: vi.fn((_id: string, opts?: { onError?: (e: Error) => void }) => opts?.onError?.(new Error('You do not own this prompt'))),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  doctorCtx: { value: { requiresImpersonation: false } as { requiresImpersonation: boolean } },
}));

const PERSONAL = {
  id: 'tpl-personal',
  name: 'My SOAP prompt',
  category: 'SUMMARY',
  content: 'You are my personal assistant.',
  scope: 'USER_PERSONAL',
  currentVersionNumber: 1,
  version: 3,
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};
const DEFAULT_TPL = {
  id: 'tpl-default',
  name: 'Tenant SOAP default',
  category: 'SUMMARY',
  content: 'You are the default assistant.',
  scope: 'TENANT_DEFAULT',
  currentVersionNumber: 1,
  version: 1,
  createdAt: '2026-06-15T00:00:00.000Z',
  updatedAt: '2026-06-15T00:00:00.000Z',
};

vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError, warning: vi.fn() } }));

vi.mock('@/features/summarization/hooks/use-doctor-context', () => ({
  useDoctorContext: () => h.doctorCtx.value,
}));

vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/components/impersonation-guard', () => ({ ImpersonationGuard: ({ children }: any) => <div>{children}</div> }));

vi.mock('../api/prompts', () => ({
  USER_PERSONAL_SCOPE: 'USER_PERSONAL',
  useAvailablePrompts: () => ({ data: [PERSONAL, DEFAULT_TPL], isLoading: false }),
  useCreatePersonalPrompt: () => ({ mutate: h.createMutate, isPending: false }),
  useUpdatePersonalPrompt: () => ({ mutate: h.updateMutate, isPending: false }),
  useDeletePersonalPrompt: () => ({ mutate: h.deleteMutate, isPending: false }),
  useSetPreferredPrompt: () => ({ mutate: h.setPreferredMutate, isPending: false }),
}));

vi.mock('../components/prompt-form-dialog', () => ({ PromptFormDialog: () => null }));
vi.mock('../components/draft-final-diff-viewer', () => ({ DraftFinalDiffViewer: () => <div data-testid="diff" /> }));

vi.mock('@arcaai/ui/badge', () => ({ Badge: ({ children, ...p }: any) => <span {...p}>{children}</span> }));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, onClick, disabled, ...p }: any) => (
    <button onClick={onClick} disabled={disabled} {...p}>
      {children}
    </button>
  ),
}));
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/alert-dialog', () => ({
  // Respect `open` so the confirm action is only in the tree once triggered.
  AlertDialog: ({ open, children }: any) => (open ? <div>{children}</div> : null),
  AlertDialogAction: ({ children, onClick, ...p }: any) => (
    <button data-testid="confirm-delete" onClick={onClick} {...p}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children, ...p }: any) => <button {...p}>{children}</button>,
  AlertDialogContent: ({ children }: any) => <div>{children}</div>,
  AlertDialogDescription: ({ children }: any) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: any) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: any) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: any) => <div>{children}</div>,
}));

import MyPromptsPage from '../index';

describe('MyPromptsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.doctorCtx.value = { requiresImpersonation: false };
  });

  it('lists the caller personal prompts and the read-only defaults', () => {
    render(<MyPromptsPage />);

    expect(screen.getByText('My SOAP prompt')).toBeInTheDocument();
    expect(screen.getByText('Tenant SOAP default')).toBeInTheDocument();
    expect(screen.getByTestId('personal-prompt-card')).toBeInTheDocument();
    expect(screen.getByTestId('default-prompt-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create personal prompt/i })).toBeInTheDocument();
  });

  it('set-preferred happy path: calls the mutation, toasts success, shows the badge', async () => {
    const user = userEvent.setup();
    render(<MyPromptsPage />);

    const personalCard = screen.getByTestId('personal-prompt-card');
    await user.click(within(personalCard).getByRole('button', { name: /set as preferred/i }));

    expect(h.setPreferredMutate).toHaveBeenCalledWith('tpl-personal', expect.any(Object));
    expect(h.toastSuccess).toHaveBeenCalledWith('Preferred prompt updated');
    expect(within(screen.getByTestId('personal-prompt-card')).getByText('Preferred')).toBeInTheDocument();
  });

  it('delete ownership error surfaces an error toast', async () => {
    const user = userEvent.setup();
    render(<MyPromptsPage />);

    const personalCard = screen.getByTestId('personal-prompt-card');
    await user.click(within(personalCard).getByRole('button', { name: /delete/i }));

    await user.click(screen.getByTestId('confirm-delete'));

    expect(h.deleteMutate).toHaveBeenCalledWith('tpl-personal', expect.any(Object));
    expect(h.toastError).toHaveBeenCalledWith('Failed to delete prompt: You do not own this prompt');
  });

  it('hides the create trigger when impersonation is required', () => {
    h.doctorCtx.value = { requiresImpersonation: true };
    render(<MyPromptsPage />);

    expect(screen.queryByRole('button', { name: /create personal prompt/i })).not.toBeInTheDocument();
  });
});
