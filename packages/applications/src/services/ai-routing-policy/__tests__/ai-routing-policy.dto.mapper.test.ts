import { describe, expect, it } from 'vitest';
import { AiRoutingPolicyFactory, AiTaskKind } from '@arcaai/domains';
import { AiRoutingPolicyDtoMapper } from '../ai-routing-policy.dto.mapper';

/**
 * the READ shape must carry re-grain.
 *
 * turned this table into one row per PROVIDER CONFIGURATION (a real
 * connection FK, a real model FK, an elected default enforced by a partial
 * unique index) but left `AiRoutingPolicyResponse` on the pre-re-grain shape,
 * so none of it was reachable over HTTP. A console cannot render "which
 * provider serves this task, and which row is the elected default" from a
 * payload that contains neither. These cases pin the widened projection.
 */
describe('AiRoutingPolicyDtoMapper.toResponse —  configuration fields', () => {
  const base = {
    tenantId: '00000000-0000-0000-0000-000000000000',
    taskKey: 'text.finalize',
  };

  it('projects the provider-configuration binding, the election and the gate inputs', () => {
    const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
      ...base,
      taskKind: AiTaskKind.TEXT_GENERATION,
      displayName: 'Azure — GPT-4o finalize',
      providerConnectionId: '01920000-0000-7000-8000-00000000c0nn',
      modelId: '01920000-0000-7000-8000-0000000m0de1',
      modelRef: 'gpt-4o-finalize-deployment',
      isDefault: true,
      enabled: true,
      residency: 'eu-west',
      baaCovered: true,
    });

    const response = AiRoutingPolicyDtoMapper.toResponse(entity);

    expect(response).toMatchObject({
      taskKind: AiTaskKind.TEXT_GENERATION,
      displayName: 'Azure — GPT-4o finalize',
      providerConnectionId: '01920000-0000-7000-8000-00000000c0nn',
      modelId: '01920000-0000-7000-8000-0000000m0de1',
      modelRef: 'gpt-4o-finalize-deployment',
      isDefault: true,
      enabled: true,
      residency: 'eu-west',
      baaCovered: true,
    });
  });

  it('normalises every absent optional to null rather than dropping the key', () => {
    // A response that OMITS `baaCovered` and one that reports `null` read
    // identically over JSON, but a client cannot tell "not covered" from "this
    // build does not report coverage" — so the projection always emits the key.
    const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({ ...base, modelRef: 'local-gguf' });

    const response = AiRoutingPolicyDtoMapper.toResponse(entity);

    expect(response.taskKind).toBeNull();
    expect(response.displayName).toBeNull();
    expect(response.providerConnectionId).toBeNull();
    expect(response.modelId).toBeNull();
    expect(response.residency).toBeNull();
    expect(response.baaCovered).toBeNull();
    expect(Object.keys(response)).toEqual(
      expect.arrayContaining(['taskKind', 'displayName', 'providerConnectionId', 'modelId', 'modelRef', 'isDefault', 'enabled', 'residency', 'baaCovered']),
    );
  });

  it('defaults the election to false and the candidate to enabled, matching the column defaults', () => {
    const entity = AiRoutingPolicyFactory.CreateAiRoutingPolicy({ ...base, modelRef: 'local-gguf' });

    const response = AiRoutingPolicyDtoMapper.toResponse(entity);

    expect(response.isDefault).toBe(false);
    expect(response.enabled).toBe(true);
  });
});
