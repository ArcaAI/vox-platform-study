/**
 * TASK-1059 C-3 (owner OD-2) — prompts are judged for MEDICAL SCOPE only at build/compose time.
 *
 *  - The registry's screen calls guardrail's medical judge (`POST /api/medical/validate`,
 *    `scope: "prompt"`, every piece an `instruction` region) beside the inbound screen.
 *  - In scope → nothing changes. Off scope → the existing `PROMPT_SCREENING_UNSAFE` (blocking,
 *    registered FAIL) on the off-scope piece(s), naming `check: medical_scope` and the region key.
 *  - No verdict (5xx / timeout / malformed / skewed coverage) → `PROMPT_SCREENING_UNAVAILABLE`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GovernedPromptVerdict, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { pieceDigest, piecesFromResolvedPrompt, templateBodyPieces } from '../governed-pieces';
import { GovernedPromptRegistryService } from '../governed-prompt-registry.service';
import { GuardrailPromptScreenClient, PromptScreeningUnavailableError } from '../guardrail-prompt-screen.client';
import type { GovernedPieceInput } from '../IGovernedPromptRegistry';

const TENANT = '7a000000-0000-0000-0000-000000000001';

function piece(text: string, over: Partial<GovernedPieceInput> = {}): GovernedPieceInput {
  return { kind: 'TEMPLATE_BODY', sourceType: 'AGENT', sourceId: 'agent-1', sourceKey: 'body', text, ...over };
}

const allow = { decision: 'allow', reasons: [], undetermined: false, piiRegions: new Set<string>(), quasiRegions: new Set<string>() };

function makeHarness(settings: Record<string, unknown> = {}) {
  const repository = {
    findPassing: vi.fn(async () => [] as Array<{ digest: string }>),
    upsertVerdict: vi.fn(async (input: Record<string, unknown>) => ({ id: 'row', version: 1, ...input })),
    findPublishedAgentSources: vi.fn(async () => [] as unknown[]),
    findApprovedVersionSources: vi.fn(async () => [] as unknown[]),
  };
  const client = {
    screenRegions: vi.fn(async (): Promise<unknown> => allow),
    validateMedicalScope: vi.fn(async (): Promise<unknown> => ({ isMedical: true, offScopeRegions: [] })),
    fetchPolicyVersion: vi.fn(async () => 'pv-1' as string | null),
  };
  const events = { emit: vi.fn() };
  const store: Record<string, unknown> = { user: { id: 'user-1' }, tenantId: TENANT };
  const cls = { get: vi.fn((key: string) => store[key]), run: vi.fn(async (work: () => unknown) => work()) };
  const appSettings = { getValueWithDefault: vi.fn((name: string, fallback: unknown) => (name in settings ? settings[name] : fallback)) };
  const service = new GovernedPromptRegistryService(repository as never, client as never, events as never, cls as never, appSettings as never);
  return { service, repository, client };
}

const regionKey = (text: string) => pieceDigest(text).slice(0, 16);

describe('registry — build-time medical scope judge on AUTHORED prompts (C-3, amended)', () => {
  it('in scope → passes, registered PASS, no finding', async () => {
    const { service, repository, client } = makeHarness();
    const result = await service.screenAndRegister(TENANT, [piece('Summarise the clinical findings.')], { judgeMedicalScope: true });
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    expect(repository.upsertVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: GovernedPromptVerdict.PASS }));
  });

  it('the default (no options) never judges medical scope', async () => {
    const { service, client } = makeHarness();
    const result = await service.screenAndRegister(TENANT, [piece('Summarise the clinical findings.')]);
    expect(result.passed).toBe(true);
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
  });

  it('an authored multi-piece unit is ONE judge call over every piece of the unit — an already-PASS piece included', async () => {
    const { service, repository, client } = makeHarness();
    const body = piece('Write a SOAP note from the consultation transcript.', { kind: 'FRAGMENT', sourceKey: 'body' });
    const short = piece('Respond in English.', { kind: 'FRAGMENT', sourceKey: 'lang' });
    const known = piece('List the medications discussed.', { kind: 'FRAGMENT', sourceKey: 'meds' });
    repository.findPassing.mockResolvedValue([{ digest: pieceDigest(known.text) }]);
    await service.screenAndRegister(TENANT, [body, short, known], { judgeMedicalScope: true });
    expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    expect(client.validateMedicalScope).toHaveBeenCalledWith(TENANT, [
      { key: regionKey(body.text), text: body.text },
      { key: regionKey(short.text), text: short.text },
      { key: regionKey(known.text), text: known.text },
    ]);
    // The inbound screen still covers only what is not yet PASS.
    expect((client.screenRegions.mock.calls[0] as unknown as [string, Array<{ key: string }>])[1].map((region) => region.key)).toEqual([
      regionKey(body.text),
      regionKey(short.text),
    ]);
  });

  it('off scope → the unit is refused as a whole: PROMPT_SCREENING_UNSAFE, check medical_scope, regions = the off-scope keys', async () => {
    const { service, client, repository } = makeHarness();
    const off = piece('Write a limerick about football.', { kind: 'FRAGMENT', sourceKey: 'off' });
    const on = piece('List the medications discussed.', { kind: 'FRAGMENT', sourceKey: 'on' });
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [regionKey(off.text)] });
    const result = await service.screenAndRegister(TENANT, [off, on], { judgeMedicalScope: true });
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(2);
    for (const finding of result.findings) {
      expect(finding).toMatchObject({ code: 'PROMPT_SCREENING_UNSAFE', check: 'medical_scope', regions: [regionKey(off.text)] });
      // The call sites forward only `{ code, reason, digest }`: the reason itself names the check and the keys.
      expect(finding.reason).toContain('medical_scope');
      expect(finding.reason).toContain(regionKey(off.text));
    }
    expect(repository.upsertVerdict).toHaveBeenCalledTimes(2);
    expect(repository.upsertVerdict.mock.calls.every(([input]) => (input as { verdict: unknown }).verdict === GovernedPromptVerdict.FAIL)).toBe(true);
  });

  it('off scope with no attributable region → regions = every key of the unit (fail closed)', async () => {
    const { service, client } = makeHarness();
    const a = piece('One.', { sourceKey: 'a' });
    const b = piece('Two.', { sourceKey: 'b' });
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [] });
    const result = await service.screenAndRegister(TENANT, [a, b], { judgeMedicalScope: true });
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => [finding.code, finding.check, finding.regions])).toEqual([
      ['PROMPT_SCREENING_UNSAFE', 'medical_scope', [regionKey(a.text), regionKey(b.text)]],
      ['PROMPT_SCREENING_UNSAFE', 'medical_scope', [regionKey(a.text), regionKey(b.text)]],
    ]);
  });

  it('no medical verdict → PROMPT_SCREENING_UNAVAILABLE, nothing registered', async () => {
    const { service, client, repository } = makeHarness();
    client.validateMedicalScope.mockRejectedValue(new PromptScreeningUnavailableError('down'));
    const result = await service.screenAndRegister(TENANT, [piece('Summarise the clinical findings.')], { judgeMedicalScope: true });
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['PROMPT_SCREENING_UNAVAILABLE']);
    expect(repository.upsertVerdict).not.toHaveBeenCalled();
  });

  it('validateAuthoredPieces (no registration) judges the unit in one call and refuses off scope', async () => {
    const { service, client } = makeHarness();
    client.validateMedicalScope.mockImplementation(async (...args: unknown[]) => ({
      isMedical: false,
      offScopeRegions: (args[1] as Array<{ key: string }>).map((region) => region.key),
    }));
    const result = await service.validateAuthoredPieces(TENANT, [
      piece('Tell me a joke.', { sourceKey: 'a' }),
      piece('And another.', { sourceKey: 'b' }),
    ]);
    expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    expect(result.passed).toBe(false);
    expect(result.findings[0]).toMatchObject({ code: 'PROMPT_SCREENING_UNSAFE', check: 'medical_scope' });
  });

  it('registerPlatformPieces never calls the medical judge (platform-owned pieces are never refused for scope)', async () => {
    const { service, client, repository } = makeHarness();
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [] });
    await service.registerPlatformPieces(
      [piece('Respond in English.', { kind: 'FRAGMENT', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'lang' })],
      TENANT,
    );
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
    expect(repository.upsertVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: GovernedPromptVerdict.PASS }));
  });

  it('a platform re-registration under a new policy version (the platform rescreen) never calls the medical judge', async () => {
    const { service, client } = makeHarness();
    const platform = piece('Respond in English.', { kind: 'FRAGMENT', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'lang' });
    await service.registerPlatformPieces([platform], TENANT);
    client.fetchPolicyVersion.mockResolvedValue('pv-2');
    service.scheduleTenantRescreen(TENANT);
    await service.drainBackground();
    await service.registerPlatformPieces([platform], TENANT);
    expect(client.screenRegions).toHaveBeenCalledTimes(2);
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
  });

  it('a PLATFORM piece offered through screenAndRegister is left out of the medical judge', async () => {
    const { service, client } = makeHarness();
    const authored = piece('Write a SOAP note.', { kind: 'FRAGMENT', sourceKey: 'body' });
    const platform = piece('Respond in English.', { kind: 'FRAGMENT', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'lang' });
    await service.screenAndRegister(TENANT, [authored, platform], { judgeMedicalScope: true });
    expect(client.validateMedicalScope).toHaveBeenCalledWith(TENANT, [{ key: regionKey(authored.text), text: authored.text }]);
  });

  const compositeAgent = (tenantId: string, id: string) => ({
    tenantId,
    id,
    compiledConfig: {
      resolvedPrompt: {
        source: 'composite',
        fragments: [
          { key: 'f1', content: 'Write a SOAP note.' },
          { key: 'f2', content: 'Respond in English.' },
        ],
      },
    },
  });

  it('the tenant rescreen (published agents / approved versions) never calls the medical judge — inbound screen only', async () => {
    const { service, client, repository } = makeHarness({ 'governedPrompt.rescreenDelayMs': 0 });
    repository.findPublishedAgentSources.mockResolvedValue([compositeAgent(TENANT, 'a1')]);
    repository.findApprovedVersionSources.mockResolvedValue([{ tenantId: TENANT, promptTemplateId: 'pt-1', content: 'Write a discharge summary.' }]);
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [] });
    service.scheduleTenantRescreen(TENANT);
    await service.drainBackground();
    expect(client.screenRegions).toHaveBeenCalledTimes(2);
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
    expect(repository.upsertVerdict.mock.calls.every(([input]) => (input as { verdict: unknown }).verdict === GovernedPromptVerdict.PASS)).toBe(true);
  });

  it('the boot backfill (and its retry) never calls the medical judge — no retroactive FAIL on a published source', async () => {
    const { service, client, repository } = makeHarness({ 'governedPrompt.backfillInitialDelayMs': 0 });
    repository.findPublishedAgentSources.mockResolvedValue([compositeAgent(TENANT, 'dna-writing-style-analyst')]);
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [] });
    service.onApplicationBootstrap();
    await service.drainBackground();
    const summary = await service.runBackfill(new Set([`${TENANT}|AGENT|dna-writing-style-analyst`]));
    expect(summary.failed).toBe(0);
    expect(client.screenRegions).toHaveBeenCalled();
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
    expect(repository.upsertVerdict.mock.calls.every(([input]) => (input as { verdict: unknown }).verdict === GovernedPromptVerdict.PASS)).toBe(true);
  });

  describe('each explicit save path judges its unit once', () => {
    it('template approve (templateBodyPieces → screenAndRegister): one call', async () => {
      const { service, client } = makeHarness();
      await service.screenAndRegister(TENANT, templateBodyPieces('Write a discharge summary for {{patient}}.', 'pt-1'), { judgeMedicalScope: true });
      expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    });

    it('agent validate / publish (resolvedPrompt pieces → screenAndRegister): one call over every fragment', async () => {
      const { service, client } = makeHarness();
      const pieces = piecesFromResolvedPrompt(compositeAgent(TENANT, 'a1').compiledConfig.resolvedPrompt, { sourceType: 'AGENT', sourceId: 'a1' });
      await service.screenAndRegister(TENANT, pieces, { judgeMedicalScope: true });
      expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
      expect((client.validateMedicalScope.mock.calls[0] as unknown as [string, unknown[]])[1]).toHaveLength(2);
    });

    it('promote-to-system (screenAndRegister under SYSTEM): one call', async () => {
      const { service, client } = makeHarness();
      const pieces = piecesFromResolvedPrompt(compositeAgent(SYSTEM_TENANT_ID, 'a1').compiledConfig.resolvedPrompt, {
        sourceType: 'AGENT',
        sourceId: 'a1',
      });
      await service.screenAndRegister(SYSTEM_TENANT_ID, pieces, { judgeMedicalScope: true });
      expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
      expect(client.validateMedicalScope.mock.calls[0]![0]).toBe(SYSTEM_TENANT_ID);
    });

    it('validateAuthoredPieces: one call', async () => {
      const { service, client } = makeHarness();
      await service.validateAuthoredPieces(TENANT, [
        piece('Write a SOAP note.', { sourceKey: 'a' }),
        piece('Use bullet points.', { sourceKey: 'b' }),
      ]);
      expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    });
  });
});

describe('GuardrailPromptScreenClient.validateMedicalScope', () => {
  function client(post: ReturnType<typeof vi.fn>) {
    const http = { axiosRef: { post, get: vi.fn() } };
    const config = { get: vi.fn(() => 'http://guardrail:8863') };
    const secrets = { getSecretOptional: vi.fn(async (key: string) => (key === 'INTERNAL_ACCESS_TOKEN' ? 'svc-token' : undefined)) };
    return new GuardrailPromptScreenClient(http as never, config as never, secrets as never);
  }
  const regions = [
    { key: 'r1', text: 'Write a SOAP note.' },
    { key: 'r2', text: 'Write a poem about cars.' },
  ];

  it('posts scope "prompt" with every piece as an instruction region, the service token and the tenant', async () => {
    const post = vi.fn(async () => ({ data: { is_medical: true, screened_regions: ['r1', 'r2'] } }));
    expect(await client(post).validateMedicalScope(TENANT, regions)).toEqual({ isMedical: true, offScopeRegions: [] });
    expect(post).toHaveBeenCalledWith(
      'http://guardrail:8863/api/medical/validate',
      {
        scope: 'prompt',
        regions: [
          { key: 'r1', text: 'Write a SOAP note.', trust: 'instruction' },
          { key: 'r2', text: 'Write a poem about cars.', trust: 'instruction' },
        ],
      },
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Token': 'svc-token', 'X-Tenant-Id': TENANT }) }),
    );
  });

  it('off scope names the region_verdicts that are not medical', async () => {
    const post = vi.fn(async () => ({
      data: {
        is_medical: false,
        screened_regions: ['r1', 'r2'],
        region_verdicts: [
          { key: 'r1', is_medical: true, context_type: 'clinical', confidence: 0.9 },
          { key: 'r2', is_medical: false, context_type: 'general', confidence: 0.8 },
        ],
      },
    }));
    expect(await client(post).validateMedicalScope(TENANT, regions)).toEqual({ isMedical: false, offScopeRegions: ['r2'] });
  });

  it('a 5xx / timeout, a body without is_medical, or a region missing from screened_regions is unavailable', async () => {
    await expect(client(vi.fn(async () => Promise.reject(new Error('503')))).validateMedicalScope(TENANT, regions)).rejects.toBeInstanceOf(
      PromptScreeningUnavailableError,
    );
    await expect(
      client(vi.fn(async () => ({ data: { screened_regions: ['r1', 'r2'] } }))).validateMedicalScope(TENANT, regions),
    ).rejects.toBeInstanceOf(PromptScreeningUnavailableError);
    await expect(
      client(vi.fn(async () => ({ data: { is_medical: true, screened_regions: ['r1'] } }))).validateMedicalScope(TENANT, regions),
    ).rejects.toBeInstanceOf(PromptScreeningUnavailableError);
  });
});
