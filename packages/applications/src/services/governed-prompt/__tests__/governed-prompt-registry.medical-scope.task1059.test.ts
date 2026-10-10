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
import { GovernedPromptVerdict } from '@arcaai/domains';
import { pieceDigest } from '../governed-pieces';
import { GovernedPromptRegistryService } from '../governed-prompt-registry.service';
import { GuardrailPromptScreenClient, PromptScreeningUnavailableError } from '../guardrail-prompt-screen.client';
import type { GovernedPieceInput } from '../IGovernedPromptRegistry';

const TENANT = '7a000000-0000-0000-0000-000000000001';

function piece(text: string, over: Partial<GovernedPieceInput> = {}): GovernedPieceInput {
  return { kind: 'TEMPLATE_BODY', sourceType: 'AGENT', sourceId: 'agent-1', sourceKey: 'body', text, ...over };
}

const allow = { decision: 'allow', reasons: [], undetermined: false, piiRegions: new Set<string>(), quasiRegions: new Set<string>() };

function makeHarness() {
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
  const appSettings = { getValueWithDefault: vi.fn((_key: string, fallback: unknown) => fallback) };
  const service = new GovernedPromptRegistryService(repository as never, client as never, events as never, cls as never, appSettings as never);
  return { service, repository, client };
}

describe('registry — build-time medical scope judge (C-3)', () => {
  it('judges the same regions as the inbound screen, in parallel, under the tenant', async () => {
    const { service, client } = makeHarness();
    const one = piece('Write a SOAP note from the consultation transcript.');
    await service.screenAndRegister(TENANT, [one]);
    expect(client.screenRegions).toHaveBeenCalledTimes(1);
    expect(client.validateMedicalScope).toHaveBeenCalledTimes(1);
    const screened = (client.screenRegions.mock.calls[0] as unknown as [string, unknown])[1];
    expect(client.validateMedicalScope).toHaveBeenCalledWith(TENANT, screened);
    expect(screened).toEqual([{ key: pieceDigest(one.text).slice(0, 16), text: one.text }]);
  });

  it('in scope → passes, registered PASS, no finding', async () => {
    const { service, repository } = makeHarness();
    const result = await service.screenAndRegister(TENANT, [piece('Summarise the clinical findings.')]);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(repository.upsertVerdict).toHaveBeenCalledWith(expect.objectContaining({ verdict: GovernedPromptVerdict.PASS }));
  });

  it('off scope → PROMPT_SCREENING_UNSAFE with check medical_scope on the off-scope piece only, registered FAIL', async () => {
    const { service, client, repository } = makeHarness();
    const off = piece('Write a limerick about football.', { kind: 'FRAGMENT', sourceKey: 'off' });
    const on = piece('List the medications discussed.', { kind: 'FRAGMENT', sourceKey: 'on' });
    const offKey = pieceDigest(off.text).slice(0, 16);
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [offKey] });
    const result = await service.screenAndRegister(TENANT, [off, on]);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      code: 'PROMPT_SCREENING_UNSAFE',
      pieceKey: 'off',
      digest: pieceDigest(off.text),
      check: 'medical_scope',
      regions: [offKey],
    });
    // The call sites forward only `{ code, reason, digest }`: the reason itself names the check and region.
    expect(result.findings[0]!.reason).toContain('medical_scope');
    expect(result.findings[0]!.reason).toContain(offKey);
    expect(repository.upsertVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ digest: pieceDigest(off.text), verdict: GovernedPromptVerdict.FAIL }),
    );
    expect(repository.upsertVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ digest: pieceDigest(on.text), verdict: GovernedPromptVerdict.PASS }),
    );
  });

  it('off scope with no attributable region → every piece refused (fail closed)', async () => {
    const { service, client } = makeHarness();
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [] });
    const result = await service.screenAndRegister(TENANT, [piece('One.', { sourceKey: 'a' }), piece('Two.', { sourceKey: 'b' })]);
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => [finding.code, finding.check])).toEqual([
      ['PROMPT_SCREENING_UNSAFE', 'medical_scope'],
      ['PROMPT_SCREENING_UNSAFE', 'medical_scope'],
    ]);
  });

  it('no medical verdict → PROMPT_SCREENING_UNAVAILABLE, nothing registered', async () => {
    const { service, client, repository } = makeHarness();
    client.validateMedicalScope.mockRejectedValue(new PromptScreeningUnavailableError('down'));
    const result = await service.screenAndRegister(TENANT, [piece('Summarise the clinical findings.')]);
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['PROMPT_SCREENING_UNAVAILABLE']);
    expect(repository.upsertVerdict).not.toHaveBeenCalled();
  });

  it('validateAuthoredPieces (no registration) also refuses an off-scope piece', async () => {
    const { service, client } = makeHarness();
    client.validateMedicalScope.mockImplementation(async (...args: unknown[]) => ({
      isMedical: false,
      offScopeRegions: (args[1] as Array<{ key: string }>).map((region) => region.key),
    }));
    const result = await service.validateAuthoredPieces(TENANT, [piece('Tell me a joke.')]);
    expect(result.passed).toBe(false);
    expect(result.findings[0]).toMatchObject({ code: 'PROMPT_SCREENING_UNSAFE', check: 'medical_scope' });
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
