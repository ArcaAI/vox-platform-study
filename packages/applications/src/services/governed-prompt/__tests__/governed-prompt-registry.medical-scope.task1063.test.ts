/**
 * TASK-1063 item 3 — the build-time medical-scope judge sees ONLY the text the tenant authored.
 * The output-language policy fragment, language/contract pieces and platform pieces are template- or
 * platform-supplied and never go to the medical judge (the inbound screen still screens every piece).
 */
import { describe, expect, it, vi } from 'vitest';
import { OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY } from '@arcaai/types';
import { pieceDigest } from '../governed-pieces';
import { GovernedPromptRegistryService } from '../governed-prompt-registry.service';
import type { GovernedPieceInput } from '../IGovernedPromptRegistry';

const TENANT = '7a000000-0000-0000-0000-000000000001';
const regionKey = (text: string) => pieceDigest(text).slice(0, 16);

function piece(text: string, over: Partial<GovernedPieceInput> = {}): GovernedPieceInput {
  return { kind: 'FRAGMENT', sourceType: 'AGENT', sourceId: 'agent-1', sourceKey: 'clinical_note', text, ...over };
}

function makeHarness() {
  const repository = {
    findPassing: vi.fn(async () => [] as Array<{ digest: string }>),
    upsertVerdict: vi.fn(async (input: Record<string, unknown>) => ({ id: 'row', version: 1, ...input })),
  };
  const client = {
    screenRegions: vi.fn(async (): Promise<unknown> => ({ decision: 'allow', reasons: [], undetermined: false, piiRegions: new Set<string>(), quasiRegions: new Set<string>() })),
    validateMedicalScope: vi.fn(async (): Promise<unknown> => ({ isMedical: true, offScopeRegions: [] })),
    fetchPolicyVersion: vi.fn(async () => 'pv-1' as string | null),
  };
  const store: Record<string, unknown> = { user: { id: 'user-1' }, tenantId: TENANT };
  const cls = { get: vi.fn((key: string) => store[key]), run: vi.fn(async (work: () => unknown) => work()) };
  const appSettings = { getValueWithDefault: vi.fn((_n: string, fallback: unknown) => fallback) };
  const service = new GovernedPromptRegistryService(repository as never, client as never, { emit: vi.fn() } as never, cls as never, appSettings as never);
  return { service, client };
}

describe('registry — medical judge sees authored text only (TASK-1063 item 3)', () => {
  const instruction = piece('Write the clinical note from the transcript.');
  const policy = piece('Write the note in English regardless of the spoken language.', { sourceKey: OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY });

  it('an instruction plus the output-language policy sends only the instruction to the judge; the inbound screen still gets both', async () => {
    const { service, client } = makeHarness();
    await service.screenAndRegister(TENANT, [instruction, policy], { judgeMedicalScope: true });
    expect(client.validateMedicalScope).toHaveBeenCalledWith(TENANT, [{ key: regionKey(instruction.text), text: instruction.text }]);
    expect((client.screenRegions.mock.calls[0] as unknown[])[1]).toHaveLength(2);
  });

  it('LANGUAGE and CONTRACT pieces are not judged either', async () => {
    const { service, client } = makeHarness();
    const language = piece('Respond in English.', { kind: 'LANGUAGE', sourceKey: 'lang' });
    const contract = piece('Return JSON.', { kind: 'CONTRACT', sourceKey: 'contract' });
    await service.screenAndRegister(TENANT, [instruction, language, contract], { judgeMedicalScope: true });
    expect(client.validateMedicalScope).toHaveBeenCalledWith(TENANT, [{ key: regionKey(instruction.text), text: instruction.text }]);
  });

  it('off-scope attribution names the authored key only, never the policy piece', async () => {
    const { service, client } = makeHarness();
    client.validateMedicalScope.mockResolvedValue({ isMedical: false, offScopeRegions: [regionKey(instruction.text)] });
    const result = await service.screenAndRegister(TENANT, [instruction, policy], { judgeMedicalScope: true });
    expect(result.passed).toBe(false);
    const unsafe = result.findings.filter((f) => f.code === 'PROMPT_SCREENING_UNSAFE');
    expect(unsafe.every((f) => f.regions?.join() === regionKey(instruction.text))).toBe(true);
    expect(unsafe.some((f) => f.pieceKey === OUTPUT_LANGUAGE_POLICY_FRAGMENT_KEY)).toBe(false);
  });

  it('a unit with no authored text skips the medical call', async () => {
    const { service, client } = makeHarness();
    const result = await service.screenAndRegister(TENANT, [policy], { judgeMedicalScope: true });
    expect(result.passed).toBe(true);
    expect(client.validateMedicalScope).not.toHaveBeenCalled();
  });
});
