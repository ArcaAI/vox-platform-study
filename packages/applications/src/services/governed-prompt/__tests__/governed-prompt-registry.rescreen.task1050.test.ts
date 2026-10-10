/**
 * TASK-1050 W2b — TASK-1049 F2 and F11 in the governed-prompt registry.
 *
 * F2: a tenant guardrail policy change moves that tenant's policy version, voiding every verdict it held.
 * `scheduleTenantRescreen(tenant)` drops the cached version and re-screens THAT tenant's governed sources
 * (SYSTEM re-screens every tenant), coalesced, with bounded concurrency greater than one — the boot
 * backfill's one-at-a-time stays for the cold-start case only.
 *
 * F11: `validateAuthoredPieces` screens authored text that has no governed-piece row type (a workflow
 * node's prompt variables and binding templates; a DNA_ANALYSIS template before use) WITHOUT registering
 * it, fail-closed; `workflowGraphPromptPieces` / `dnaAnalysisTemplatePieces` extract the pieces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { dnaAnalysisTemplatePieces, workflowGraphPromptPieces } from '../governed-pieces';
import { GovernedPromptRegistryService } from '../governed-prompt-registry.service';
import { PromptScreeningUnavailableError } from '../guardrail-prompt-screen.client';

const TENANT = '7a000000-0000-0000-0000-000000000001';
const OTHER = '7b000000-0000-0000-0000-000000000002';
const allow = { decision: 'allow', reasons: [], undetermined: false, piiRegions: new Set<string>(), quasiRegions: new Set<string>() };

function agent(tenantId: string, id: string, content: string) {
  return { tenantId, id, compiledConfig: { resolvedPrompt: { source: 'inline', content } } };
}

function makeHarness(settings: Record<string, unknown> = {}) {
  const repository = {
    findPassing: vi.fn(async () => [] as Array<{ digest: string }>),
    upsertVerdict: vi.fn(async (input: Record<string, unknown>) => ({ id: 'row', version: 1, ...input })),
    findPublishedAgentSources: vi.fn(async () => [] as unknown[]),
    findApprovedVersionSources: vi.fn(async () => [] as unknown[]),
  };
  let inFlight = 0;
  let peak = 0;
  const client = {
    screenRegions: vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return allow as unknown;
    }),
    // TASK-1059 C-3: the build-time medical-scope judge, in scope unless a test says otherwise.
    validateMedicalScope: vi.fn(async (): Promise<unknown> => ({ isMedical: true, offScopeRegions: [] })),
    fetchPolicyVersion: vi.fn(async () => 'pv-1' as string | null),
  };
  const cls = { get: vi.fn(() => undefined), run: vi.fn(async (work: () => unknown) => work()) };
  const appSettings = { getValueWithDefault: vi.fn((key: string, fallback: unknown) => (key in settings ? settings[key] : fallback)) };
  const service = new GovernedPromptRegistryService(repository as never, client as never, { emit: vi.fn() } as never, cls as never, appSettings as never);
  return { service, repository, client, peak: () => peak };
}

describe('scheduleTenantRescreen (F2)', () => {
  afterEach(() => vi.useRealTimers());

  it('re-screens only THAT tenant`s sources, under a freshly read policy version, more than one at a time', async () => {
    const { service, repository, client, peak } = makeHarness({ 'governedPrompt.rescreenDelayMs': 0 });
    repository.findPublishedAgentSources.mockResolvedValue([agent(TENANT, 'a1', 'One.'), agent(TENANT, 'a2', 'Two.'), agent(TENANT, 'a3', 'Three.'), agent(OTHER, 'b1', 'Other.')]);
    await service.currentPolicyVersion(TENANT); // cache the version the change voided
    client.fetchPolicyVersion.mockResolvedValue('pv-2');

    service.scheduleTenantRescreen(TENANT);
    await service.drainBackground();

    const screenedTenants = repository.upsertVerdict.mock.calls.map(([input]) => (input as { tenantId: string }).tenantId);
    expect(new Set(screenedTenants)).toEqual(new Set([TENANT]));
    expect(repository.upsertVerdict).toHaveBeenCalledTimes(3);
    expect(repository.upsertVerdict.mock.calls.every(([input]) => (input as { policyVersion: string }).policyVersion === 'pv-2')).toBe(true);
    expect(peak()).toBeGreaterThan(1);
  });

  it('caps the concurrency at governedPrompt.rescreenConcurrency', async () => {
    const { service, repository, peak } = makeHarness({ 'governedPrompt.rescreenDelayMs': 0, 'governedPrompt.rescreenConcurrency': 2 });
    repository.findPublishedAgentSources.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map((id) => agent(TENANT, id, `Text ${id}.`)));
    service.scheduleTenantRescreen(TENANT);
    await service.drainBackground();
    expect(peak()).toBe(2);
  });

  it('a SYSTEM change re-screens every tenant', async () => {
    const { service, repository } = makeHarness({ 'governedPrompt.rescreenDelayMs': 0 });
    repository.findPublishedAgentSources.mockResolvedValue([agent(TENANT, 'a1', 'One.'), agent(OTHER, 'b1', 'Other.')]);
    service.scheduleTenantRescreen(SYSTEM_TENANT_ID);
    await service.drainBackground();
    expect(new Set(repository.upsertVerdict.mock.calls.map(([input]) => (input as { tenantId: string }).tenantId))).toEqual(new Set([TENANT, OTHER]));
  });

  it('waits the configured delay (guardrail drops its cache first) and coalesces a burst into one pass', async () => {
    vi.useFakeTimers();
    const { service, repository } = makeHarness({ 'governedPrompt.rescreenDelayMs': 1000 });
    service.scheduleTenantRescreen(TENANT);
    service.scheduleTenantRescreen(TENANT);
    expect(repository.findPublishedAgentSources).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    await service.drainBackground();
    expect(repository.findPublishedAgentSources).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when the pass fails', async () => {
    const { service, repository } = makeHarness({ 'governedPrompt.rescreenDelayMs': 0 });
    repository.findPublishedAgentSources.mockRejectedValue(new Error('db down'));
    expect(() => service.scheduleTenantRescreen(TENANT)).not.toThrow();
    await expect(service.drainBackground()).resolves.toBeUndefined();
  });
});

describe('validateAuthoredPieces + extractors (F11)', () => {
  it('screens authored text without registering anything', async () => {
    const { service, repository, client } = makeHarness();
    const result = await service.validateAuthoredPieces(TENANT, workflowGraphPromptPieces({ nodes: [{ id: 'n1', type: 'core.agent', config: { overrides: { promptVariables: { tone: 'Write warmly.' } } } }] }, 'wf-1'));
    expect(result.passed).toBe(true);
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    expect(repository.upsertVerdict).not.toHaveBeenCalled();
  });

  it('is fail-closed: an unavailable screen is PROMPT_SCREENING_UNAVAILABLE and does not pass', async () => {
    const { service, client } = makeHarness();
    client.screenRegions.mockRejectedValue(new PromptScreeningUnavailableError('down'));
    const result = await service.validateAuthoredPieces(TENANT, dnaAnalysisTemplatePieces('Describe the style.', 'tpl-1'));
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['PROMPT_SCREENING_UNAVAILABLE']);
  });

  it('a blocking finding (PII) fails validation', async () => {
    const { service, client } = makeHarness();
    const pieces = dnaAnalysisTemplatePieces('Style of Dr Example.', 'tpl-1');
    const regionKey = (await import('../governed-pieces')).pieceDigest(pieces[0]!.text).slice(0, 16);
    client.screenRegions.mockResolvedValue({ ...allow, piiRegions: new Set([regionKey]) });
    const result = await service.validateAuthoredPieces(TENANT, pieces);
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['PROMPT_CONTAINS_PII']);
  });

  it('workflowGraphPromptPieces collects prompt variables and `{ template }` bindings, nothing else', () => {
    const pieces = workflowGraphPromptPieces(
      {
        nodes: [
          { id: 'n1', type: 'core.agent', config: { agent: { slug: 'scribe' }, overrides: { promptVariables: { tone: 'Write warmly.', empty: '' } } } },
          { id: 'n2', type: 'core.transform', config: { inputs: { note: { template: 'Summary: {{nodes.n1.outputs.text}}' }, raw: { from: 'vars.x' } } } },
          { id: 'n3', type: 'core.note', config: { text: 'A canvas comment, never compiled.' } },
        ],
      },
      'wf-1',
    );
    expect(pieces.map((piece) => [piece.sourceKey, piece.text])).toEqual([
      ['n1.promptVariables.tone', 'Write warmly.'],
      ['n2.inputs.note.template', 'Summary: {{nodes.n1.outputs.text}}'],
    ]);
    expect(pieces.every((piece) => piece.kind === 'FRAGMENT' && piece.sourceId === 'wf-1')).toBe(true);
  });

  it('dnaAnalysisTemplatePieces renders the template in pointer mode like any approved body', () => {
    const [piece] = dnaAnalysisTemplatePieces('Describe {{doctor_name}}.', 'tpl-9');
    expect(piece).toMatchObject({ kind: 'TEMPLATE_BODY', sourceType: 'PROMPT_VERSION', sourceId: 'tpl-9', sourceKey: 'body' });
    expect(piece!.text).not.toContain('{{doctor_name}}');
  });
});
