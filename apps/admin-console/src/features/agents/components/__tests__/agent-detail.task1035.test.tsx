/**
 * The agent detail names the schema `{{context.*}}` actually resolves against — its own, or the one
 * a workflow lends it — read-only and badged when inherited; and the draft editor shows publish
 * findings at the field they name.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '../../api/types';
import { AgentLineageDrawer } from '../agent-detail';

const SCHEMAS = [{ id: 'schema-1', slug: 'visit', name: 'Visit context', status: 'PUBLISHED', pinnedVersionNumber: 2, isDefault: true }];
const VERSIONS = [
  {
    id: 'v2',
    schemaId: 'schema-1',
    versionNumber: 2,
    definition: { kinds: [{ key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { type: 'object', properties: { age: {} } } }] },
  },
];

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const INLINE_INSTRUCTION = { systemPrompt: 'Summarise {{context.patient.age}}' };

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 1,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-1',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma',
    fallbacks: [],
    instruction: INLINE_INSTRUCTION,
    parameters: {},
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: null,
    compiledConfigChecksum: null,
    validationReport: null,
    validatedAt: null,
    publishedAt: null,
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

const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 3, currentVersionNumber: 3, contentPreview: 'Write a note', declaredVariables: [] };

/**
 * TASK-965 WS-4 — the drawer is keyed by the lineage SLUG, not by a version row id, so a test
 * hands it the lineage the grid would have. This folds the one fixture row into that shape.
 */
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

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(agentRow: Agent, extra: FetchHandler = () => undefined): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
      calls.push(call);
      const custom = extra(call);
      if (custom) return custom;
      const path = url.pathname;
      if (path === `/api/hope/admin/agents/${agentRow.id}`) return Response.json(agentRow, { headers: { etag: `"${agentRow.version}"` } });
      if (path === `/api/hope/admin/agents/${agentRow.id}/versions`) return Response.json([agentRow]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
      if (path === '/api/hope/admin/ai-models/catalogue') return Response.json({ providers: [], models: [] });
      if (path === '/api/hope/admin/consultation-context-schemas') return Response.json(SCHEMAS);
      if (path === '/api/hope/admin/consultation-context-schemas/schema-1/versions') return Response.json(VERSIONS);
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentLineageDrawer — effective context schema and field findings', () => {
  it('shows a workflow-inherited schema read-only with an "Inherited from workflow" badge', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, effectiveContextSchema: { id: 'schema-1', versionNumber: 2, inheritedFrom: 'workflow' } });
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    const term = await screen.findByText('Context schema');
    const value = term.nextElementSibling as HTMLElement;
    expect(await within(value).findByText('Visit context')).toBeTruthy();
    expect(within(value).getByText('v2')).toBeTruthy();
    expect(within(value).getByText('Inherited from workflow')).toBeTruthy();
  });

  it("falls back to the agent's own binding when the gateway sends no effective schema", async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, contextSchemaId: 'schema-1' });
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    const value = (await screen.findByText('Context schema')).nextElementSibling as HTMLElement;
    expect(await within(value).findByText('Visit context')).toBeTruthy();
    expect(within(value).queryByText('Inherited from workflow')).toBeNull();
  });

  it("renders a draft's publish finding at the System prompt field", async () => {
    const row = agent({
      validationReport: {
        checkedAt: '2026-09-02T10:00:00.000Z',
        blocking: true,
        findings: [{ severity: 'ERROR', code: 'PROMPT_VARIABLE_UNDECLARED', path: 'instruction', message: 'instruction.systemPrompt: `{{context.x}}` is undeclared' }],
      },
    });
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));
    const findings = await screen.findByRole('list', { name: 'Publish findings for System prompt' });
    expect(findings.textContent).toContain('is undeclared');
  });

  it('has no axe violations on the overview with an inherited schema', async () => {
    const row = agent({ status: 'PUBLISHED', isActive: true, effectiveContextSchema: { id: 'schema-1', versionNumber: 2, inheritedFrom: 'workflow' } });
    stubFetch(row);
    renderWithProviders(<AgentLineageDrawer slug="clinic-summarizer" lineage={lineageFor(row)} onOpenChange={() => undefined} />);
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('Inherited from workflow');
    expect(await axe(drawer)).toHaveNoViolations();
  });
});
