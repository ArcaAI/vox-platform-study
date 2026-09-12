/**
 * TASK-958 D-7 — `AiUsageEvent.connectionId`: WHICH account of a vendor was spent.
 *
 * `provider` names the vendor, and a tenant may now hold several accounts of one, so
 * without this column two BYO keys are indistinguishable on every cost surface (R-4).
 * The value is never derived from `provider` or from `deployment` — it is carried by
 * the service that actually authenticated, through the three usage paths (text's
 * `usage_detail.connection_id`, STT's completion/teardown payloads, TTS's header and
 * usage frames) and frozen into the outbox payload on the way to the ledger row.
 */
import { describe, expect, it } from 'vitest';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { serializeUsageEvent } from '../usage-event.validation';
import { buildGuardrailUsageInput, buildLlmUsageInput, parseTextUsageDetail } from '../../consultation/summary/text-usage';

const TENANT = '7f3c1a2e-9b45-4c8d-a1e6-2f5b0d7c4a91';
const CONNECTION = 'conn-openai-research';

const textBlob = (over: Record<string, unknown> = {}) => ({
  task_id: 'task-1',
  request_id: 'req-1',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  endpoint_kind: 'openai.chat',
  byok: true,
  prompt_tokens: 100,
  completion_tokens: 20,
  ...over,
});

describe('TASK-958 (21) — the ledger carries the connection the call spent', () => {
  it('the outbox payload freezes `connectionId`, and `null` when the sender named none', () => {
    const base = {
      tenantId: TENANT,
      idempotencyKey: 'k1',
      occurredAt: new Date('2026-09-12T00:00:00.000Z'),
      capability: AiCapability.LLM,
      operation: 'generate' as const,
      provider: 'openai',
      deployment: AiDeploymentKind.BYOK,
      unit: AiUsageUnit.INPUT_TOKEN,
      quantity: 100,
    };
    expect(serializeUsageEvent({ ...base, connectionId: CONNECTION }).connectionId).toBe(CONNECTION);
    expect(serializeUsageEvent(base).connectionId).toBeNull();
  });

  it('TEXT: `usage_detail.connection_id` reaches the generate batch', () => {
    const usage = parseTextUsageDetail(textBlob({ connection_id: CONNECTION }));
    expect(usage?.connectionId).toBe(CONNECTION);
    const batch = buildLlmUsageInput({ usage: usage!, tenantId: TENANT, operation: 'generate' });
    expect(batch?.common.connectionId).toBe(CONNECTION);
    expect(batch?.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
  });

  it('TEXT: the guardrail batch carries it too, and a blob without one stays null', () => {
    const withConn = parseTextUsageDetail(textBlob({ connection_id: CONNECTION }))!;
    expect(buildGuardrailUsageInput({ usage: withConn, tenantId: TENANT })?.common.connectionId).toBe(CONNECTION);

    const without = parseTextUsageDetail(textBlob())!;
    expect(without.connectionId).toBeNull();
    expect(buildLlmUsageInput({ usage: without, tenantId: TENANT, operation: 'generate' })?.common.connectionId).toBeNull();
  });

  it('TEXT: an empty-string connection id is NOT a value — it stays null rather than inventing an account', () => {
    expect(parseTextUsageDetail(textBlob({ connection_id: '' }))?.connectionId).toBeNull();
    expect(parseTextUsageDetail(textBlob({ connection_id: 42 }))?.connectionId).toBeNull();
  });
});
