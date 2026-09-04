/**
 * TASK-863 — Agents screen: fill-height grid over `GET /admin/agents?includeTemplates=true`
 * (tenant rows + SYSTEM templates), the detail slide-over following the `agent` param, the
 * publish-fails-closed findings surfacing in the drawer, and the create wizard's task → model
 * filtering. fetch is stubbed at the network boundary.
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
    status: 'DRAFT',
    isActive: false,
    modelId: 'm-llm',
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

const AGENTS: Agent[] = [
  agent(),
  agent({ id: 'sys-1', tenantId: SYSTEM, slug: 'platform-transcription', name: 'Platform transcription', task: 'SPEECH_TO_TEXT', status: 'PUBLISHED', isActive: true, modelId: 'm-asr', modelSlug: 'arcaai-whisper-large-ml-en-gguf', compiledConfig: { task: 'SPEECH_TO_TEXT' }, compiledConfigChecksum: 'sha256:abc' }),
];

const MODELS = [
  { id: 'm-llm', name: 'Gemma 4 E2B', slug: 'lms-gemma-4-e2b-it-qat', taskType: 'TEXT_GENERATION', provider: 'lm-studio', resourceStatus: 'ENABLED', tenantId: SYSTEM },
  { id: 'm-asr', name: 'Whisper ML/EN', slug: 'arcaai-whisper-large-ml-en-gguf', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', provider: 'built-in', resourceStatus: 'ENABLED', tenantId: SYSTEM },
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
  const path = new URL(call.url, 'http://test.local').pathname;
  if (call.url.includes('/users/me/settings')) return call.method === 'GET' ? Response.json([]) : Response.json({ ok: true });
  if (call.method !== 'GET') return undefined;
  if (path === '/api/auth/session') return Response.json(session());
  if (path === '/api/hope/admin/agents') return Response.json(AGENTS);
  if (path === '/api/hope/admin/agents/a-1') return Response.json(AGENTS[0], { headers: { etag: '"3"' } });
  if (path === '/api/hope/admin/agents/sys-1') return Response.json(AGENTS[1], { headers: { etag: '"1"' } });
  if (path.endsWith('/versions')) return Response.json([AGENTS[0]]);
  if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
  if (path === '/api/hope/admin/ai-models') return Response.json(MODELS);
  if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [{ id: 'tpl-1', name: 'SOAP', status: 'APPROVED', currentVersionNumber: 1 }] });
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
  it('lists the tenant agents and the platform templates, one row per version, with task/status/owner', async () => {
    const calls = stubAgents();
    renderWithProviders(<AgentsScreen />);
    expect(await screen.findByText('Clinic summarizer')).toBeTruthy();
    expect(screen.getByText('Platform transcription')).toBeTruthy();
    expect(screen.getAllByText('Platform').length).toBeGreaterThanOrEqual(1);
    const list = calls.find((call) => new URL(call.url, 'http://test.local').pathname === '/api/hope/admin/agents');
    expect(list?.url).toContain('includeTemplates=true');
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

  it('publish fails closed: a 400 with coded findings is surfaced, nothing pretends to be published', async () => {
    const { toast } = await import('sonner');
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
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('MODEL_UNAVAILABLE')));
    expect(calls.some((call) => call.method === 'POST' && call.url.endsWith('/publish'))).toBe(true);
    expect(calls.find((call) => call.method === 'POST' && call.url.endsWith('/publish'))?.body).toEqual({ activate: true });
  });

  it('the platform template offers "Branch as my agent" and never Publish/Deprecate', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />, { searchParams: 'agent=sys-1' });
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByRole('button', { name: 'Branch as my agent' })).toBeTruthy();
    expect(within(drawer).queryByRole('button', { name: /^Publish$/ })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: 'Deprecate' })).toBeNull();
  });

  it('the create wizard walks Task → Model and lists only registry models of the chosen task', async () => {
    stubAgents();
    renderWithProviders(<AgentsScreen />);
    await screen.findByText('Clinic summarizer');
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    const wizard = await screen.findByRole('dialog');
    fireEvent.click(within(wizard).getByLabelText('Speech-to-text'));
    fireEvent.change(within(wizard).getByLabelText(/^Name/), { target: { value: 'Ward ASR' } });
    expect((within(wizard).getByLabelText(/^Slug/) as HTMLInputElement).value).toBe('ward-asr');
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' }));
    expect(await within(wizard).findByText('Whisper ML/EN')).toBeTruthy();
    expect(within(wizard).queryByText('Gemma 4 E2B')).toBeNull();
    expect(within(wizard).getByText('Weights not staged')).toBeTruthy();
  });

  it('has no axe violations on the loaded grid, nor inside the open detail slide-over (WCAG 2.2 AA gate)', async () => {
    stubAgents();
    const { container } = renderWithProviders(<AgentsScreen />);
    await screen.findByText('Platform transcription');
    // The page with the drawer CLOSED: a Radix sheet marks everything behind it aria-hidden,
    // which axe (correctly) flags as hidden-but-focusable if scanned together.
    expect(await axe(container)).toHaveNoViolations();
    fireEvent.click(screen.getByText('Clinic summarizer'));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByRole('button', { name: /^Publish$/ });
    expect(await axe(drawer)).toHaveNoViolations();
  });
});
