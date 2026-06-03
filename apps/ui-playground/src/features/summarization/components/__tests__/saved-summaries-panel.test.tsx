/**
 * SavedSummariesPanel smoke test (TASK-329 P6)
 *
 * Verifies the consultation-scoped summary management surface:
 *   - empty/info state when no consultation is active
 *   - skeleton → empty when a consultation has no summaries
 *   - list renders cacheHit / qualityScore badges
 *   - selecting a summary loads versions + tags; adding a tag calls the SDK
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// The ui-playground vitest config stubs every `@arcaai/ui/*` subpath with
// `export default {}`, so each primitive used by the component must be mocked
// with a lightweight element here (mirrors the all-reports-panel test pattern).
vi.mock('@arcaai/ui/card', () => ({
  Card: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardHeader: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardTitle: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardDescription: ({ children, ...p }: any) => <div {...p}>{children}</div>,
  CardContent: ({ children, ...p }: any) => <div {...p}>{children}</div>,
}));
vi.mock('@arcaai/ui/button', () => ({
  Button: ({ children, ...p }: any) => <button {...p}>{children}</button>,
}));
vi.mock('@arcaai/ui/badge', () => ({
  Badge: ({ children, ...p }: any) => <span {...p}>{children}</span>,
}));
vi.mock('@arcaai/ui/input', () => ({
  Input: (p: any) => <input {...p} />,
}));
vi.mock('@arcaai/ui/textarea', () => ({
  Textarea: (p: any) => <textarea {...p} />,
}));
vi.mock('@arcaai/ui/skeleton', () => ({
  Skeleton: (p: any) => <div data-testid="skeleton" {...p} />,
}));
vi.mock('@arcaai/ui/separator', () => ({
  Separator: (p: any) => <hr {...p} />,
}));
// Radix `Select` is event-driven; the default stub can't fire `onValueChange`.
// Mirror the `processing-config-panel` test: thread `onValueChange` through a
// context so a `SelectItem` click selects its value (and composes with the
// Trigger/Value/Content wrappers the panel uses for the version pickers).
const SelectContext = React.createContext<{ onValueChange?: (v: string) => void }>({});
vi.mock('@arcaai/ui/select', () => ({
  Select: ({ children, value, onValueChange }: any) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div data-testid="select-root" data-value={value}>
        {children}
      </div>
    </SelectContext.Provider>
  ),
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, value }: any) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <div data-testid="select-item" data-value={value} onClick={() => onValueChange?.(value)}>
        {children}
      </div>
    );
  },
  SelectTrigger: ({ children }: any) => <div>{children}</div>,
  SelectValue: ({ children, placeholder }: any) => <div>{children ?? placeholder}</div>,
}));
vi.mock('@/components/version-diff-panel', () => ({
  VersionDiffPanel: () => <div data-testid="version-diff-panel" />,
}));

const state = vi.hoisted(() => ({
  consultation: null as { id: string } | null,
  listConsultations: vi.fn(),
  load: vi.fn(),
  loadSummaries: vi.fn(),
  getSummaryHistory: vi.fn(),
  getSummaryTags: vi.fn(),
  tagSummary: vi.fn(),
  deleteSummaryTag: vi.fn(),
  diffSummaryVersions: vi.fn(),
  updateSummary: vi.fn(),
}));

vi.mock('@arcaai/vox', () => ({
  useArca: () => ({
    session: {
      consultation: state.consultation,
      listConsultations: state.listConsultations,
      load: state.load,
    },
  }),
  useArcaSummary: () => ({
    loadSummaries: state.loadSummaries,
    getSummaryHistory: state.getSummaryHistory,
    getSummaryTags: state.getSummaryTags,
    tagSummary: state.tagSummary,
    deleteSummaryTag: state.deleteSummaryTag,
    diffSummaryVersions: state.diffSummaryVersions,
    updateSummary: state.updateSummary,
  }),
}));

vi.mock('../../hooks/use-doctor-context', () => ({
  useDoctorContext: () => ({
    effectiveUserId: 'doctor-1',
    isImpersonated: false,
    requiresImpersonation: false,
    isAdmin: false,
    isDoctor: true,
    primaryDepartmentId: undefined,
    roles: ['DOCTOR'],
  }),
}));

import { SavedSummariesPanel } from '../saved-summaries-panel';

const SUMMARY = {
  id: 'sum-1',
  contextItemId: 'ctx-1',
  type: 'summary' as const,
  content: 'Patient presents with chest pain.',
  versionNumber: 2,
  structuredData: { cacheHit: true, qualityScore: 0.9 },
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  state.consultation = null;
  state.listConsultations.mockResolvedValue({ data: [], total: 0, page: 1, limit: 20 });
  state.load.mockResolvedValue(undefined);
  state.loadSummaries.mockResolvedValue([]);
  state.getSummaryHistory.mockResolvedValue([]);
  state.getSummaryTags.mockResolvedValue([]);
});

afterEach(() => cleanup());

describe('SavedSummariesPanel', () => {
  it('shows an informational state when no consultation is active', () => {
    render(<SavedSummariesPanel />);
    expect(screen.getByText(/Open a consultation/i)).toBeTruthy();
    expect(state.loadSummaries).not.toHaveBeenCalled();
  });

  it('loads summaries and shows the empty state when there are none', async () => {
    state.consultation = { id: 'c-1' };
    render(<SavedSummariesPanel />);
    await waitFor(() => expect(state.loadSummaries).toHaveBeenCalled());
    expect(await screen.findByTestId('summaries-empty')).toBeTruthy();
  });

  it('renders cacheHit and qualityScore badges for each summary', async () => {
    state.consultation = { id: 'c-1' };
    state.loadSummaries.mockResolvedValue([SUMMARY]);
    render(<SavedSummariesPanel />);

    expect(await screen.findByText('Patient presents with chest pain.')).toBeTruthy();
    expect(screen.getByText('cache hit')).toBeTruthy();
    expect(screen.getByText('quality 0.90')).toBeTruthy();
  });

  it('selecting a summary loads its versions + tags and lets you add a tag', async () => {
    state.consultation = { id: 'c-1' };
    state.loadSummaries.mockResolvedValue([SUMMARY]);
    state.tagSummary.mockResolvedValue({ id: 'tag-1', tagValue: 'reviewed' });
    render(<SavedSummariesPanel />);

    const row = await screen.findByText('Patient presents with chest pain.');
    fireEvent.click(row);

    await waitFor(() => expect(state.getSummaryHistory).toHaveBeenCalledWith('ctx-1'));
    expect(state.getSummaryTags).toHaveBeenCalledWith('ctx-1');

    const input = await screen.findByPlaceholderText('Add a tag…');
    fireEvent.change(input, { target: { value: 'reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: /Add/i }));

    await waitFor(() => expect(state.tagSummary).toHaveBeenCalledWith('ctx-1', { tagValue: 'reviewed' }));
  });

  // ── F6 (TASK-331 doc-07): explicit consultation selector ───────────────
  // The panel must let the user pick WHICH consultation's saved summaries to
  // view, instead of implicitly binding to the "last loaded" store consultation
  // (a side effect of the summary page's suggestion loader).
  describe('explicit consultation selector (F6)', () => {
    const CONSULTATIONS = {
      data: [
        { id: 'c-1', patientId: 'patient-alpha', doctorId: 'doctor-1', appointmentDate: '2026-01-01' },
        { id: 'c-2', patientId: 'patient-bravo', doctorId: 'doctor-1', appointmentDate: '2026-02-02' },
      ],
      total: 2,
      page: 1,
      limit: 20,
    };

    it('renders a consultation selector listing the doctor’s consultations', async () => {
      state.consultation = { id: 'c-1' };
      state.listConsultations.mockResolvedValue(CONSULTATIONS);
      render(<SavedSummariesPanel />);

      await waitFor(() => expect(state.listConsultations).toHaveBeenCalled());
      // Both consultations are offered as choices (not just the active one).
      expect(await screen.findByText(/patient-alpha/)).toBeTruthy();
      expect(await screen.findByText(/patient-bravo/)).toBeTruthy();
    });

    it('switching the selector loads the chosen consultation and reloads its summaries', async () => {
      state.consultation = { id: 'c-1' };
      state.listConsultations.mockResolvedValue(CONSULTATIONS);
      render(<SavedSummariesPanel />);

      await waitFor(() => expect(state.listConsultations).toHaveBeenCalled());
      const option = await screen.findByText(/patient-bravo/);

      state.load.mockClear();
      state.loadSummaries.mockClear();
      fireEvent.click(option);

      // Picking c-2 makes it the active consultation (explicit), then reloads.
      await waitFor(() => expect(state.load).toHaveBeenCalledWith('c-2'));
      await waitFor(() => expect(state.loadSummaries).toHaveBeenCalled());
    });
  });
});
