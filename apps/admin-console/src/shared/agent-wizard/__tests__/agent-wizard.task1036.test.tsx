/**
 * TASK-1036 C5 (OD-12, D-7) — the shared agent wizard: create keeps its steps; edit branches a new
 * version, changes it and publishes WITHOUT moving the active pointer; a prompt that is not
 * APPROVED keeps the agent DRAFT with the reason on screen — nothing is ever approved for the
 * author. fetch is stubbed at the network boundary.
 */
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '@/features/agents/api';
import { AgentWizard, buildCreateRequest, buildEditPatch, stateFromAgent } from '../agent-wizard';
import { instructionToBinding } from '@/features/agents/components/instruction-binding-form';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-v2', tenantId: 't', slug: 'clinic-summary', name: 'Clinic summary', description: null, task: 'TEXT_GENERATION', versionNumber: 2,
    parentVersionId: null, sourceAgentId: null, sourceTenantId: null, sourceSlug: null, sourceVersionNumber: null, status: 'PUBLISHED', isActive: true,
    modelId: 'm-1', contextSchemaId: null, contextSchemaVersionNumber: null, modelSlug: 'gemma', fallbacks: [],
    instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 3, documentTemplate: { slug: 'soap' } },
    parameters: { generation: { temperature: 0.2, topP: 0.9 } }, inputSchema: null, outputSchema: null, tools: null, compiledConfig: null,
    compiledConfigChecksum: null, validationReport: null, validatedAt: null, publishedAt: null, deprecatedAt: null, resourceStatus: 'ENABLED',
    tags: ['dept:cardiology'], createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', createdBy: null, updatedBy: null, version: 1,
    ...overrides,
  };
}

const LINEAGE: AgentLineage = {
  slug: 'clinic-summary', name: 'Clinic summary', task: 'TEXT_GENERATION', versionCount: 2, latestVersionNumber: 2, deprecatedCount: 0,
  active: { id: 'a-v2', versionNumber: 2, publishedAt: null, publishedBy: null, modelSlug: 'gemma', compiledConfigChecksum: null },
  draft: null, assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 }, origin: { sourceTenantId: null, sourceSlug: null },
  tags: [], updatedAt: '2026-09-01T10:00:00.000Z',
};

const MODEL = {
  id: 'm-1', slug: 'gemma', name: 'Gemma', description: null, taskType: 'TEXT_GENERATION', providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served',
  readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null,
  capabilities: { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] },
};
const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 3, currentVersionNumber: 3, declaredVariables: [] };

interface Call { method: string; url: string; body: unknown }
let calls: Call[];
let publishResponse: () => Response;

beforeEach(() => {
  calls = [];
  publishResponse = () => Response.json(agent({ id: 'a-v3', versionNumber: 3, status: 'PUBLISHED', isActive: false }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const json = (value: unknown, headers: Record<string, string> = {}) => Response.json(value, { headers });
      if (url.includes('auth/session')) return json({ user: { id: 'u', roles: [] }, effectiveIsElevated: false, isElevated: false });
      if (url.includes('ai-models/catalogue')) return json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, usable: true, reason: null, modelCount: 1 }], models: [MODEL] });
      if (url.includes('admin/agents/lineages')) return json({ data: [LINEAGE], count: 1, page: 1, limit: 5 });
      if (url.includes('admin/agents/a-v2/versions') && method === 'POST') return json(agent({ id: 'a-v3', versionNumber: 3, status: 'DRAFT', isActive: false, publishedAt: null }));
      if (url.includes('admin/agents/a-v2/versions')) return json([agent()]);
      if (url.endsWith('admin/agents/a-v3') && method === 'GET') return json(agent({ id: 'a-v3', versionNumber: 3, status: 'DRAFT', isActive: false }), { ETag: '"1"' });
      if (url.endsWith('admin/agents/a-v3') && method === 'PATCH') return json(agent({ id: 'a-v3', versionNumber: 3, status: 'DRAFT', isActive: false, version: 2, parameters: (body as { parameters: object }).parameters }), { ETag: '"2"' });
      if (url.endsWith('admin/agents/a-v3/publish')) return publishResponse();
      if (url.includes('admin/prompt-templates/')) return json(TEMPLATE);
      if (url.includes('admin/prompt-templates')) return json({ data: [TEMPLATE] });
      if (url.includes('admin/document-templates')) return json([{ id: 'dt', name: 'SOAP layout', slug: 'soap', status: 'APPROVED', pinnedVersionNumber: 2, isDefault: true }]);
      if (url.includes('admin/consultation-context-schemas')) return json([]);
      return json([]);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('request builders', () => {
  it('buildCreateRequest carries the tags and the document template slug (never a version)', () => {
    const request = buildCreateRequest({
      task: 'TEXT_GENERATION', name: 'X', slug: 'x', slugTouched: true, description: '', modelId: 'm-1', fallbackModelIds: [],
      binding: { ...instructionToBinding({ systemPrompt: 'hi' }, null, null) }, initialPrompt: '', hotwords: '', labels: '', parameters: { dna: { enabled: true } },
      inputSchema: null, outputSchema: null, documentTemplateSlug: 'soap', tags: ['dept:cardiology'],
    });
    expect(request.instruction).toEqual({ systemPrompt: 'hi', documentTemplate: { slug: 'soap' } });
    expect(request.tags).toEqual(['dept:cardiology']);
    expect(request.parameters).toEqual({ dna: { enabled: true } });
  });

  it('stateFromAgent -> buildEditPatch round-trips the document template, tags and untouched parameters', () => {
    const patch = buildEditPatch(stateFromAgent(agent()));
    expect(patch.instruction).toEqual({ promptTemplateId: 'tpl-1', promptVersionNumber: 3, documentTemplate: { slug: 'soap' } });
    expect(patch.tags).toEqual(['dept:cardiology']);
    // A stored platform-managed value (topP) is carried through unchanged, never dropped by the simple editor.
    expect(patch.parameters).toEqual({ generation: { temperature: 0.2, topP: 0.9 } });
  });
});

/** The edit loader swaps its skeleton drawer for the wizard's own, so wait for the steps and re-query the dialog. */
async function openEditor() {
  await screen.findByRole('list', { name: 'Steps' });
  await screen.findByLabelText('Model');
  return screen.getByRole('dialog');
}

describe('AgentWizard edit mode', () => {
  it('shows only Model / Instruction / Settings / Review', async () => {
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).getByText(/Model/)).toBeTruthy();
    expect(within(steps).getByText(/Settings/)).toBeTruthy();
    expect(within(steps).queryByText(/Task/)).toBeNull();
    expect(within(steps).queryByText(/Input \/ Output/)).toBeNull();
  });

  it('branches a new version, saves the change, publishes WITHOUT activating, and reports the new version', async () => {
    const onCreated = vi.fn();
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={onCreated} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
    const wizard = await openEditor();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' })); // -> Instruction
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Next' })); // -> Settings
    fireEvent.change(await screen.findByLabelText('Temperature'), { target: { value: '0.5' } });
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' })); // -> Review
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Publish new version' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const [published, result] = onCreated.mock.calls[0];
    expect(published.versionNumber).toBe(3);
    expect(result).toEqual({ published: true, findings: [] });

    const branch = calls.find((call) => call.method === 'POST' && call.url.endsWith('admin/agents/a-v2/versions'));
    expect(branch).toBeTruthy();
    const patch = calls.find((call) => call.method === 'PATCH');
    expect((patch?.body as { parameters: unknown }).parameters).toEqual({ generation: { temperature: 0.5, topP: 0.9 } });
    const publishCall = calls.find((call) => call.url.endsWith('admin/agents/a-v3/publish'));
    expect(publishCall?.body).toEqual({ activate: false });
  });

  it('publishes an unchanged branch without a no-op PATCH', async () => {
    const onCreated = vi.fn();
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={onCreated} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
    const wizard = await openEditor();
    for (let index = 0; index < 3; index += 1) fireEvent.click(await within(wizard).findByRole('button', { name: 'Next' }));
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Publish new version' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('keeps the agent DRAFT and shows the blocking reason when the prompt is not APPROVED — and approves nothing', async () => {
    publishResponse = () =>
      Response.json(
        { statusCode: 400, message: 'The agent cannot be published.', error: 'Bad Request', findings: [{ severity: 'ERROR', code: 'AGENT_PROMPT_NOT_APPROVED', path: 'instruction.promptTemplateId', message: 'Prompt template "SOAP note" is not approved.' }] },
        { status: 400 },
      );
    const onCreated = vi.fn();
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={onCreated} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
    const wizard = await openEditor();
    for (let index = 0; index < 3; index += 1) fireEvent.click(await within(wizard).findByRole('button', { name: 'Next' }));
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Publish new version' }));

    const alert = await within(wizard).findByRole('alert');
    expect(alert.textContent).toMatch(/Kept as draft v3/);
    expect(alert.textContent).toMatch(/AGENT_PROMPT_NOT_APPROVED/);
    expect(alert.textContent).toMatch(/Nothing was approved for you/);
    expect(onCreated.mock.calls[0][1]).toMatchObject({ published: false });
    expect(calls.some((call) => /approve/.test(call.url))).toBe(false);
  });

  it('has no axe violations on the Settings step', async () => {
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
    const wizard = await openEditor();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Next' }));
    await screen.findByLabelText('Temperature');
    expect(await axe(wizard)).toHaveNoViolations();
  });
});

describe('AgentWizard create mode', () => {
  it('still opens on Task with the six named steps, "Settings" replacing "Parameters"', async () => {
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(steps.textContent).toMatch(/1\. Task.*4\. Settings.*6\. Review/);
    expect(await screen.findByRole('dialog', { name: 'New agent' })).toBeTruthy();
  });
});
