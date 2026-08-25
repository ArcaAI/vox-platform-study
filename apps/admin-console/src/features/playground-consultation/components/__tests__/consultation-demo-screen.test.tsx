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
}));

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
    expect(screen.getByText('Transcription Listener')).toBeTruthy();
    expect(screen.getByText('Note assistant')).toBeTruthy();
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
