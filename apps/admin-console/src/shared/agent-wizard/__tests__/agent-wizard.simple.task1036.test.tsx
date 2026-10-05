/**
 * TASK-1036 W2 (§8.6) — the agent wizard, simplified like the draft editor.
 *
 * Owner: "a simple, friendly UI for building agents … Do not show advanced configuration." The
 * create wizard had six steps, one of them a raw "Input / Output contract" JSON editor, and its
 * Review printed the settings as JSON. Now: four steps (three when editing), the task's standard
 * inputs and outputs as a plain field table, the JSON contract only for a super admin inside one
 * collapsed section, and a Review that names models and settings in words.
 */
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderWithProviders } from '@/test/render';
import type { Agent, AgentLineage } from '@/features/agents/api';
import { AgentWizard } from '../agent-wizard';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a-v2', tenantId: 't', slug: 'clinic-summary', name: 'Clinic summary', description: null, task: 'TEXT_GENERATION', versionNumber: 2,
    parentVersionId: null, sourceAgentId: null, sourceTenantId: null, sourceSlug: null, sourceVersionNumber: null, status: 'PUBLISHED', isActive: true,
    modelId: 'm-1', contextSchemaId: null, contextSchemaVersionNumber: null, modelSlug: 'gemma', fallbacks: [],
    instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 3 },
    parameters: { generation: { temperature: 0.2, topP: 0.9 } }, inputSchema: null, outputSchema: null, tools: null, compiledConfig: null,
    compiledConfigChecksum: null, validationReport: null, validatedAt: null, publishedAt: null, deprecatedAt: null, resourceStatus: 'ENABLED',
    tags: [], createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z', createdBy: null, updatedBy: null, version: 1,
    ...overrides,
  };
}

const LINEAGE: AgentLineage = {
  slug: 'clinic-summary', name: 'Clinic summary', task: 'TEXT_GENERATION', versionCount: 2, latestVersionNumber: 2, deprecatedCount: 0,
  active: { id: 'a-v2', versionNumber: 2, publishedAt: null, publishedBy: null, modelSlug: 'gemma', compiledConfigChecksum: null },
  draft: null, assignment: { tenantDefault: false, departmentCount: 0, selectorCount: 0 }, origin: { sourceTenantId: null, sourceSlug: null },
  tags: [], updatedAt: '2026-09-01T10:00:00.000Z',
};

const CAPS = { supportsTools: false, supportsVision: false, supportsAttachments: false, voices: [], supportedGenerationParams: ['temperature', 'maxTokens'] };
const BASE_MODEL = { description: null, providerId: 'hope', provider: 'lm-studio', providerClass: 'engine-served', readiness: 'ready', readinessCheckedAt: null, readinessDetail: null, usable: true, unusableReason: null };
const MODELS = [
  { ...BASE_MODEL, id: 'm-1', slug: 'gemma', name: 'Gemma', taskType: 'TEXT_GENERATION', capabilities: CAPS },
  { ...BASE_MODEL, id: 'm-asr', slug: 'whisper-large-v3', name: 'Whisper Large v3', taskType: 'AUTOMATIC_SPEECH_RECOGNITION', capabilities: { ...CAPS, supportedGenerationParams: [] } },
];
const TEMPLATE = { id: 'tpl-1', name: 'SOAP note', status: 'APPROVED', category: 'SUMMARY', approvedVersionNumber: 3, currentVersionNumber: 3, declaredVariables: [] };

function stub({ elevated = false }: { elevated?: boolean } = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), 'http://test.local');
      const json = (value: unknown, headers: Record<string, string> = {}) => Response.json(value, { headers });
      if (url.pathname === '/api/auth/session') {
        const roles = elevated ? ['SUPER_ADMIN'] : ['TENANT_ADMIN'];
        return json({ user: { id: 'u', roles }, effectiveUser: { id: 'u', roles }, effectiveIsElevated: elevated, isElevated: elevated });
      }
      if (url.pathname.endsWith('ai-models/catalogue')) {
        const taskType = url.searchParams.get('taskType');
        const models = MODELS.filter((model) => !taskType || model.taskType === taskType);
        return json({ providers: [{ id: 'hope', group: 'hope', name: 'Hope provider', providerClass: null, usable: true, reason: null, modelCount: models.length }], models });
      }
      if (url.pathname.endsWith('admin/agents/lineages')) return json({ data: [LINEAGE], count: 1, page: 1, limit: 5 });
      if (url.pathname.endsWith('admin/agents/a-v2/versions')) return json([agent()]);
      if (url.pathname.includes('admin/prompt-templates/')) return json(TEMPLATE);
      if (url.pathname.endsWith('admin/prompt-templates')) return json({ data: [TEMPLATE] });
      if (url.pathname.endsWith('admin/document-templates')) return json([]);
      return json([]);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function createSpeechAgentToSettings() {
  renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
  const wizard = await screen.findByRole('dialog', { name: 'New agent' });
  fireEvent.click(within(wizard).getByLabelText('Speech-to-text'));
  fireEvent.change(wizard.querySelector('#agent-name') as HTMLInputElement, { target: { value: 'Ward transcription' } });
  fireEvent.click(within(wizard).getByRole('button', { name: 'Next' })); // → Model & prompt
  fireEvent.click(await screen.findByLabelText('Model'));
  fireEvent.click(await screen.findByRole('option', { name: /Whisper Large v3/ }));
  fireEvent.click(within(wizard).getByRole('button', { name: 'Next' })); // → Settings
  await within(wizard).findByText('Voice activity detection');
  return wizard;
}

async function openEditor() {
  renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} edit={{ slug: 'clinic-summary', versionNumber: 2 }} />);
  await screen.findByRole('list', { name: 'Steps' });
  await screen.findByLabelText('Model');
  return screen.getByRole('dialog');
}

describe('AgentWizard — simple by default (TASK-1036 W2)', () => {
  it('creates in four plain steps, with no "Input / Output contract" step', async () => {
    stub();
    renderWithProviders(<AgentWizard open onOpenChange={() => undefined} onCreated={() => undefined} />);
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['1. Basics', '2. Model & prompt', '3. Settings', '4. Review']);
    expect(steps.textContent).not.toMatch(/Input \/ Output/);
  });

  it('edits in three steps', async () => {
    stub();
    await openEditor();
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['1. Model & prompt', '2. Settings', '3. Review']);
  });

  it('shows a tenant admin the standard inputs and outputs as a plain table, never the JSON editors', async () => {
    stub();
    const wizard = await createSpeechAgentToSettings();
    const io = within(wizard).getByRole('region', { name: 'Inputs and outputs' });
    expect(within(io).getAllByText('Standard for this task').length).toBe(2);
    expect(within(io).getAllByRole('cell', { name: 'audio' }).length).toBeGreaterThanOrEqual(1);
    expect(within(wizard).queryByLabelText('Input schema')).toBeNull();
    expect(within(wizard).queryByText(/Input and output contract \(platform admin\)/)).toBeNull();
  });

  it('gives a super admin the JSON contract inside ONE collapsed "Input and output contract (platform admin)" section', async () => {
    stub({ elevated: true });
    const wizard = await createSpeechAgentToSettings();
    const summary = within(wizard).getByText('Input and output contract (platform admin)');
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.contains(within(wizard).getByLabelText('Input schema'))).toBe(true);
    expect(details.contains(within(wizard).getByLabelText('Output schema'))).toBe(true);
  });

  it('explains the fallback list in one line', async () => {
    stub();
    const wizard = await openEditor();
    expect(within(wizard).getByText('Used in order when the main model is unavailable. Optional.')).toBeTruthy();
  });

  it('reviews in words: the model by name and the settings as facts, never as JSON', async () => {
    stub();
    const wizard = await openEditor();
    fireEvent.click(within(wizard).getByRole('button', { name: 'Next' })); // → Settings
    fireEvent.click(await within(wizard).findByRole('button', { name: 'Next' })); // → Review
    const review = await within(wizard).findByRole('list', { name: 'Steps' });
    expect(review.textContent).toMatch(/3\. Review/);
    const modelRow = (await within(wizard).findByText('Model')).nextElementSibling;
    expect(modelRow?.textContent).toBe('Gemma');
    expect(within(wizard).getByText('Temperature').nextElementSibling?.textContent).toBe('0.2');
    expect(wizard.textContent).not.toContain('{"generation"');
    expect(wizard.textContent).not.toContain('topP');
  });

  it('has no axe violations on the Settings step', async () => {
    stub();
    const wizard = await createSpeechAgentToSettings();
    expect(await axe(wizard)).toHaveNoViolations();
  });
});
