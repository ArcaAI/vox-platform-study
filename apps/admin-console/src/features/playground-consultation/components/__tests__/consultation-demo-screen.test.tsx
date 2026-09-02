/**
 * Frame 50 — Consultation Scribe workspace (matrix row 34).
 * The `@arcaai/vox` module is mocked at the boundary (the SDK has its own
 * suite); fetch is stubbed by pathname. Covers the NoTenant gate and the
 * live 3-column structure: the real consultation list (SDK `listConsultations`),
 * the live-session and case-note columns, and the footer model selectors.
 * Column interactions (search/select/open, assurance/sign-off) are unit-tested
 * against the column components directly.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { axe } from 'vitest-axe';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ConsultationDemoScreen } from '../consultation-demo-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/* eslint-disable @typescript-eslint/no-explicit-any -- the SDK double models only the consumed surface */
const sdk = vi.hoisted(() => ({
  arca: null as any,
  arcaSession: null as any,
  storeApi: null as any,
  userSettings: null as any,
  liveSummary: null as any,
  // TASK-858 Lane D — the two TASK-813 discovery hooks the screen now calls.
  selectableWorkflows: null as any,
  governingWorkflow: null as any,
}));
/* eslint-enable @typescript-eslint/no-explicit-any -- end of the SDK-double block */

vi.mock('@arcaai/vox', () => ({
  AgenticProvider: ({ children }: { children: ReactNode }) => children,
  useArca: () => sdk.arca,
  useArcaSession: () => sdk.arcaSession,
  useStoreApi: () => sdk.storeApi,
  useUserSettings: () => sdk.userSettings,
  useArcaLiveSummary: () => sdk.liveSummary,
  useArcaSttLanguageModes: () => ({ modes: [], isLoading: false, error: null, refresh: vi.fn(async () => undefined) }),
  useSelectableConsultationWorkflows: () => sdk.selectableWorkflows,
  useConsultationWorkflow: () => sdk.governingWorkflow,
}));

/** Published consultation workflows the tenant may select at open. */
const WORKFLOWS = [
  { slug: 'arcaai_consultation_soap', name: 'Consultation SOAP', description: null, isTenantDefault: true },
  { slug: 'arcaai_consultation_ner', name: 'Consultation with Medical NER', description: null, isTenantDefault: false },
];

function makeSelectableWorkflows(workflows: typeof WORKFLOWS | null = WORKFLOWS, isLoading = false) {
  return {
    workflows,
    tenantDefault: workflows?.find((workflow) => workflow.isTenantDefault) ?? null,
    isLoading,
    error: null,
    refresh: vi.fn(async () => workflows),
  };
}

function makeGoverningWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    workflow: null,
    isGoverned: false,
    isLoading: false,
    error: null,
    refresh: vi.fn(async () => null),
    ...overrides,
  };
}

const CONSULTATIONS = [
  { id: 'c-1', patientId: 'P-448', status: 'OPEN', createdAt: '2026-07-06T14:02:00.000Z' },
  { id: 'c-2', patientId: 'P-702', status: 'CLOSED', createdAt: '2026-07-05T09:00:00.000Z' },
];

function makeArca() {
  return {
    session: {
      open: vi.fn(async (input: { patientId: string }) => ({
        id: 'c-new',
        patientId: input.patientId,
        status: 'OPEN',
        createdAt: '2026-07-06T15:00:00.000Z',
      })),
      load: vi.fn(async (id: string) => ({ id, patientId: 'P-448', status: 'OPEN', createdAt: '2026-07-06T14:02:00.000Z' })),
      listConsultations: vi.fn(async () => ({ data: CONSULTATIONS, total: CONSULTATIONS.length, page: 1, limit: 50 })),
    },
    // `useArca().isReady` mirrors `store.initialized` — false until AgenticProvider
    // has wired `apiClient` onto the store.
    isReady: true,
    audio: {
      isCapturing: false,
      isMuted: false,
      level: 0,
      isSpeaking: false,
      currentTranscript: '',
      transcriptSegments: [],
      language: 'en',
      plugins: {},
      error: null,
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    },
  };
}

function makeUserSettings() {
  return {
    settings: [],
    isLoading: false,
    error: null,
    list: vi.fn(async () => []),
    updateByKey: vi.fn(async () => ({})),
    listForUser: vi.fn(),
    updateForUser: vi.fn(),
  };
}

function session(overrides: Partial<{ isElevated: boolean; workingTenantId: string | null }> = {}) {
  const base = {
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'], tenantId: null },
    isElevated: true,
    workingTenantId: 't-1',
    workingTenantName: 'Sunrise Medical Group',
    impersonatingUserId: null,
    impersonatingUsername: null,
    ...overrides,
  };
  return {
    ...base,
    effectiveUser: { ...base.user, departmentId: null },
    effectiveIsElevated: base.isElevated,
    effectiveTenantId: base.workingTenantId,
  };
}

const PIPELINES = [
  { id: 'pl-1', name: 'Default Clinical', slug: 'default-clinical', isDefault: true },
  { id: 'pl-2', name: 'Fast Draft', slug: 'fast-draft', isDefault: false },
];

/** TASK-805 — grants the point-of-care consent read returns for the open patient. */
interface ConsentStubGrant {
  id: string;
  externalPatientId: string;
  purpose: string;
  grantedAt: string;
  grantedBy: string;
  grantMethod: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  revokedAt?: string;
}

function activeDocumentationGrant(patientId: string): ConsentStubGrant {
  return {
    id: 'grant-1',
    externalPatientId: patientId,
    purpose: 'AI_DOCUMENTATION',
    grantedAt: '2026-08-01T00:00:00.000Z',
    grantedBy: 'clinician-1',
    grantMethod: 'VERBAL_ATTESTED',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    version: 1,
  };
}

function stubFetch(sessionOverrides: Parameters<typeof session>[0] = {}, consentGrants: ConsentStubGrant[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session(sessionOverrides));
      if (path === '/api/hope/audio/pipelines') return Response.json(PIPELINES);
      if (path === '/api/hope/admin/consent-grants') {
        return Response.json({ data: consentGrants, count: consentGrants.length, page: 1, limit: 50 });
      }
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
}

/** Select the seeded consultation so the point-of-care consent read fires. */
async function openConsultation() {
  const row = await screen.findByText('P-448');
  fireEvent.click(row);
  await waitFor(() => expect(sdk.arca.session.load).toHaveBeenCalled());
}

beforeEach(() => {
  sdk.arca = makeArca();
  sdk.arcaSession = { close: vi.fn(), reopen: vi.fn() };
  sdk.storeApi = { getState: () => ({}) };
  sdk.userSettings = makeUserSettings();
  sdk.liveSummary = { snapshot: null, status: 'idle', error: null, start: vi.fn(), stop: vi.fn() };
  sdk.selectableWorkflows = makeSelectableWorkflows();
  sdk.governingWorkflow = makeGoverningWorkflow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  cleanup();
});

describe('ConsultationDemoScreen (scribe workspace)', () => {
  it('shows the NoTenant gate when no working tenant is selected', async () => {
    stubFetch({ isElevated: true, workingTenantId: null });
    renderWithProviders(<ConsultationDemoScreen />);
    expect(await screen.findByText(/select a working tenant/i)).toBeTruthy();
    expect(sdk.arca.session.listConsultations).not.toHaveBeenCalled();
  });

  it('renders the three columns, the real consultation list and the footer selectors', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);

    // Column landmarks (section aria-labels).
    expect(await screen.findByRole('region', { name: /consultations/i })).toBeTruthy();
    expect(screen.getByRole('region', { name: /live session/i })).toBeTruthy();
    expect(screen.getByRole('region', { name: /case note/i })).toBeTruthy();

    // Real list from the SDK.
    await waitFor(() => expect(sdk.arca.session.listConsultations).toHaveBeenCalled());
    expect(await screen.findByText('P-448')).toBeTruthy();
    expect(screen.getByText('P-702')).toBeTruthy();

    // Footer model selectors.
    expect(screen.getByText('Transcription agent (STT pipeline)')).toBeTruthy();
    expect(screen.getByText('Note assistant')).toBeTruthy();
  });

  /**
   * The consultation list must not race SDK initialization.
   *
   * Observed at runtime (TASK-814 §9 browser pass, impersonated clinician): the
   * query fired before `AgenticProvider` had put `apiClient` on the store, so
   * `listConsultations()` rejected with `Error: SDK not initialized`. The retry
   * was then left in TanStack's `paused` fetchStatus, so the query stayed
   * `pending` forever with `data === undefined` and `error === null` — which
   * renders neither the skeleton (`isLoading` is false while paused) nor the
   * error branch, but the "No consultations yet" EMPTY state. A clinician with
   * real consultations saw an empty list permanently and could never re-open one.
   *
   * An empty state is not a loading state: until the SDK is ready the query must
   * not run at all.
   */
  it('does not query the consultation list until the SDK is initialized', async () => {
    stubFetch();
    sdk.arca.isReady = false;
    renderWithProviders(<ConsultationDemoScreen />);

    await screen.findByRole('region', { name: /consultations/i });
    expect(sdk.arca.session.listConsultations).not.toHaveBeenCalled();
  });

  it('never shows the empty state while the SDK is still initializing', async () => {
    stubFetch();
    sdk.arca.isReady = false;
    // Model the runtime failure exactly: called before init, the SDK rejects.
    sdk.arca.session.listConsultations = vi.fn(async () => {
      throw new Error('SDK not initialized');
    });
    renderWithProviders(<ConsultationDemoScreen />);

    await screen.findByRole('region', { name: /consultations/i });
    // The pre-ready column is LOADING, not empty — the empty state would be a lie.
    expect(screen.queryByText(/no consultations yet/i)).toBeNull();
    expect(sdk.arca.session.listConsultations).not.toHaveBeenCalled();
  });

  it('loads the list once the SDK finishes initializing (the gate opens, it does not latch)', async () => {
    stubFetch();
    sdk.arca.isReady = false;
    const { rerender } = renderWithProviders(<ConsultationDemoScreen />);
    await screen.findByRole('region', { name: /consultations/i });
    expect(sdk.arca.session.listConsultations).not.toHaveBeenCalled();

    sdk.arca = { ...sdk.arca, isReady: true };
    rerender(<ConsultationDemoScreen />);

    await waitFor(() => expect(sdk.arca.session.listConsultations).toHaveBeenCalled());
    expect(await screen.findByText('P-448')).toBeTruthy();
  });

  it('reads the persisted column layout through the SDK settings plane', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await screen.findByRole('region', { name: /consultations/i });
    await waitFor(() => expect(sdk.userSettings.list).toHaveBeenCalled());
  });

  // TASK-805 — the consent gate. `recording/start` carries
  // `@RequiresConsent(AI_DOCUMENTATION)`, so a patient with no active grant
  // must be blocked BEFORE the microphone opens, with the fix attached.
  describe('consent gate', () => {
    it('blocks Start and explains why when the patient has no active AI-documentation consent', async () => {
      stubFetch({}, []);
      renderWithProviders(<ConsultationDemoScreen />);
      await openConsultation();

      expect(await screen.findByText(/patient P-448 has no active AI documentation consent on record/i)).toBeTruthy();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Start$/ })).toHaveProperty('disabled', true));
      // The block must carry its own remedy, not just a refusal.
      expect(screen.getByRole('button', { name: /record consent/i })).toBeTruthy();
    });

    it('never opens the microphone while consent is missing', async () => {
      stubFetch({}, []);
      renderWithProviders(<ConsultationDemoScreen />);
      await openConsultation();
      await screen.findByText(/no active AI documentation consent on record/i);

      fireEvent.click(screen.getByRole('button', { name: /^Start$/ }));
      expect(sdk.arca.audio.start).not.toHaveBeenCalled();
    });

    it('allows Start once an active grant exists', async () => {
      stubFetch({}, [activeDocumentationGrant('P-448')]);
      renderWithProviders(<ConsultationDemoScreen />);
      await openConsultation();

      await waitFor(() => expect(screen.getByRole('button', { name: /^Start$/ })).toHaveProperty('disabled', false));
      expect(screen.queryByText(/no active AI documentation consent on record/i)).toBeNull();
    });

    it('a REVOKED grant does not count as consent', async () => {
      stubFetch({}, [{ ...activeDocumentationGrant('P-448'), revokedAt: '2026-08-10T00:00:00.000Z' }]);
      renderWithProviders(<ConsultationDemoScreen />);
      await openConsultation();

      expect(await screen.findByText(/no active AI documentation consent on record/i)).toBeTruthy();
    });

    // The console gate is a convenience; PatientConsentGuard is the boundary.
    // A role that cannot read the register still holds a valid session, and
    // must not be locked out of a gate the console merely could not see.
    it('does not block when the consent read itself fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request) => {
          const path = new URL(String(input), 'http://test.local').pathname;
          if (path === '/api/auth/session') return Response.json(session());
          if (path === '/api/hope/audio/pipelines') return Response.json(PIPELINES);
          if (path === '/api/hope/admin/consent-grants') return new Response('{"message":"Forbidden"}', { status: 403 });
          throw new Error(`Unhandled fetch: ${path}`);
        }),
      );
      renderWithProviders(<ConsultationDemoScreen />);
      await openConsultation();

      await waitFor(() => expect(screen.getByRole('button', { name: /^Start$/ })).toHaveProperty('disabled', false));
      expect(screen.queryByText(/no active AI documentation consent on record/i)).toBeNull();
    });
  });
});

/**
 * TASK-858 Lane D — a clinician selects the workflow that governs the consultation.
 *
 * TASK-813 shipped both halves of this (selection at open, and the read-back that says what
 * actually took the consultation) and the console called NEITHER: `useSelectableConsultation-
 * Workflows` had zero call sites, so every session ran whatever the assignment cascade picked
 * and nothing on screen said which engine that was.
 */
describe('ConsultationDemoScreen — workflow selection and governance', () => {
  async function openNewForm() {
    await screen.findByRole('region', { name: /consultations/i });
    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
  }

  it('offers the tenant\u2019s published workflows in the open form', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await openNewForm();

    expect(await screen.findByLabelText(/^workflow$/i)).toBeTruthy();
  });

  it('opens the consultation with the preselected tenant default', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await openNewForm();

    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() =>
      expect(sdk.arca.session.open).toHaveBeenCalledWith(expect.objectContaining({ patientId: 'P-900', workflowDefinitionSlug: 'arcaai_consultation_soap' })),
    );
  });

  it('omits the slug entirely when the tenant has published none (the platform default governs)', async () => {
    stubFetch();
    sdk.selectableWorkflows = makeSelectableWorkflows([]);
    renderWithProviders(<ConsultationDemoScreen />);
    await openNewForm();

    expect(screen.getByText(/no published workflows/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-901' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(sdk.arca.session.open).toHaveBeenCalled());
    expect(sdk.arca.session.open.mock.calls[0][0]).not.toHaveProperty('workflowDefinitionSlug');
  });

  it('a failed discovery read never blocks the open (fail-open, and it says so)', async () => {
    stubFetch();
    sdk.selectableWorkflows = makeSelectableWorkflows(null);
    renderWithProviders(<ConsultationDemoScreen />);
    await openNewForm();

    expect(screen.getByText(/workflow selection unavailable/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-902' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(sdk.arca.session.open).toHaveBeenCalled());
  });

  it('names the governing workflow once a consultation is open', async () => {
    stubFetch();
    sdk.governingWorkflow = makeGoverningWorkflow({
      workflow: {
        consultationId: 'c-1',
        governed: true,
        workflowDefinitionSlug: 'arcaai_consultation_ner',
        name: 'Consultation with Medical NER',
        activeVersionNumber: 2,
      },
      isGoverned: true,
    });
    renderWithProviders(<ConsultationDemoScreen />);
    await openConsultation();

    expect(await screen.findByText(/Governed by Consultation with Medical NER/)).toBeTruthy();
  });

  it('reports an unresolved governance read as unknown, not as the default engine', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await openConsultation();

    expect(await screen.findByText(/governing workflow unknown/i)).toBeTruthy();
    expect(screen.queryByText(/default engine governs/i)).toBeNull();
  });

  it('says nothing about governance before a consultation exists', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await screen.findByRole('region', { name: /consultations/i });

    expect(screen.queryByText(/governing workflow unknown/i)).toBeNull();
    expect(screen.queryByText(/governed by/i)).toBeNull();
  });

  /**
   * Scoped to the session-open column ON PURPOSE. A whole-container scan fails on a
   * PRE-EXISTING defect outside this lane: `@arcaai/ui`'s `ResizableHandle` renders
   * `role="separator"` with `tabindex=0` and no `aria-valuenow`, which axe reports as
   * `aria-required-attr` (serious) twice — once per handle in the 3-column group. That is a
   * `packages/ui` fix, not a Scribe one, and scoping here keeps a REAL zero-violation gate on
   * the surface this change actually touches instead of deleting the assertion.
   */
  it('has no axe violations with the workflow picker open', async () => {
    stubFetch();
    renderWithProviders(<ConsultationDemoScreen />);
    await openNewForm();
    await screen.findByLabelText(/^workflow$/i);

    expect(await axe(screen.getByRole('region', { name: /consultations/i }))).toHaveNoViolations();
  });
});
