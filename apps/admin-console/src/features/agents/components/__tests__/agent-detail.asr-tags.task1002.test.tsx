/**
 * TASK-1002 lane L-F — OD-3 (3a): for speech-to-text (`SPEECH_TO_TEXT`) agents, assignment
 * selector tags are never consulted by the gateway's ASR resolution precedence (request →
 * governing workflow → department assignment → tenant default). A tagged speech-to-text
 * assignment row can therefore never be selected. The Agents screen must tell a tenant admin so
 * before they build an assignment strategy around tags that silently do nothing:
 *
 *  - a visible warning sits next to the tag-selector input for a speech-to-text agent;
 *  - the "Assign for these tags" write is blocked once tags are entered for that task, with the
 *    reason visible (never a bare disabled control);
 *  - every ALREADY-tagged assignment row for a speech-to-text agent is flagged "Never used";
 *  - none of this applies to any other task — text-generation keeps tags exactly as before.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentAssignment, AgentLineage } from '../../api/types';
import { AgentLineageDrawer } from '../agent-detail';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'ward-asr',
    name: 'Ward ASR',
    description: null,
    task: 'SPEECH_TO_TEXT',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'PUBLISHED',
    isActive: true,
    modelId: 'm-1',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'whisper-large',
    fallbacks: [],
    instruction: {},
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: '2026-09-20T10:00:00.000Z',
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:00.000Z',
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...overrides,
  };
}

const CATALOGUE = {
  providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: 1 }],
  models: [
    { id: 'm-1', slug: 'whisper-large', name: 'Whisper large', taskType: 'SPEECH_TO_TEXT', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  ],
};

function assignmentRow(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    id: 'as-1',
    tenantId: 'tnt-1',
    scope: 'DEPARTMENT',
    scopeId: 'dept-1',
    task: 'SPEECH_TO_TEXT',
    agentSlug: 'ward-asr',
    selectorTags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

/** TASK-965 WS-4 shape — the drawer is keyed by the lineage SLUG. */
function lineageFor(row: Agent): AgentLineage {
  const open = row.status === 'DRAFT' || row.status === 'VALIDATED';
  return {
    slug: row.slug,
    name: row.name,
    task: row.task,
    versionCount: 1,
    latestVersionNumber: row.versionNumber,
    deprecatedCount: row.status === 'DEPRECATED' ? 1 : 0,
    active: row.isActive
      ? { id: row.id, versionNumber: row.versionNumber, publishedAt: row.publishedAt, publishedBy: row.updatedBy, modelSlug: row.modelSlug, compiledConfigChecksum: row.compiledConfigChecksum }
      : null,
    draft: open ? { id: row.id, versionNumber: row.versionNumber, status: row.status as 'DRAFT' | 'VALIDATED', updatedAt: row.updatedAt } : null,
    assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTenantId: row.sourceTenantId, sourceSlug: row.sourceSlug },
    tags: row.tags,
    updatedAt: row.updatedAt,
    hidden: false,
  };
}

/** A recorded write against `admin/agent-assignments`, for the department-write tests below. */
interface RecordedWrite {
  method: string;
  body: Record<string, unknown>;
  ifMatch: string | null;
}

function stubFetch(rows: Agent[], assignments: AgentAssignment[] = [], writes: RecordedWrite[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input), 'http://test.local').pathname;
      const method = init?.method ?? 'GET';
      // POST creates the tenant/department row; PATCH (If-Match) updates an existing one — both
      // land on the same collection path, distinguished only by method (mirrors client.ts).
      if (path === '/api/hope/admin/agent-assignments' && (method === 'POST' || method === 'PATCH')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers as HeadersInit | undefined);
        const ifMatch = headers.get('if-match');
        writes.push({ method, body, ifMatch });
        const version = typeof body.expectedVersion === 'number' ? body.expectedVersion + 1 : 1;
        return Response.json({ id: 'as-written', version, ...body }, { headers: { etag: `"${version}"` } });
      }
      for (const row of rows) {
        if (path === `/api/hope/admin/agents/${row.id}`) return Response.json(row, { headers: { etag: `"${row.version}"` } });
        if (path === `/api/hope/admin/agents/${row.id}/versions`) return Response.json(rows);
      }
      if (path === '/api/hope/admin/agent-assignments') return Response.json(assignments);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [{ id: 'dept-1', name: 'Radiology' }] });
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json(CATALOGUE);
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [] });
      throw new Error(`Unhandled fetch: ${method} ${path}`);
    }),
  );
}

// Radix Select scrolls the highlighted item into view on open; happy-dom has no layout engine.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('AgentLineageDrawer — ASR agents ignore assignment tags (TASK-1002 OD-3 3a)', () => {
  it('a speech-to-text agent: typing tags shows the warning and disables the assign button with a visible reason', async () => {
    const row = agent();
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="ward-asr" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    // The warning is visible for a speech-to-text agent even before any tag is typed.
    const warning = await within(drawer).findByText(/speech-to-text assignments ignore tags/i);
    expect(warning).toBeTruthy();

    const input = within(drawer).getByLabelText('Tag selector (optional)');
    fireEvent.change(input, { target: { value: 'lang:en,speciality:radiology' } });

    const assignButton = await within(drawer).findByRole('button', { name: 'Assign for these tags' });
    expect(assignButton.hasAttribute('disabled')).toBe(true);
    // The reason is visible text, not only a hover tooltip — the same warning paragraph the
    // button's aria-describedby points at.
    expect(assignButton.getAttribute('aria-describedby')).toContain('assignment-selector-stt-warning');
    expect(within(drawer).getByText(/assign this agent to a department instead/i)).toBeTruthy();
  });

  it('a text-generation agent: typing tags shows no warning and the assign button stays enabled', async () => {
    const row = agent({ task: 'TEXT_GENERATION', slug: 'clinic-summarizer', name: 'Clinic summarizer', modelSlug: 'lms-gemma', instruction: { initialPrompt: 'Write a note' } });
    stubFetch([row]);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    expect(within(drawer).queryByText(/speech-to-text assignments ignore tags/i)).toBeNull();

    const input = within(drawer).getByLabelText('Tag selector (optional)');
    fireEvent.change(input, { target: { value: 'specialty:rheumatology' } });

    const assignButton = await within(drawer).findByRole('button', { name: 'Assign for these tags' });
    expect(assignButton.hasAttribute('disabled')).toBe(false);
    expect(assignButton.getAttribute('aria-describedby')).toBeNull();
  });

  it('an existing tagged assignment row for a speech-to-text agent is flagged "Never used"', async () => {
    const row = agent();
    const tagged = assignmentRow({ id: 'as-tagged', scope: 'DEPARTMENT', scopeId: 'dept-1', selectorTags: ['lang:en', 'speciality:radiology'] });
    stubFetch([row], [tagged]);
    renderWithProviders(<AgentLineageDrawer slug="ward-asr" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    const list = await within(drawer).findByRole('list', { name: 'Assignments for this task' });
    expect(within(list).getByText('Never used')).toBeTruthy();
  });

  it('an untagged assignment row for a speech-to-text agent carries no "Never used" flag', async () => {
    const row = agent();
    const untagged = assignmentRow({ id: 'as-plain', scope: 'DEPARTMENT', scopeId: 'dept-1', selectorTags: [] });
    stubFetch([row], [untagged]);
    renderWithProviders(<AgentLineageDrawer slug="ward-asr" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    const list = await within(drawer).findByRole('list', { name: 'Assignments for this task' });
    expect(within(list).queryByText('Never used')).toBeNull();
  });
});

describe('AgentLineageDrawer — assigning an agent to a department (TASK-1002 follow-up)', () => {
  it('selecting a department and assigning POSTs scope: DEPARTMENT with the right scopeId', async () => {
    const row = agent();
    const writes: RecordedWrite[] = [];
    stubFetch([row], [], writes);
    renderWithProviders(<AgentLineageDrawer slug="ward-asr" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    const trigger = await within(drawer).findByLabelText('Department');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'Radiology' }));

    const assignButton = await within(drawer).findByRole('button', { name: 'Assign to Radiology' });
    fireEvent.click(assignButton);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('POST');
    expect(writes[0].body).toMatchObject({ scope: 'DEPARTMENT', scopeId: 'dept-1', task: 'SPEECH_TO_TEXT', agentSlug: 'ward-asr' });
    // No existing row for this department — a create carries no If-Match.
    expect(writes[0].ifMatch).toBeNull();
  });

  it('an existing department row for this task is PATCHed with its own etag', async () => {
    const row = agent();
    const existing = assignmentRow({ id: 'as-existing', scope: 'DEPARTMENT', scopeId: 'dept-1', agentSlug: 'other-agent', selectorTags: [], version: 3 });
    const writes: RecordedWrite[] = [];
    stubFetch([row], [existing], writes);
    renderWithProviders(<AgentLineageDrawer slug="ward-asr" lineage={lineageFor(row)} onOpenChange={vi.fn()} />);

    const drawer = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(drawer).getByRole('tab', { name: 'Assignments' }), { button: 0 });

    const trigger = await within(drawer).findByLabelText('Department');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('option', { name: 'Radiology' }));

    // The row currently serves a DIFFERENT agent, so the button offers to take it over rather
    // than reading "Is assigned".
    const assignButton = await within(drawer).findByRole('button', { name: 'Assign to Radiology' });
    fireEvent.click(assignButton);

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].ifMatch).toBe('"3"');
    expect(writes[0].body).toMatchObject({ scope: 'DEPARTMENT', scopeId: 'dept-1', task: 'SPEECH_TO_TEXT', agentSlug: 'ward-asr', expectedVersion: 3 });
  });
});
