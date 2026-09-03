/**
 * AiRoutingPolicyEntityMapper — round-trip tests
 *
 * Mirrors the `AiTaskDefaultEntityMapper` suite, plus the one assertion this
 * model needs that the others do not: `_version` is stripped from both write
 * paths while `policyVersion` SURVIVES them. The two are different counters —
 * the OCC guard must remove exactly one of them.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { AiRoutingPolicyEntityMapper } from '../AiRoutingPolicyEntityMapper';
import { AiRoutingPolicy } from '../../../../models/generated/core/AiRoutingPolicyModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { AiRoutingPolicyStatus } from '../../../../enums/generated/AiRoutingPolicyStatus';
import { AiRoutingStrategy } from '../../../../enums/generated/AiRoutingStrategy';
import { AiExplicitProviderMode } from '../../../../enums/generated/AiExplicitProviderMode';

const CANDIDATES = [
  { rank: 0, weight: 100, connectionRef: 'vllm-inhouse', model: 'qwen3-32b-med', residency: 'IN_CLUSTER', baaCovered: true, maxTtftMs: 1500 },
  { rank: 1, weight: 100, connectionRef: 'azure-openai-eastus', model: 'gpt-4o', residency: 'AZURE_US', baaCovered: true },
];

const sampleRow = (overrides: Partial<AiRoutingPolicy> = {}): AiRoutingPolicy =>
  new AiRoutingPolicy({
    id: 'arp-1',
    tenantId: 't-1',
    taskKey: 'text.finalize',
    policyVersion: 7,
    status: AiRoutingPolicyStatus.ACTIVE,
    strategy: AiRoutingStrategy.PRIORITY,
    explicitProviderMode: AiExplicitProviderMode.STRICT,
    priority: 0,
    killSwitch: false,
    matchJson: { models: ['gpt-4o-class'], metadata: { phi: 'true' }, maxContextTokens: 128000 },
    candidatesJson: CANDIDATES,
    fallbackJson: { maxDepth: 2, triggers: ['CONNECT_ERROR', 'TIMEOUT'], requireBaaCovered: true, crossFundingAllowed: false },
    healthJson: { consecutiveFailures: 5, rateLimit: { treatAs: 'BACKOFF_NOT_OUTAGE', maxBackoffRetries: 2 } },
    maxConcurrentStreams: 8,
    requestsPerMinute: null,
    tokensPerMinute: null,
    affinityJson: null,
    supersedesVersion: 6,
    activatedAt: new Date('2026-08-29T00:00:00.000Z'),
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 4,
    metaData: null,
    ...overrides,
  } as AiRoutingPolicy);

describe('AiRoutingPolicyEntityMapper', () => {
  const mapper = new AiRoutingPolicyEntityMapper();

  it('toDomainEntity carries the core fields + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.taskKey).toBe('text.finalize');
    expect(entity.status).toBe(AiRoutingPolicyStatus.ACTIVE);
    expect(entity.explicitProviderMode).toBe(AiExplicitProviderMode.STRICT);
    expect(entity.policyVersion).toBe(7);
    expect(entity.supersedesVersion).toBe(6);
    expect(entity.version).toBe(4);
  });

  it('round-trips the JsonB structures intact through entity → persistence', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.candidatesJson).toEqual(CANDIDATES);

    const persisted = mapper.toPersistence(entity);
    expect(persisted.candidatesJson).toEqual(CANDIDATES);
    expect(persisted.matchJson).toEqual({ models: ['gpt-4o-class'], metadata: { phi: 'true' }, maxContextTokens: 128000 });
    expect(persisted.fallbackJson).toMatchObject({ maxDepth: 2, crossFundingAllowed: false });
    expect(persisted.healthJson).toMatchObject({ consecutiveFailures: 5 });
  });

  it('toPersistence (full insert path) does not write `version` but DOES write `policyVersion`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 } as Partial<AiRoutingPolicy>));
    const persisted = mapper.toPersistence(entity);
    expect(persisted).not.toHaveProperty('version');
    // The authored revision is real data and must survive the strip.
    expect(persisted.policyVersion).toBe(7);
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { policyVersion: 8, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ policyVersion: 8 });
  });
});
