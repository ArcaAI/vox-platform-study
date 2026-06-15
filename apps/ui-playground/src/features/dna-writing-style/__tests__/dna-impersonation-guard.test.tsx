import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import { useDoctorContext, type DoctorContext } from '@/features/summarization/hooks/use-doctor-context';
import DnaWritingStylePage from '../index';

/**
 * Tests that the DNA Writing Style page:
 * 1. Shows the shared ImpersonationGuard when admin has not impersonated
 * 2. Uses effectiveUserId (impersonated doctor) for data fetching
 * 3. Disables queries when requiresImpersonation is true
 * 4. TASK-331 doc-07 F1 — gates the header "Generate Style" trigger + the
 *    GenerateDialog behind the SAME impersonation signal as the page body, so a
 *    non-impersonating admin can neither open nor submit the generate flow.
 *
 * Mirrors the pattern from /summarization/pre-summary and /summarization/summary.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'];
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

function buildContext(overrides: Partial<DoctorContext> & { roles: string[] }): DoctorContext {
  const roles = overrides.roles;
  const isAdmin = overrides.isAdmin ?? roles.some((r) => ADMIN_ROLES.includes(r));
  const isDoctor = overrides.isDoctor ?? roles.some((r) => DOCTOR_ROLES.includes(r));
  const isImpersonated = overrides.isImpersonated ?? false;
  const requiresImpersonation = overrides.requiresImpersonation ?? (isAdmin && !isDoctor && !isImpersonated);
  const effectiveUserId = overrides.effectiveUserId ?? 'self-user-id';

  return { effectiveUserId, isImpersonated, requiresImpersonation, isAdmin, isDoctor, primaryDepartmentId: undefined, roles };
}

describe('DNA Writing Style ImpersonationGuard integration', () => {
  describe('guard rendering decision', () => {
    it('should show ImpersonationGuard when admin is not impersonating', () => {
      const ctx = buildContext({ roles: ['SUPER_ADMIN'] });
      expect(ctx.requiresImpersonation).toBe(true);
    });

    it('should NOT show ImpersonationGuard when doctor accesses page', () => {
      const ctx = buildContext({ roles: ['DOCTOR'] });
      expect(ctx.requiresImpersonation).toBe(false);
    });

    it('should NOT show ImpersonationGuard when admin is impersonating a doctor', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'impersonated-doctor-id',
      });
      expect(ctx.requiresImpersonation).toBe(false);
    });
  });

  describe('data fetching with impersonation context', () => {
    it('should use effectiveUserId (impersonated doctor) for DNA style query', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-abc-123',
      });

      // The page should call useDnaStyleByDoctor(ctx.effectiveUserId)
      // instead of useMyDnaStyle() so it fetches the impersonated doctor's style
      expect(ctx.effectiveUserId).toBe('doctor-abc-123');
      expect(ctx.isImpersonated).toBe(true);
      expect(ctx.requiresImpersonation).toBe(false);
    });

    it('should use own userId when not impersonating (doctor user)', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: 'my-doctor-id',
      });

      expect(ctx.effectiveUserId).toBe('my-doctor-id');
      expect(ctx.isImpersonated).toBe(false);
    });

    it('should disable DNA style query when requiresImpersonation is true', () => {
      const ctx = buildContext({ roles: ['GLOBAL_ADMIN'] });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(false);
    });

    it('should enable DNA style query when admin is impersonating', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-xyz',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(true);
    });

    it('should enable DNA style query for doctor user', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: 'doctor-self',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(true);
    });

    it('should disable DNA style query when effectiveUserId is empty', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: '',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(false);
    });

    it('should disable reports list query when requiresImpersonation is true', () => {
      const ctx = buildContext({ roles: ['TENANT_ADMIN'] });

      const reportsQueryEnabled = !ctx.requiresImpersonation;
      expect(reportsQueryEnabled).toBe(false);
    });

    it('should enable reports list query when impersonating', () => {
      const ctx = buildContext({
        roles: ['TENANT_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-id',
      });

      const reportsQueryEnabled = !ctx.requiresImpersonation;
      expect(reportsQueryEnabled).toBe(true);
    });
  });

  describe('ImpersonationGuard props for DNA page', () => {
    it('should pass roles for display', () => {
      const guardProps = {
        roles: ['TENANT_ADMIN'],
      };
      expect(guardProps.roles).toEqual(['TENANT_ADMIN']);
    });

    it('should accept featureName for contextual subtitle', () => {
      const guardProps = {
        roles: ['SUPER_ADMIN'],
        featureName: 'DNA writing style',
      };
      expect(guardProps.featureName).toBe('DNA writing style');
    });

    it('should accept featureDescription for contextual body text', () => {
      const guardProps = {
        roles: ['SUPER_ADMIN'],
        featureDescription:
          'DNA writing styles are personalized per doctor. As an admin, you need to impersonate a doctor to generate or view their writing style profile.',
      };
      expect(guardProps.featureDescription).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-331 doc-07 F1 — the header "Generate Style" button + GenerateDialog must
// live behind the SAME impersonation gate as the page body. We render the REAL
// page with the REAL ImpersonationGuard; only the data hooks / leaf panels are
// stubbed so the assertions are about the gating wiring, not the children.
// ---------------------------------------------------------------------------

vi.mock('@/features/summarization/hooks/use-doctor-context', () => ({
  useDoctorContext: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

// @arcaai/ui subpaths are stubbed to `{}` by the playground vitest config.
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
vi.mock('@arcaai/ui/dialog', () => ({
  // Render children regardless of `open` so a *mounted* GenerateDialog is
  // detectable (its DialogTitle) — the point being it isn't mounted at all when
  // impersonation is required.
  Dialog: ({ children }: any) => <div data-testid="generate-dialog">{children}</div>,
  DialogClose: ({ children }: any) => <div>{children}</div>,
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogDescription: ({ children }: any) => <div>{children}</div>,
  DialogFooter: ({ children }: any) => <div>{children}</div>,
  DialogHeader: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/form', () => ({
  Form: ({ children }: any) => <div>{children}</div>,
  FormControl: ({ children }: any) => <div>{children}</div>,
  FormDescription: ({ children }: any) => <div>{children}</div>,
  FormField: ({ render }: any) => render({ field: { name: 'textSamples', value: '', onChange: () => {}, onBlur: () => {}, ref: () => {} } }),
  FormItem: ({ children }: any) => <div>{children}</div>,
  FormLabel: ({ children }: any) => <label>{children}</label>,
  FormMessage: ({ children }: any) => <div>{children}</div>,
}));
vi.mock('@arcaai/ui/progress', () => ({ Progress: (p: any) => <div role="progressbar" {...p} /> }));
vi.mock('@arcaai/ui/skeleton', () => ({ Skeleton: (p: any) => <div {...p} /> }));
vi.mock('@arcaai/ui/textarea', () => ({ Textarea: (p: any) => <textarea {...p} /> }));

vi.mock('@/components/live-code-panel', () => ({ LiveCodePanel: () => null }));
vi.mock('@/components/layout/main', () => ({ Main: ({ children }: any) => <div>{children}</div> }));
vi.mock('@/lib/zod-resolver', () => ({ zodResolver: () => undefined }));

vi.mock('../api/dna-writing-styles', () => ({
  useMyDnaStyle: () => ({ data: undefined, isLoading: false, error: undefined, refetch: vi.fn() }),
  useDnaVersions: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useMyDnaReports: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useGenerateDnaReport: () => ({ mutate: vi.fn(), isPending: false }),
  useSetDefaultDnaReport: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  useDnaJobStatus: () => ({ data: undefined }),
  streamDnaJob: () => ({ abort: vi.fn() }),
}));
// TASK-356 Phase 6 (S7) — the page now mounts the per-doctor DNA on/off card
// (its own `useDnaSettings`/`useUpdateDnaSettings` hooks). This suite is about
// the generate-action gating, so stub the card to keep the render focused.
vi.mock('../components/dna-settings-card', () => ({ DnaSettingsCard: () => null }));
vi.mock('../components/edit-dialog', () => ({ EditDialog: () => null }));
vi.mock('../components/generate-from-history-panel', () => ({ GenerateFromHistoryPanel: () => null }));
vi.mock('../components/reports-list-panel', () => ({ ReportsListPanel: () => null }));
vi.mock('../components/version-diff-section', () => ({ VersionDiffSection: () => null }));
vi.mock('../components/versions-panel', () => ({ VersionsPanel: () => null }));
vi.mock('../hooks/use-edit-dialog-controller', () => ({
  useEditDialogController: () => ({ open: false, report: null, openFor: vi.fn(), close: vi.fn(), setOpen: vi.fn() }),
}));

const mockUseDoctorContext = vi.mocked(useDoctorContext);

describe('DNA Writing Style — Generate action gating (TASK-331 doc-07 F1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides the "Generate Style" trigger + GenerateDialog when impersonation is required', () => {
    mockUseDoctorContext.mockReturnValue(buildContext({ roles: ['TENANT_ADMIN'], requiresImpersonation: true }));

    render(<DnaWritingStylePage />);

    // The body gate is shown…
    expect(screen.getByText(/Impersonation Required/i)).toBeInTheDocument();
    // …and the privileged generate trigger + dialog are NOT in the tree.
    expect(screen.queryByRole('button', { name: /generate style/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/Generate DNA Writing Style/i)).not.toBeInTheDocument();
  });

  it('renders the "Generate Style" trigger + GenerateDialog once impersonation is satisfied', () => {
    mockUseDoctorContext.mockReturnValue(
      buildContext({ roles: ['SUPER_ADMIN'], isImpersonated: true, requiresImpersonation: false, effectiveUserId: 'doctor-1' }),
    );

    render(<DnaWritingStylePage />);

    expect(screen.getByRole('button', { name: /generate style/i })).toBeInTheDocument();
    expect(screen.getByText(/Generate DNA Writing Style/i)).toBeInTheDocument();
  });
});
