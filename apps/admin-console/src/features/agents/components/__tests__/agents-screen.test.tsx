/**
 * TASK-863/TASK-890 — Agents screen: fill-height grid over `GET /admin/agents` (this tenant's
 * own rows only — TASK-890 OD-M dropped `includeTemplates`: the SYSTEM reference set is CLONED
 * into the tenant at provisioning, never read live), the detail slide-over following the `agent`
 * param, the publish-fails-closed findings surfacing in the drawer, `?create=1` opening the
 * wizard, and the create wizard's Task → Model step over the tenant catalogue. fetch is stubbed
 * at the network boundary.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent } from '../../api/types';
import { AgentsScreen } from '../agents-screen';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SYSTEM = '00000000-0000-0000-0000-000000000000';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: null,
    task: 'TEXT_GENERATION',
    versionNumber: 2,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-llm',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    fallbacks: [],
    instruction: { systemPrompt: 'You are a scribe.' },
    parameters: { generation: { temperature: 0.2 } },
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
    version: 3,
    ...overrides,
  };
}

// TASK-890 OD-M — a2 is THIS tenant's own row (a clone the reference set made at provisioning),
// not a live SYSTEM row: `tenantId` is the caller's tenant, `sourceTenantId` names the platform
// origin. `GET admin/agents` would never return a true `tenantId === SYSTEM` row to a tenant caller.
const AGENTS: Agent[] = [
  agent(),
  agent({
    id: 'a-2',
    slug: 'clinic-transcription',
    name: 'Clinic transcription',
    sourceTenantId: SYSTEM,
    sourceSlug: 'platform-transcription',
    task: 'SPEECH_TO_TEXT',
    status: 'PUBLISHED',
    isActive: true,
    modelId: 'm-asr',
    modelSlug: 'arcaai-whisper-large-ml-en-gguf',
    compiledConfig: { task: 'SPEECH_TO_TEXT' },
    compiledConfigChecksum: 'sha256:abc',
  }),
];

/** `GET admin/ai-models/catalogue` — one "Hope provider" holding both task's models (TASK-890 §3.7). */
const CATALOGUE_MODELS = [
  { id: 'm-llm', slug: 'lms-gemma-4-e2b-it-qat', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
  { id: 'm-asr', slug: 'arcaai-whisper-large-ml-en-gguf', name: 'Whisper ML/EN', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', providerId: 'hope', provider: 'built-in', providerClass: 'platform-self-host', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null },
];

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
  ifMatch: string | null;
}
type FetchHandler = (call: RecordedCall) => Response | undefined;

function stubFetch(handler: FetchHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const call: RecordedCall = { url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined, ifMatch: headers.get('if-match') };
      calls.push(call);
      const response = handler(call);
      if (!response) throw new Error(`Unhandled fetch: ${call.method} ${call.url}`);
      return response;
    }),
  );
  return calls;
}

function session() {
  const base = { user: { id: 'u-1', username: 'root', email: 'root@hope.local', roles: ['SUPER_ADMIN'] }, isElevated: true, workingTenantId: 'tnt-1', workingTenantName: 'Sunrise Medical Group', impersonatingUserId: null, impersonatingUsername: null };
  return { ...base, effectiveUser: { ...base.user, tenantId: null, departmentId: null }, effectiveIsElevated: true, effectiveTenantId: 'tnt-1' };
}

function defaultHandler(call: RecordedCall): Response | undefined {
  const url = new URL(call.url, 'http://test.local');
  const path = url.pathname;
  if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  if (call.method !== 'GET') return undefined;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/agents') return Response.json(AGENTS);
  if (path === '/api/hope/admin/agents/a-1') return Response.json(AGENTS[0], { headers: { etag: '"3"' } });
  if (path === '/api/hope/admin/agents/a-2') return Response.json(AGENTS[1], { headers: { etag: '"1"' } });
  if (path.endsWith('/versions')) return Response.json([AGENTS[0]]);
  if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
  if (path === '/api/hope/admin/ai-models/catalogue') {
    const taskType = url.searchParams.get('taskType');
    const models = taskType ? CATALOGUE_MODELS.filter((model) => model.taskType === taskType) : CATALOGUE_MODELS;
    return Response.json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: models.length }], models });
  }
  if (path === '/api/hope/admin/consultation-context-schemas') return Response.json([]);
  if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [{ id: 'tpl-1', name: 'SOAP', status: 'APPROVED', currentVersionNumber: 1, category: 'SUMMARY' }] });
  return undefined;
}

function stubAgents(custom: FetchHandler = () => undefined): RecordedCall[] {
  return stubFetch((call) => custom(call) ?? defaultHandler(call));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AgentsScreen', () => {
  it('lists this tenant’s own agents, including its clones of the platform reference set, and never sends includeTemplates', async () => {
    const calls = stubAgents();
    renderWithProviders(<AgentsScreen />);
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    expect(screen.getByText('Clinic transcription')).toBeTruthy();
    expect(screen.getAllByText('Platform origin').length).toBeGreaterThanOrEqual(1);
    const list = calls.find((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/agents');
    expect(list?.url).not.toContain('includeTemplates');
  });

  it('opens the detail slide-over for the clicked row with the five tabs and the publish action on a draft', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />);
    fireEvent.click(await screen.findByText('Clinic summarizer'));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Clinic summarizer')).toBeTruthy();
    for (const tab of ['Overview', 'Configuration', 'Versions', 'Test run', 'Usage']) {
      expect(within(drawer).getByRole('tab', { name: tab })).toBeTruthy();
    }
    expect(await within(drawer).findByRole('button', { name: /^Publish$/ })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: /^Validate$/ })).toBeTruthy();
  });

  it('publish opens the confirm dialog; publish fails closed on a 400 with coded findings', async () => {
    const calls = stubAgents((call) => {
      if (call.method === 'POST' && call.url.endsWith('/admin/agents/a-1/publish')) {
        return Response.json({ message: 'The agent cannot be published.', code: 'MODEL_UNAVAILABLE', findings: [{ severity: 'ERROR', code: 'MODEL_UNAVAILABLE', path: 'modelId', message: 'no staged weights' }] }, { status: 400 });
      }
      return undefined;
    });
    renderWithProviders(<AgentsScreen />);
    fireEvent.click(await screen.findByText('Clinic summarizer'));
    const drawer = await screen.findByRole('dialog');
    fireEvent.click(await within(drawer).findByRole('button', { name: /^Publish$/ }));
    const confirmDialog = await screen.findByRole('dialog', { name: /Publish Clinic summarizer\?/ });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/publish'))).toBe(true));
    expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/publish'))?.body).toEqual({ activate: true });
  });

  it('an agent cloned from the platform is badged "Platform origin" but mutable like any other tenant row (OD-M — content is cloned, not read-only)', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: 'agent=a-2' });
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText('Platform origin')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Deprecate' })).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'New version' })).toBeTruthy();
  });

  it('?create=1 opens the wizard directly (the Studio’s create-agent deep link)', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: 'create=1' });
    await screen.findByText('Clinic summarizer');
    expect(await screen.findByRole('dialog', { name: 'New agent' })).toBeTruthy();
  });

  it('the create wizard walks Task → Model and lists only catalogue models of the chosen task', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />);
    await screen.findByText('Clinic summarizer');
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    const wizard = await screen.findByRole('dialog');
    fireEvent.click(within(wizard).getByLabelText('Speech-to-text'));
    fireEvent.change(within(wizard).getByLabelText(/^Name/), { target: { value: 'Ward ASR' } });
    expect((within(wizard).getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('ward-asr');
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' }));
    // Radix Select renders its options into a portal — query the document, not the dialog subtree.
    fireEvent.click(await screen.findByLabelText('Model'));
    expect(await screen.findByRole('option', { name: /Whisper ML\/EN/ })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /Gemma 4 E2B/ })).toBeNull();
  });

  it('has no axe violations on the loaded grid, nor inside the open detail slide-over (WCAG 2.2 AA gate)', async () => {
    stubAgents();
    const { container } = renderWithProviders(<AgentsScreen />);
    await screen.findByText('Clinic transcription');
    // The page with the drawer CLOSED: a Radix sheet marks everything behind it aria-hidden,
    // which axe (correctly) flags as hidden-but-focusable if scanned together.
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByText('Clinic summarizer'));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByRole('button', { name: /^Publish$/ });
    expect(await axe(drawer)).toHaveNoViolations();
  });
});
