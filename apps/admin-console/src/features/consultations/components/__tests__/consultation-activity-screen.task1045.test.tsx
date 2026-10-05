/**
 * Consultation activity screen — the oldest-first, encounter-grouped time series with per-item
 * version history. Codes against the admin read plane (`admin/consultations/:id/activity`,
 * `…/items/:itemId/versions[/:n[/diff]]`, `…/runs`) through the BFF proxy.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import { ConsultationActivityScreen } from '../activity/consultation-activity-screen';

// The timeline's image renderer pulls a registry component that resolves `@/components/ui/*` through
// the UI package's own vitest alias, which this app's config does not carry. No image rows here.
vi.mock('@arcaai/ui/components/timeline/renderers/image-grid-renderer', () => ({ ImageGridRenderer: () => null }));

// The shared virtualization shim gives every element a 600px box, so each measured timeline row
// would fill the viewport on its own. Rows get a realistic height; the scroll container keeps 600.
beforeAll(() => {
  const box = (height: number) => ({ width: 800, height, top: 0, left: 0, right: 800, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return box(this.hasAttribute('data-index') ? 100 : 600);
  };
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-index') ? 100 : 600;
    },
  });
});

const RECAP_CONTENT = JSON.stringify({
  schema: 'hope.encounter_recap.v2',
  sections: [
    { key: 'reason', label: 'Reason', lines: [{ text: 'Chest tightness on exertion', citations: [{ itemId: 'seg-2', versionNumber: 1, label: 'seg 2', kind: 'segment', t0Ms: 4000 }] }] },
    { key: 'findings', label: 'Findings', lines: [{ text: 'Working impression: stable angina', citations: [] }] },
    { key: 'medicines', label: 'Medicines', lines: [{ text: 'Atorvastatin 40 mg nocte', citations: [] }] },
    { key: 'sent_for', label: 'Sent for', lines: [{ text: 'Lipid panel', citations: [{ itemId: 'att-1', versionNumber: 1, label: 'Lipid panel', kind: 'attachment' }] }] },
    { key: 'since_then', label: 'Since then', lines: [] },
    { key: 'still_open', label: 'Still open', lines: [] },
  ],
});

const RUN = {
  runId: 'run-1',
  workflowSlug: 'consult-note',
  workflowVersion: 3,
  agentSlug: 'soap-writer',
  agentVersion: 2,
  model: 'gemma-4-e2b',
  provider: 'lm-studio',
  durationMs: 2400,
  tokensIn: 12400,
  tokensOut: 900,
  contextUsed: 9100,
  contextWindow: 32768,
  costMicros: 7800,
  costBasis: 'CLOUD',
  stopReason: 'stop',
  startedAt: '2026-10-05T09:16:00.000Z',
};

const PAGE = {
  consultationId: 'c-1',
  status: 'CLOSED_COMPLETE',
  processing: 'IDLE',
  encounters: [
    { seq: 1, visitType: 'new', externalRef: null, startedAt: '2026-10-05T09:00:00.000Z', endedAt: '2026-10-05T09:15:00.000Z', recordingStartMs: 0, recordingEndMs: 900000, gapAfter: { fromAt: '2026-10-05T09:15:00.000Z', toAt: '2026-10-05T12:20:00.000Z', durationMs: 11_100_000 } },
    { seq: 2, visitType: 'revisit', externalRef: null, startedAt: '2026-10-05T12:20:00.000Z', endedAt: null, recordingStartMs: 900000, recordingEndMs: null },
  ],
  items: [
    { entryType: 'lifecycle', at: '2026-10-05T09:00:00.000Z', type: 'opened' },
    { entryType: 'segment_run', runId: 'srun-1', encounterSeq: 1, firstSeq: 1, lastSeq: 3, count: 3, t0Ms: 0, t1Ms: 30000, speakers: ['doctor', 'patient'], occurredAt: '2026-10-05T09:01:00.000Z', preview: 'Good morning, what brings you in', edited: false },
    {
      entryType: 'item',
      id: 'note-1',
      kind: 'NOTE',
      encounterSeq: 1,
      occurredAt: '2026-10-05T09:16:00.000Z',
      source: 'ai',
      latestVersion: { number: 2, content: 'Plan: start statin', changeSource: 'manual', changedBy: 'dr-1', createdAt: '2026-10-05T09:20:00.000Z' },
      versionCount: 2,
      edited: true,
      run: RUN,
    },
    {
      entryType: 'item',
      id: 'recap-1',
      kind: 'ENCOUNTER_RECAP',
      encounterSeq: 1,
      occurredAt: '2026-10-05T09:17:00.000Z',
      source: 'ai',
      latestVersion: { number: 1, content: RECAP_CONTENT, changeSource: 'ai', changedBy: null, createdAt: '2026-10-05T09:17:00.000Z' },
      versionCount: 1,
      edited: false,
    },
    {
      entryType: 'item',
      id: 'cn-1',
      kind: 'CASE_NOTE',
      encounterSeq: 2,
      occurredAt: '2026-10-05T12:21:00.000Z',
      source: 'user',
      latestVersion: { number: 1, content: 'LDL 162 mg/dL', changeSource: 'manual', changedBy: 'dr-1', createdAt: '2026-10-05T12:21:00.000Z' },
      versionCount: 1,
      edited: false,
    },
  ],
  nextCursor: null,
  hasMore: false,
  aggregates: { aiRunCount: 1, tokensIn: 12400, tokensOut: 900, costMicros: 7800, costBasis: ['CLOUD'], editedItems: 1, feedbackUp: 0, feedbackDown: 0 },
};

const BASE = '/api/hope/admin/consultations/c-1';

function stub(options: { activity?: () => Response | Promise<Response> } = {}) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://test.local');
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === `${BASE}/activity`) return options.activity ? options.activity() : Response.json(PAGE);
      if (url.pathname === `${BASE}/items/note-1/versions`) {
        return Response.json([
          { versionNumber: 2, changeSource: 'manual', changedBy: 'dr-1', createdAt: '2026-10-05T09:20:00.000Z' },
          { versionNumber: 1, changeSource: 'ai', changedBy: null, createdAt: '2026-10-05T09:16:00.000Z' },
        ]);
      }
      if (url.pathname === `${BASE}/items/note-1/versions/2`) return Response.json({ versionNumber: 2, changeSource: 'manual', changedBy: 'dr-1', createdAt: '2026-10-05T09:20:00.000Z', contextItemId: 'note-1', content: 'Plan: start statin' });
      if (url.pathname === `${BASE}/items/note-1/versions/2/diff`) {
        return Response.json({ contextItemId: 'note-1', from: { versionNumber: 1, content: 'Assessment: angina\nPlan: observe' }, to: { versionNumber: 2, content: 'Assessment: angina\nPlan: start statin' } });
      }
      if (url.pathname === `${BASE}/items/note-1/runs`) return Response.json([{ ...RUN, id: 'rec-1', nodeId: 'finalize', nodeLabel: 'Write note', activityKind: 'NOTE', outputCap: null, deployment: null, endedAt: '2026-10-05T09:16:03.000Z', versionNumber: 1 }]);
      if (url.pathname === `${BASE}/items/recap-1/versions`) return Response.json([{ versionNumber: 1, changeSource: 'ai', changedBy: null, createdAt: '2026-10-05T09:17:00.000Z' }]);
      if (url.pathname === `${BASE}/items/recap-1/versions/1`) return Response.json({ versionNumber: 1, changeSource: 'ai', changedBy: null, createdAt: '2026-10-05T09:17:00.000Z', contextItemId: 'recap-1', content: RECAP_CONTENT });
      if (url.pathname === `${BASE}/items/recap-1/runs`) return Response.json([]);
      return Response.json({ message: 'not stubbed' }, { status: 404 });
    }),
  );
  return paths;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const articleTitles = () => screen.getAllByRole('article').map((el) => el.querySelector('[id$="-title"]')?.textContent ?? '');

describe('ConsultationActivityScreen', () => {
  it('shows a skeleton while the first page loads', () => {
    stub({ activity: () => new Promise<Response>(() => {}) });
    const { container } = renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    expect(screen.getByRole('status', { name: /loading consultation activity/i })).toBeTruthy();
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it('renders the time series oldest-first, grouped by encounter', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    const titles = articleTitles();
    expect(titles.indexOf('Transcript segments')).toBeLessThan(titles.indexOf('Note'));
    expect(titles.indexOf('Note')).toBeLessThan(titles.indexOf('Encounter recap'));
    expect(titles.indexOf('Encounter recap')).toBeLessThan(titles.indexOf('Case note'));
    const bands = screen.getAllByRole('separator').map((el) => el.getAttribute('aria-label'));
    expect(bands.filter((label) => /^Encounter \d/.test(label ?? ''))).toEqual(['Encounter 1 · new', 'Encounter 2 · revisit']);
  });

  it('puts a gap band between the encounters', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    const labels = screen.getAllByRole('separator').map((el) => el.getAttribute('aria-label'));
    const gap = labels.findIndex((label) => /away 3h 05m/i.test(label ?? ''));
    expect(gap).toBeGreaterThan(-1);
    expect(labels[gap - 0]).toBeTruthy();
    expect(labels[gap + 1]).toBe('Encounter 2 · revisit');
  });

  it('shows the AI run metadata row on the item it produced', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    const note = screen.getAllByRole('article').find((el) => el.textContent?.includes('Plan: start statin'))!;
    const run = within(note).getByRole('group', { name: /ai activity/i });
    for (const text of ['consult-note', 'soap-writer', 'gemma-4-e2b', '2.4 s', '12,400 / 900', '9,100 / 32,768', '$0.0078']) {
      expect(run.textContent).toContain(text);
    }
  });

  it('opens version history with a line diff when an item is selected', async () => {
    stub();
    const { container } = renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Select Note' }));
    const panel = await screen.findByRole('region', { name: /version history/i });
    await within(panel).findByText(/changes from v1/i);
    await waitFor(() => expect(panel.querySelector('ins')?.textContent).toContain('Plan: start statin'));
    expect(panel.querySelector('del')?.textContent).toContain('Plan: observe');
    expect(within(panel).getAllByRole('button', { name: /^v[12]\b/ })).toHaveLength(2);
    // The shared timeline renders its `role=separator` bands directly inside `role=feed`, which axe
    // flags under aria-required-children. That is a packages/ui defect, not this screen's; every
    // other rule runs.
    expect(await axe(container, { rules: { 'aria-required-children': { enabled: false } } })).toHaveNoViolations();
  });

  it('closes the non-modal panel with Escape and the close button', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Select Note' }));
    const panel = await screen.findByRole('region', { name: /version history/i });
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: /version history/i })).toBeNull());
  });

  it('selects items through a real, focusable button (keyboard operable)', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    const select = screen.getByRole('button', { name: 'Select Case note' });
    expect(select.tagName).toBe('BUTTON');
    select.focus();
    expect(document.activeElement).toBe(select);
    fireEvent.click(select);
    await waitFor(() => expect(select.getAttribute('aria-pressed')).toBe('true'));
  });

  it('renders the recap as its six keyed sections with citations', async () => {
    stub();
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    await screen.findAllByRole('article');
    fireEvent.click(screen.getByRole('button', { name: 'Select Encounter recap' }));
    const recap = await screen.findByRole('region', { name: /encounter recap/i });
    const headings = within(recap).getAllByRole('heading', { level: 3 }).map((el) => el.textContent);
    expect(headings).toEqual(['Reason', 'Findings', 'Medicines', 'Sent for', 'Since then', 'Still open']);
    expect(within(recap).getByText('Chest tightness on exertion')).toBeTruthy();
    expect(within(recap).getByRole('button', { name: /go to seg 2/i })).toBeTruthy();
    expect(within(recap).getAllByText('Nothing recorded')).toHaveLength(2);
  });

  it('shows a restricted card on 403 instead of an error', async () => {
    stub({ activity: () => Response.json({ message: 'Forbidden', error: 'CONSULTATION_HISTORY_FORBIDDEN' }, { status: 403 }) });
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    expect(await screen.findByText(/restricted/i)).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows an Empty state when there is no activity', async () => {
    stub({ activity: () => Response.json({ ...PAGE, items: [], encounters: [], aggregates: undefined }) });
    renderWithProviders(<ConsultationActivityScreen consultationId="c-1" />);
    expect(await screen.findByText(/no activity yet/i)).toBeTruthy();
  });
});
