/**
 * Frame 50 — Consultation Scribe workspace (matrix row 34; TASK-543).
 * The `@arcaai/vox` module is mocked at the boundary (the SDK has its own
 * suite); fetch is stubbed by pathname. Covers the NoTenant gate and the
 * live 3-column structure: the real consultation list (SDK `listConsultations`),
 * the live-session and case-note columns, and the footer model selectors.
 * Column interactions (search/select/open, assurance/sign-off) are unit-tested
 * against the column components directly.
 */

import { cleanup, screen, waitFor } from '@testing-library/react';
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
    user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['GLOBAL_ADMIN'], tenantId: null },
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

function stubFetch(sessionOverrides: Parameters<typeof session>[0] = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      if (path === '/api/auth/session') return Response.json(session(sessionOverrides));
      if (path === '/api/hope/audio/pipelines') return Response.json(PIPELINES);
      throw new Error(`Unhandled fetch: ${path}`);
    }),
  );
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
});
