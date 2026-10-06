/**
 * TASK-1047 FC-4 — `system_governance` on the internal `/generate` body.
 *
 * Every gateway → TEXT call runs `applyEgressSafety` (through `applyTenantProviderOverrides`), so
 * that is the ONE place the field is decided:
 *
 *   - a caller-supplied `system_governance` is always dropped (it is never the caller's to state);
 *   - it is attached ONLY when the composer handed over the composed governance, the body's
 *     `system_prompt` still hashes to its `composedDigest`, and the registry vouches for EVERY piece
 *     digest under the current policy version;
 *   - an absent registry, a "no", an unknown policy version or a registry error all omit it — the
 *     call then takes the full-screening path, never a skip;
 *   - the PLATFORM / LANGUAGE / CONTRACT pieces the composer emitted are offered to
 *     `registerPlatformPieces` fire-and-forget; its failure never fails the call.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ClsService } from 'nestjs-cls';
import type { SystemGovernance } from '@arcaai/workflow-contract';
import type { IActiveUserContext } from '../../../interfaces';
import type { IGovernedPromptRegistry } from '../../governed-prompt/IGovernedPromptRegistry';
import { TextRequestEnrichmentService } from '../text-request-enrichment.service';
import { platformPiecesOf } from '../system-governance';

const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? 'tenant-a' : undefined)) } as unknown as ClsService<IActiveUserContext>;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const SYSTEM = 'PLATFORM RULES\n\nGoverned body.';

function governanceFor(system: string): SystemGovernance {
  return {
    pieces: [
      { kind: 'PLATFORM', key: 'platform-rules@1', digest: sha256('PLATFORM RULES') },
      { kind: 'TEMPLATE_BODY', key: 'body', digest: sha256('Governed body.') },
    ],
    composedDigest: sha256(system),
  };
}

function registry(overrides: Partial<Record<keyof IGovernedPromptRegistry, unknown>> = {}): IGovernedPromptRegistry {
  return {
    screenAndRegister: vi.fn(),
    areGoverned: vi.fn().mockResolvedValue(true),
    currentPolicyVersion: vi.fn().mockResolvedValue('policy-7'),
    registerPlatformPieces: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as IGovernedPromptRegistry;
}

function service(governed?: IGovernedPromptRegistry): TextRequestEnrichmentService {
  return new TextRequestEnrichmentService(cls, undefined, undefined, undefined, undefined, governed);
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('system_governance is attached only when the registry vouches for the composed system', () => {
  it('sends composed_digest, the pieces and the current policy version', async () => {
    const reg = registry();
    const body = await service(reg).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect((body as Record<string, unknown>).system_governance).toEqual({
      composed_digest: sha256(SYSTEM),
      pieces: governanceFor(SYSTEM).pieces.map(({ kind, key, digest }) => ({ kind, key, digest })),
      policy_version: 'policy-7',
    });
    expect(reg.areGoverned).toHaveBeenCalledWith('tenant-a', [sha256('PLATFORM RULES'), sha256('Governed body.')]);
    // The policy version is per tenant — asked for the REQUEST tenant.
    expect(reg.currentPolicyVersion).toHaveBeenCalledWith('tenant-a');
  });

  it('asks the registry for the tenant the caller names over the CLS one', async () => {
    const reg = registry();
    await service(reg).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
      systemGovernance: { governance: governanceFor(SYSTEM), tenantId: 'tenant-b' },
    });
    expect(reg.areGoverned).toHaveBeenCalledWith('tenant-b', expect.any(Array));
    expect(reg.currentPolicyVersion).toHaveBeenCalledWith('tenant-b');
  });

  it('omits it when no registry is wired', async () => {
    const body = await service(undefined).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
      systemGovernance: { governance: governanceFor(SYSTEM) },
    });
    expect(body).not.toHaveProperty('system_governance');
  });

  it('omits it when the registry says a piece is not governed', async () => {
    const body = await service(registry({ areGoverned: vi.fn().mockResolvedValue(false) })).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect(body).not.toHaveProperty('system_governance');
  });

  it('omits it when the composer produced no governance (pre-FC-2 composer, non-composed prompt)', async () => {
    const reg = registry();
    const body = await service(reg).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
      systemGovernance: { governance: undefined },
    });
    expect(body).not.toHaveProperty('system_governance');
    expect(reg.areGoverned).not.toHaveBeenCalled();
  });

  it('omits it when the system prompt on the body no longer hashes to the composed digest', async () => {
    const reg = registry();
    const body = await service(reg).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: `${SYSTEM} ` } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect(body).not.toHaveProperty('system_governance');
    expect(reg.areGoverned).not.toHaveBeenCalled();
  });

  it('omits it when the policy version is unknown', async () => {
    const body = await service(registry({ currentPolicyVersion: vi.fn().mockResolvedValue(null) })).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect(body).not.toHaveProperty('system_governance');
  });

  it('omits it — and still completes the call — when the registry errors', async () => {
    const body = await service(registry({ areGoverned: vi.fn().mockRejectedValue(new Error('db down')) })).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect(body).not.toHaveProperty('system_governance');
    expect(body).toMatchObject({ provider_locality: { 'lm-studio': 'local' } });
  });

  it('omits it with no tenant to ask about', async () => {
    const noTenant = { get: vi.fn(() => undefined) } as unknown as ClsService<IActiveUserContext>;
    const reg = registry();
    const body = await new TextRequestEnrichmentService(noTenant, undefined, undefined, undefined, undefined, reg).applyTenantProviderOverrides(
      { provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string },
      { systemGovernance: { governance: governanceFor(SYSTEM) } },
    );
    expect(body).not.toHaveProperty('system_governance');
  });
});

describe('a caller can never state system_governance', () => {
  it('drops a client-supplied value when no governance was composed', async () => {
    const body = await service(registry()).applyTenantProviderOverrides({
      provider: 'lm-studio',
      system_prompt: SYSTEM,
      system_governance: { composed_digest: sha256(SYSTEM), pieces: [], policy_version: 'forged' },
    } as { provider: string });
    expect(body).not.toHaveProperty('system_governance');
  });

  it('drops it on the bare egress pass too', async () => {
    const body = await service(undefined).applyEgressSafety({ system_governance: { composed_digest: 'x' } });
    expect(body).not.toHaveProperty('system_governance');
  });
});

describe('platform pieces are offered to the registry in the background', () => {
  const pieces = platformPiecesOf({ platformRules: 'PLATFORM RULES', outputLanguageName: 'English', contractParts: [{ key: 'note-inputs', text: 'Static guidance.' }] });

  it('registers the PLATFORM, LANGUAGE and CONTRACT pieces the composer emitted', async () => {
    const reg = registry();
    await service(reg).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
      systemGovernance: { governance: governanceFor(SYSTEM), platformPieces: pieces },
    });
    expect(reg.registerPlatformPieces).toHaveBeenCalledWith(pieces, 'tenant-a');
  });

  it('never fails the call when registration rejects or throws', async () => {
    const rejecting = registry({ registerPlatformPieces: vi.fn().mockRejectedValue(new Error('boom')) });
    await expect(
      service(rejecting).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
        systemGovernance: { governance: governanceFor(SYSTEM), platformPieces: pieces },
      }),
    ).resolves.toBeDefined();
    const throwing = registry({
      registerPlatformPieces: vi.fn(() => {
        throw new Error('sync boom');
      }),
    });
    await expect(
      service(throwing).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
        systemGovernance: { platformPieces: pieces },
      }),
    ).resolves.toBeDefined();
    await flush();
  });

  it('does not register an empty piece list', async () => {
    const reg = registry();
    await service(reg).applyTenantProviderOverrides({ provider: 'lm-studio', system_prompt: SYSTEM } as { provider: string }, {
      systemGovernance: { governance: governanceFor(SYSTEM), platformPieces: [] },
    });
    expect(reg.registerPlatformPieces).not.toHaveBeenCalled();
  });
});

describe('platformPiecesOf', () => {
  it('keys each piece as FC-2 names it, text carried for screening only', () => {
    expect(
      platformPiecesOf({
        platformRules: 'RULES',
        platformRulesVersion: '3',
        outputLanguageName: 'English',
        outputLanguageSentence: 'Write in English.',
        contractParts: [
          { key: 'a', text: 'A.' },
          { key: 'b', text: '' },
        ],
      }),
    ).toEqual([
      { kind: 'PLATFORM', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'platform-rules@3', text: 'RULES' },
      { kind: 'LANGUAGE', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'language:English', text: 'Write in English.' },
      { kind: 'CONTRACT', sourceType: 'PLATFORM', sourceId: null, sourceKey: 'a', text: 'A.' },
    ]);
  });

  it('omits what the composer did not emit', () => {
    expect(platformPiecesOf({ platformRules: '', outputLanguageName: null, contractParts: [] })).toEqual([]);
  });
});
