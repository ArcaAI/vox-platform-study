/**
 * TASK-1036 W2 — the agent drawer reads like a product, not a database dump.
 *
 * Owner complaint (2026-10-05): "the agent studio is still displaying so complicated
 * configurations!" — the Overview printed raw Instruction / Parameters / Input schema / Output
 * schema / Compiled config JSON and a checksum. These cases pin the replacement: friendly summary
 * cards per task, a human field table for inputs and outputs, and ONE collapsed "Technical
 * details" disclosure that only a super admin ever sees. The draft editor and the Versions tab
 * lose the same jargon for a tenant admin.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '../../api/types';
import { AgentLineageDrawer } from '../agent-detail';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-1',
    tenantId: 'tnt-1',
    slug: 'clinic-summarizer',
    name: 'Clinic summarizer',
    description: 'Writes the visit note.',
    task: 'TEXT_GENERATION',
    versionNumber: 3,
    parentVersionId: null,
    sourceAgentId: null,
    sourceTenantId: null,
    sourceSlug: null,
    sourceVersionNumber: null,
    status: 'PUBLISHED',
    isActive: true,
    modelId: 'm-gemma',
    contextSchemaId: null,
    contextSchemaVersionNumber: null,
    modelSlug: 'lms-gemma',
    fallbacks: [],
    instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2 },
    parameters: { generation: { temperature: 0.3, topP: 0.9, seed: 7 }, dna: { enabled: true } },
    inputSchema: null,
    outputSchema: null,
    tools: null,
    compiledConfig: { model: { id: 'm-gemma', slug: 'lms-gemma' }, fallbacks: [] },
    compiledConfigChecksum: 'sha256:abc123',
    validationReport: null,
    validatedAt: '2026-09-02T10:00:00.000Z',
    publishedAt: '2026-09-03T10:00:00.000Z',
    deprecatedAt: null,
    resourceStatus: 'ENABLED',
    tags: [],
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-03T10:00:00.000Z',
    createdBy: null,
    updatedBy: '0190aaaa-0000-7000-8000-000000000001',
    version: 1,
    ...overrides,
  };
}

const ASR_PARAMETERS = {
  audioFrontEnd: { vad: { enabled: false, threshold: 0.42 }, denoise: { enabled: true, modelSlug: 'deepfilter' }, diarization: { enabled: true } },
  decoding: { languageMode: 'ml-en', beamSize: 5, temperature: 0 },
  streaming: { partialWindowSec: 15 },
};

function asrAgent(overrides: Partial<Agent> = {}): Agent {
  return agent({
    id: 'a-asr',
    slug: 'realtime-transcription',
    name: 'Realtime transcription',
    description: null,
    task: 'SPEECH_TO_TEXT',
    modelId: 'm-whisper',
    modelSlug: 'whisper-large-v3',
    fallbacks: [{ priority: 1, modelId: 'm-whisper-small', modelSlug: 'whisper-small', enabled: true }],
    instruction: {},
    parameters: ASR_PARAMETERS,
    compiledConfig: { model: { slug: 'whisper-large-v3' }, parameters: ASR_PARAMETERS },
    ...overrides,
  });
}

const CAPS = { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] };
const MODELS = [
  { id: 'm-gemma', slug: 'lms-gemma', name: 'Gemma 4 E2B', taskType: 'TEXT_GENERATION', capabilities: CAPS },
  { id: 'm-gpt', slug: 'gpt-mini', name: 'GPT mini', taskType: 'TEXT_GENERATION', capabilities: CAPS },
  { id: 'm-whisper', slug: 'whisper-large-v3', name: 'Whisper Large v3', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', capabilities: { ...CAPS, supportedGenerationParams: [] } },
  { id: 'm-whisper-small', slug: 'whisper-small', name: 'Whisper Small', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', capabilities: { ...CAPS, supportedGenerationParams: [] } },
].map((model) => ({
  ...model,
  description: null,
  providerId: 'hope',
  provider: 'lm-studio',
  providerClass: 'engine-served',
  readiness: 'ready',
  readinessCheckedAt: null,
  readinessDetail: null,
  usable: true,
  unusableReason: null,
}));

const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 2, currentVersionNumber: 2, contentPreview: 'Write a note', declaredVariables: [] };

function lineageFor(row: Agent, draft: Agent | null = null): AgentLineage {
  return {
    slug: row.slug,
    name: row.name,
    task: row.task,
    versionCount: draft ? 2 : 1,
    latestVersionNumber: draft?.versionNumber ?? row.versionNumber,
    deprecatedCount: 0,
    active: row.isActive
      ? { id: row.id, versionNumber: row.versionNumber, publishedAt: row.publishedAt, publishedBy: row.updatedBy, modelSlug: row.modelSlug, compiledConfigChecksum: row.compiledConfigChecksum }
      : null,
    draft: draft ? { id: draft.id, versionNumber: draft.versionNumber, status: draft.status as 'DRAFT' | 'VALIDATED', updatedAt: draft.updatedAt } : null,
    assignment: { tenantDefault: true, departmentCount: 0, selectorCount: 0 },
    origin: { sourceTenantId: null, sourceSlug: null },
    tags: row.tags,
    updatedAt: row.updatedAt,
    hidden: false,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubFetch(rows: Agent[], { elevated = false }: { elevated?: boolean } = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const method = init?.method ?? 'GET';
      calls.push({ url: String(input), method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      const path = url.pathname;
      if (path === '/api/auth/session') {
        const roles = elevated ? ['SUPER_ADMIN'] : ['TENANT_ADMIN'];
        return Response.json({ user: { id: 'u', roles }, effectiveUser: { id: 'u', roles }, isElevated: elevated, effectiveIsElevated: elevated });
      }
      for (const row of rows) {
        if (path === `/api/hope/admin/agents/${row.id}` && method === 'PATCH') return Response.json({ ...row, version: row.version + 1 }, { headers: { etag: `"${row.version + 1}"` } });
        if (path === `/api/hope/admin/agents/${row.id}`) return Response.json(row, { headers: { etag: `"${row.version}"` } });
        if (path === `/api/hope/admin/agents/${row.id}/versions`) return Response.json(rows);
      }
      if (path === '/api/hope/admin/ai-models/catalogue') {
        const taskType = url.searchParams.get('taskType');
        const models = MODELS.filter((model) => !taskType || model.taskType === taskType);
        return Response.json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, connectionId: null, usable: true, reason: null, modelCount: models.length }], models });
      }
      if (path === '/api/hope/admin/prompt-templates') return Response.json({ data: [TEMPLATE] });
      if (path === `/api/hope/admin/prompt-templates/${TEMPLATE.id}`) return Response.json(TEMPLATE);
      if (path === '/api/hope/admin/document-templates') return Response.json([{ id: 'dt-1', slug: 'soap-letter', name: 'SOAP letter', status: 'APPROVED' }]);
      if (path === '/api/hope/admin/agent-assignments') return Response.json([]);
      if (path === '/api/hope/admin/departments') return Response.json({ data: [] });
      if (path === '/api/hope/admin/agents/tags') return Response.json([]);
      return Response.json([]);
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderDrawer(row: Agent, draft: Agent | null = null) {
  return renderWithProviders(<AgentLineageDrawer slug={row.slug} lineage={lineageFor(row, draft)} onOpenChange={() => undefined} />);
}

describe('Agent overview — a friendly summary (TASK-1036 W2)', () => {
  it('summarises a speech-to-text agent in plain words and prints no raw configuration for a tenant admin', async () => {
    stubFetch([asrAgent()]);
    renderDrawer(asrAgent());
    const drawer = await screen.findByRole('dialog');

    const settings = await within(drawer).findByRole('region', { name: 'Settings' });
    expect(within(settings).getByText('Voice activity detection').nextElementSibling?.textContent).toBe('Off');
    expect(within(settings).getByText('Noise suppression').nextElementSibling?.textContent).toBe('On');
    expect(within(settings).getByText('Speaker separation (diarization)').nextElementSibling?.textContent).toBe('On');
    expect(within(settings).getByText('Language').nextElementSibling?.textContent).toBe('Malayalam–English (code-switched)');

    const model = within(drawer).getByRole('region', { name: 'Model' });
    expect(await within(model).findByText('Whisper Large v3')).toBeTruthy();
    expect(within(model).getByText('Falls back to: Whisper Small')).toBeTruthy();

    const io = within(drawer).getByRole('region', { name: 'Inputs and outputs' });
    expect(within(io).getAllByText('Standard for this task').length).toBe(2);
    expect(within(io).getAllByRole('cell', { name: 'audio' }).length).toBeGreaterThanOrEqual(1);
    expect(within(io).getAllByRole('cell', { name: 'Audio' }).length).toBeGreaterThanOrEqual(1);

    const text = drawer.textContent ?? '';
    for (const banned of ['beamSize', 'partialWindowSec', 'Compiled config', 'sha256', 'Checksum', 'Parameters', 'Input schema', 'deepfilter', 'Technical details']) {
      expect(text).not.toContain(banned);
    }
  });

  it('summarises a text agent: the pinned library prompt as a link, and only the generation settings the model supports', async () => {
    stubFetch([agent()]);
    renderDrawer(agent());
    const drawer = await screen.findByRole('dialog');

    const prompt = await within(drawer).findByRole('region', { name: 'Prompt' });
    const link = await within(prompt).findByRole('link', { name: /SOAP note/ });
    expect(link.getAttribute('href')).toBe('/prompt-templates?template=tpl-1');
    expect(within(prompt).getByText('Pinned to v2')).toBeTruthy();

    const settings = within(drawer).getByRole('region', { name: 'Settings' });
    expect(await within(settings).findByText('Temperature')).toBeTruthy();
    expect(within(settings).getByText('Temperature').nextElementSibling?.textContent).toBe('0.3');
    expect(within(settings).queryByText('Max output tokens')).toBeNull();
    expect(within(settings).getByText("Clinician's writing style (DNA)").nextElementSibling?.textContent).toBe('On');
    expect(within(settings).getByText('Structured output').nextElementSibling?.textContent).toBe('Plain text');

    const text = drawer.textContent ?? '';
    expect(text).not.toContain('topP');
    expect(text).not.toContain('seed');
    expect(text).not.toContain('promptTemplateId');
  });

  it('previews an inline instruction and expands it on "Show full"', async () => {
    const long = `You are a careful clinical scribe. ${'Keep every finding. '.repeat(20)}End of instruction.`;
    const row = agent({ instruction: { systemPrompt: long } });
    stubFetch([row]);
    renderDrawer(row);
    const prompt = await screen.findByRole('region', { name: 'Prompt' });
    expect(within(prompt).getByText('Inline instruction')).toBeTruthy();
    expect(prompt.textContent).not.toContain('End of instruction.');
    fireEvent.click(within(prompt).getByRole('button', { name: 'Show full' }));
    expect(prompt.textContent).toContain('End of instruction.');
  });

  it('gives a super admin ONE collapsed "Technical details" disclosure holding the raw configuration', async () => {
    stubFetch([asrAgent()], { elevated: true });
    renderDrawer(asrAgent());
    const drawer = await screen.findByRole('dialog');
    const summary = await within(drawer).findByText('Technical details');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.open).toBe(false);
    expect(within(details).getByLabelText('Compiled config (read-only)')).toBeTruthy();
    expect(within(details).getByText('sha256:abc123')).toBeTruthy();
    expect(drawer.querySelectorAll('details').length).toBe(1);
  });

  it('has no axe violations on the overview', async () => {
    stubFetch([asrAgent()]);
    renderDrawer(asrAgent());
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('Whisper Large v3');
    expect(await axe(drawer)).toHaveNoViolations();
  });
});

describe('Agent draft editor and versions — no jargon for a tenant admin (TASK-1036 W2)', () => {
  it('offers no input/output schema JSON editors to a tenant admin, and edits fallbacks by model name', async () => {
    const published = agent();
    const draft = agent({ id: 'a-2', versionNumber: 4, status: 'DRAFT', isActive: false, publishedAt: null, compiledConfig: null, compiledConfigChecksum: null });
    const calls = stubFetch([published, draft]);
    renderDrawer(published, draft);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit draft' }));

    await screen.findByLabelText('Temperature');
    expect(screen.queryByLabelText('Input schema')).toBeNull();
    expect(screen.queryByLabelText('Output schema')).toBeNull();

    const fallbacks = screen.getByRole('group', { name: 'Fallback models' });
    expect(within(fallbacks).getByText(/Used in order when the main model is unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')?.body as Record<string, unknown>;
    expect(patch).not.toHaveProperty('inputSchema');
    expect(patch).not.toHaveProperty('outputSchema');
  });

  it('shows the read-only draft as a summary, not as Instruction / Parameters JSON', async () => {
    const published = agent();
    const draft = agent({ id: 'a-2', versionNumber: 4, status: 'DRAFT', isActive: false, publishedAt: null, compiledConfig: null, compiledConfigChecksum: null });
    stubFetch([published, draft]);
    renderDrawer(published, draft);
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Draft' }), { button: 0 });
    const panel = await screen.findByRole('tabpanel');
    await within(panel).findByRole('button', { name: 'Edit draft' });
    expect(panel.textContent).not.toContain('"generation"');
    expect(within(panel).queryByText('Parameters')).toBeNull();
    expect(await within(panel).findByRole('region', { name: 'Settings' })).toBeTruthy();
  });

  it('lists versions without a checksum or a user id, and names the model in words', async () => {
    stubFetch([agent()]);
    renderDrawer(agent());
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Versions' }), { button: 0 });
    const list = await screen.findByRole('list', { name: 'Versions of clinic-summarizer' });
    expect(list.textContent).not.toContain('sha256');
    expect(list.textContent).not.toContain('0190aaaa');
    fireEvent.click(within(list).getByRole('button', { name: 'Show details for v3' }));
    expect(await within(list).findByText('Gemma 4 E2B')).toBeTruthy();
  });
});
