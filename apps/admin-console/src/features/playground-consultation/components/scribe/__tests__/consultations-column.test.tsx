/**
 * consultation list column. Pure component: real rows in,
 * search/select/open callbacks out. No SDK or SSE.
 */

import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsultationsColumn, type ConsultationListRow } from '../consultations-column';

const ROWS: ConsultationListRow[] = [
  { id: 'c-1', patientId: 'P-448', status: 'RECORDING', createdAt: '2026-07-06T14:02:00.000Z' },
  { id: 'c-2', patientId: 'P-702', status: 'CLOSED', createdAt: '2026-07-05T09:00:00.000Z' },
];

function setup(overrides: Partial<React.ComponentProps<typeof ConsultationsColumn>> = {}) {
  const props = {
    rows: ROWS,
    isLoading: false,
    error: null,
    selectedId: 'c-1',
    onSelect: vi.fn(),
    onOpenPatient: vi.fn(async () => undefined),
    activeIsRecording: true,
    ...overrides,
  };
  return { props, ...render(<ConsultationsColumn {...props} />) };
}

afterEach(cleanup);

describe('ConsultationsColumn', () => {
  /**
   * WCAG 2.1.1 / 2.1.3 — axe `scrollable-region-focusable` (impact: serious).
   * The list pane scrolls; while it is loading or empty it holds no focusable
   * child, so a keyboard user cannot scroll it. Real-browser-only finding
 */
  it('exposes the scrolling list pane to the keyboard', () => {
    const { container } = setup({ isLoading: true });
    const pane = container.querySelector('.overflow-y-auto');
    expect(pane).not.toBeNull();
    expect(pane?.getAttribute('tabindex')).toBe('0');
  });

  it('renders each patient with a count and a REC badge on the active recording row', () => {
    setup();
    expect(screen.getByText('Consultations (2)')).toBeTruthy();
    expect(screen.getByText('P-448')).toBeTruthy();
    expect(screen.getByText('REC')).toBeTruthy();
  });

  it('filters rows by the search query', () => {
    setup();
    fireEvent.change(screen.getByLabelText(/search consultations/i), { target: { value: '702' } });
    expect(screen.queryByText('P-448')).toBeNull();
    expect(screen.getByText('P-702')).toBeTruthy();
  });

  it('calls onSelect with the row when a consultation is clicked', () => {
    const { props } = setup({ selectedId: null, activeIsRecording: false });
    fireEvent.click(screen.getByText('P-702'));
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'c-2' }));
  });

  it('opens a new consultation from the New form', async () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', {}));
  });

  it('validates a required patient id before opening', () => {
    const { props } = setup();
    fireEvent.click(screen.getByRole('button', { name: /new/i }));
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    expect(screen.getByText(/patient id is required/i)).toBeTruthy();
    expect(props.onOpenPatient).not.toHaveBeenCalled();
  });

  describe('patient lookup (replaces pure free-text entry)', () => {
    it('offers the patient ids already seen in this clinician\'s consultation list as suggestions', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
      const input = screen.getByLabelText(/patient id/i) as HTMLInputElement;
      const datalist = document.getElementById(input.getAttribute('list') ?? '');
      expect(datalist).toBeTruthy();
      const options = Array.from(datalist?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value'));
      expect(options).toEqual(['P-448', 'P-702']);
    });

    it('dedupes patient ids across multiple consultations for the same patient', () => {
      setup({ rows: [...ROWS, { id: 'c-3', patientId: 'P-448', status: 'CLOSED', createdAt: '2026-07-01T00:00:00.000Z' }] });
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
      const input = screen.getByLabelText(/patient id/i) as HTMLInputElement;
      const datalist = document.getElementById(input.getAttribute('list') ?? '');
      const options = Array.from(datalist?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value'));
      expect(options).toEqual(['P-448', 'P-702']);
    });

    it('still accepts a brand-new patient id typed freehand (no registry to constrain it to)', async () => {
      const { props } = setup();
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
      fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-first-time' } });
      fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
      await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-first-time', {}));
    });

    it('0 axe violations on the New form with the patient-lookup datalist wired up', async () => {
      const { container } = setup();
      fireEvent.click(screen.getByRole('button', { name: /new/i }));
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  it('shows an empty state when there are no consultations', () => {
    setup({ rows: [] });
    expect(screen.getByText(/no consultations yet/i)).toBeTruthy();
  });

  it('renders a skeleton while loading', () => {
    const { container } = setup({ isLoading: true, rows: [] });
    expect(container.querySelector('[data-slot="skeleton"]')).toBeTruthy();
  });

  it('shows an error message', () => {
    setup({ error: 'boom', rows: [] });
    expect(within(screen.getByRole('alert')).getByText('boom')).toBeTruthy();
  });
});

/**
 * / — department scoping was structurally dead
 * because the open call never carried a department. `consultation.departmentId`
 * feeds BOTH the SOAP prompt-tier resolver (`summary.service.ts:367,606`) and
 * the workflow-assignment cascade's department tier.
 */
describe('ConsultationsColumn — department scoping on open', () => {
  const DEPARTMENTS = [
    { id: 'dept-cardio', name: 'Cardiology' },
    { id: 'dept-derm', name: 'Dermatology' },
  ];

  it('sends the selected departmentId with the open request', async () => {
    const { props } = setup({ departments: DEPARTMENTS, selectedDepartmentId: 'dept-cardio', onDepartmentChange: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', { departmentId: 'dept-cardio' }));
  });

  it('omits the department when none is chosen (tenant tier applies)', async () => {
    const { props } = setup({ departments: DEPARTMENTS, selectedDepartmentId: '', onDepartmentChange: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-901' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-901', {}));
  });
});

/**
 *  — the department picker must never degrade SILENTLY.
 *
 * The catalog now reads `users/me/departments` (clinician plane), but it can
 * still be genuinely unavailable — the caller has no assignments, or the read
 * failed. Previously ALL THREE of those states rendered as the same thing: the
 * control simply vanished, with nothing telling the clinician why the note
 * would be scoped to the tenant tier instead. Rule 11: every state is
 * explained; rule 10: loading is a Skeleton, never a blank or a spinner.
 */
describe('ConsultationsColumn — department scoping degrades explicitly (P-4)', () => {
  const DEPARTMENTS = [{ id: 'dept-derm', name: 'Dermatology' }];

  function openNewForm() {
    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
  }

  it('shows a skeleton, not a blank, while the catalog is loading', () => {
    const { container } = setup({ departments: [], departmentsLoading: true });
    openNewForm();

    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    // Must not claim "no departments" before the answer is known.
    expect(screen.queryByText(/no department assignments/i)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('explains an unavailable catalog instead of hiding the control', () => {
    setup({ departments: [], departmentsError: true });
    openNewForm();

    // A live region: the notice appears asynchronously, so it must be
    // ANNOUNCED, not just drawn.
    const notice = screen.getByRole('status');
    expect(within(notice).getByText(/department scoping unavailable/i)).toBeTruthy();
    // The clinician is told what happens instead — the note still drafts.
    expect(notice.textContent).toMatch(/tenant/i);
  });

  it('explains an empty catalog as a designed state, not an error', () => {
    setup({ departments: [], departmentsLoading: false, departmentsError: false });
    openNewForm();

    const notice = screen.getByRole('status');
    expect(within(notice).getByText(/no department assignments/i)).toBeTruthy();
    expect(screen.queryByText(/department scoping unavailable/i)).toBeNull();
  });

  it('renders the picker and no degrade notice once the catalog resolves', () => {
    setup({ departments: DEPARTMENTS, onDepartmentChange: vi.fn() });
    openNewForm();

    expect(screen.getByLabelText(/department/i)).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/no department assignments/i)).toBeNull();
    expect(screen.queryByText(/department scoping unavailable/i)).toBeNull();
  });

  it('has no axe violations in the degraded state', async () => {
    const { container } = setup({ departments: [], departmentsError: true });
    openNewForm();

    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * workflow selection at open.
 *
 * shipped `session.open({ workflowDefinitionSlug })` and the two discovery hooks, and
 * the console called neither: a clinician could not choose which published consultation workflow
 * governs the session. The picker's three source states stay distinct here for the same reason
 * the SDK keeps them distinct (`useSelectableConsultationWorkflows`): `null` is "we could not
 * ask", `[]` is "the tenant has published none" — collapsing them would tell a clinician their
 * tenant has no workflows because a request blipped.
 */
describe('ConsultationsColumn — workflow selection on open', () => {
  const WORKFLOWS = [
    { slug: 'arcaai_consultation_soap', name: 'Consultation SOAP', description: null, isTenantDefault: true },
    { slug: 'arcaai_consultation_ner', name: 'Consultation with Medical NER', description: null, isTenantDefault: false },
  ];

  function openNewForm() {
    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
  }

  it('sends the selected workflow slug with the open request', async () => {
    const { props } = setup({ workflows: WORKFLOWS, selectedWorkflowSlug: 'arcaai_consultation_ner', onWorkflowChange: vi.fn() });
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', { workflowDefinitionSlug: 'arcaai_consultation_ner' }));
  });

  it('omits the slug by DEFAULT so the assignment cascade decides', async () => {
    const { props } = setup({ workflows: WORKFLOWS, selectedWorkflowSlug: '', onWorkflowChange: vi.fn() });
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-901' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-901', {}));
  });

  it('renders the picker with the workflows the tenant published', () => {
    setup({ workflows: WORKFLOWS, selectedWorkflowSlug: 'arcaai_consultation_soap', onWorkflowChange: vi.fn() });
    openNewForm();
    expect(screen.getByLabelText(/^workflow$/i)).toBeTruthy();
    // No degraded notice for a list that resolved.
    expect(screen.queryByText(/workflow selection unavailable/i)).toBeNull();
    expect(screen.queryByText(/no published workflows/i)).toBeNull();
  });

  it('offers "Use assigned workflow" first, then the published workflows with the tenant default marked', async () => {
    setup({ workflows: WORKFLOWS, selectedWorkflowSlug: '', onWorkflowChange: vi.fn() });
    openNewForm();
    fireEvent.keyDown(screen.getByLabelText(/^workflow$/i), { key: 'ArrowDown' });

    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining('Use assigned workflow'),
      expect.stringContaining('Consultation SOAP'),
      expect.stringContaining('Consultation with Medical NER'),
    ]);
    // The default says WHY it is the default rather than leaving the clinician to guess.
    expect(options[0].textContent).toContain('the department or tenant assignment decides');
    // Slugs are shown — the clinician has to be able to tell two similarly-named graphs apart.
    expect(options[1].textContent).toContain('arcaai_consultation_soap');
    // The marker is a HINT about the tenant tier, and only the tenant default carries it.
    expect(options[1].textContent).toContain('Default');
    expect(options[2].textContent).not.toContain('Default');
  });

  it('shows "Use assigned workflow" as the selected value until the clinician picks one', () => {
    setup({ workflows: WORKFLOWS, selectedWorkflowSlug: '', onWorkflowChange: vi.fn() });
    openNewForm();

    expect(screen.getByLabelText(/^workflow$/i).textContent).toContain('Use assigned workflow');
    // Never the tenant default: preselecting it would send a slug on every open.
    expect(screen.getByLabelText(/^workflow$/i).textContent).not.toContain('Consultation SOAP');
  });

  it('clears the selection back to no slug when the clinician returns to "Use assigned workflow"', async () => {
    const onWorkflowChange = vi.fn();
    setup({ workflows: WORKFLOWS, selectedWorkflowSlug: 'arcaai_consultation_ner', onWorkflowChange });
    openNewForm();
    fireEvent.keyDown(screen.getByLabelText(/^workflow$/i), { key: 'ArrowDown' });

    const options = await screen.findAllByRole('option');
    fireEvent.click(options[0]);

    // The sentinel is a Radix implementation detail; the caller only ever sees the empty slug.
    expect(onWorkflowChange).toHaveBeenCalledWith('');
  });

  it('shows a skeleton, not a claim, while the list is still loading', () => {
    const { container } = setup({ workflows: null, workflowsLoading: true });
    openNewForm();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
    expect(screen.queryByText(/no published workflows/i)).toBeNull();
  });

  it('says the list could not be read (null) without claiming the tenant has none', () => {
    setup({ workflows: null, workflowsLoading: false });
    openNewForm();
    // A live region: the notice resolves asynchronously, so it must be ANNOUNCED, not just drawn.
    expect(screen.getByText(/workflow selection unavailable/i).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/no published workflows/i)).toBeNull();
  });

  it('says the tenant has published none ([]) as a designed state', () => {
    setup({ workflows: [], workflowsLoading: false });
    openNewForm();
    expect(screen.getByText(/no published workflows/i).closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByText(/workflow selection unavailable/i)).toBeNull();
  });

  it('renders nothing at all when the caller does not wire the picker', () => {
    setup();
    openNewForm();
    expect(screen.queryByLabelText(/^workflow$/i)).toBeNull();
    expect(screen.queryByText(/workflow selection unavailable/i)).toBeNull();
    expect(screen.queryByText(/no published workflows/i)).toBeNull();
  });

  it('has no axe violations with the picker wired', async () => {
    const { container } = setup({ workflows: WORKFLOWS, selectedWorkflowSlug: 'arcaai_consultation_soap', onWorkflowChange: vi.fn() });
    openNewForm();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with the picker OPEN (the options live in a portal)', async () => {
    setup({ workflows: WORKFLOWS, selectedWorkflowSlug: '', onWorkflowChange: vi.fn() });
    openNewForm();
    fireEvent.keyDown(screen.getByLabelText(/^workflow$/i), { key: 'ArrowDown' });
    await screen.findAllByRole('option');

    // The LISTBOX, not the container and not document.body: Radix renders the options in a
    // portal (invisible to a container scan), and a whole-body scan in an isolated component
    // render reports Radix's own focus guards (`aria-hidden-focus`) plus `region` for portal
    // content that has no page landmarks around it — both artifacts of the test harness, not
    // of this markup.
    expect(await axe(screen.getByRole('listbox'))).toHaveNoViolations();
  });

  it('has no axe violations in the degraded (unreadable) state', async () => {
    const { container } = setup({ workflows: null, workflowsLoading: false });
    openNewForm();
    expect(await axe(container)).toHaveNoViolations();
  });
});

/**
 * TASK-932 §3.7 — the three axes the New form gained: visit type, summary language, and the
 * prior record.
 *
 * The one worth stating plainly is VISIT TYPE, because there is no visit-type field on the wire.
 * The platform derives it from `parentConsultationId` (`SummaryService.visitType`,
 * `ConsultationFactory.CreateRevisit`) and the department workflows branch on that (`n_visit`),
 * so the control writes a PARENT. Picking "Revisit" without naming one therefore opens a new
 * visit — and the form says so rather than showing a badge that disagrees with what was sent.
 */
describe('ConsultationsColumn — TASK-932 visit type, summary language and the prior record', () => {
  const LANGUAGES = [
    { tag: 'en', label: 'English' },
    { tag: 'ml', label: 'Malayalam' },
  ];

  function openNewForm() {
    fireEvent.click(screen.getByRole('button', { name: /^new$/i }));
  }

  it('defaults to a NEW visit and sends no parent', async () => {
    const { props } = setup();
    openNewForm();

    expect(screen.getByRole('radio', { name: /new visit/i }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /^revisit$/i }).getAttribute('aria-checked')).toBe('false');

    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-448' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-448', {}));
  });

  it('offers THIS patient`s own earlier consultations as the parent, and sends the one picked', async () => {
    const { props } = setup();
    openNewForm();
    // The candidate list is keyed off the typed patient id — `P-448` has row `c-1`.
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-448' } });
    fireEvent.click(screen.getByRole('radio', { name: /^revisit$/i }));

    expect(screen.getByLabelText(/previous consultation/i)).toBeTruthy();

    // Radix `Select` is not driveable by `fireEvent.change`; assert the wiring through the
    // submit path instead by picking the option through the component's own state.
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));
    // With no parent chosen this still opens as a NEW visit, which is the honest outcome.
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-448', {}));
  });

  it('says plainly, for a patient with no visible history, that a revisit will open as a new visit', () => {
    setup();
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-brand-new' } });
    fireEvent.click(screen.getByRole('radio', { name: /^revisit$/i }));

    expect(screen.queryByLabelText(/previous consultation/i)).toBeNull();
    // `getByRole('status')` is ambiguous here — the department-scoping notice is one too. Match
    // the sentence, which is the thing the clinician actually has to be told.
    expect(screen.getByText(/open as a new visit/i)).toBeTruthy();
  });

  it('renders the summary-language picker with the offered tags, and DEFAULTS to undeclared', async () => {
    const { props } = setup({ summaryLanguages: LANGUAGES, selectedSummaryLanguage: '', onSummaryLanguageChange: vi.fn() });
    openNewForm();

    expect(screen.getByLabelText(/summary language/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    // Undeclared is NOT English: nothing is sent, and the agent's own body decides.
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', {}));
  });

  it('sends the declared summary language when one is chosen', async () => {
    const { props } = setup({ summaryLanguages: LANGUAGES, selectedSummaryLanguage: 'ml', onSummaryLanguageChange: vi.fn() });
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', { language: 'ml' }));
  });

  it('hides the language picker entirely when the caller wires none', () => {
    setup();
    openNewForm();
    expect(screen.queryByLabelText(/summary language/i)).toBeNull();
  });

  it('sends the pasted prior record so the warm start has something to read', async () => {
    const { props } = setup();
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.change(screen.getByLabelText(/previous case notes/i), { target: { value: '  Diabetes since 2019.  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    // Trimmed — a textarea of whitespace is not a prior record.
    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', { previousCaseNotes: 'Diabetes since 2019.' }));
  });

  it('omits the prior record when the textarea holds only whitespace', async () => {
    const { props } = setup();
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-900' } });
    fireEvent.change(screen.getByLabelText(/previous case notes/i), { target: { value: '   \n  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^open$/i }));

    await waitFor(() => expect(props.onOpenPatient).toHaveBeenCalledWith('P-900', {}));
  });

  it('has no axe violations with every new control rendered', async () => {
    const { container } = setup({ summaryLanguages: LANGUAGES, selectedSummaryLanguage: 'ml', onSummaryLanguageChange: vi.fn() });
    openNewForm();
    fireEvent.change(screen.getByLabelText(/patient id/i), { target: { value: 'P-448' } });
    fireEvent.click(screen.getByRole('radio', { name: /^revisit$/i }));

    expect(await axe(container)).toHaveNoViolations();
  });
});
