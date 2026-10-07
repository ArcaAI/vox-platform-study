/**
 * TASK-1050 OD-11 + TASK-1049 F2 — after a committed guardrail-policy write: publish
 * `guardrail:config:invalidate` `{ tenantId }` (the channel apps/guardrail subscribes to) and schedule
 * the governed-prompt re-screen for that tenant. Both halves fail OPEN: the row is already committed.
 */
import { describe, expect, it, vi } from 'vitest';
import { GuardrailPolicyChangePublisher } from '../guardrail-policy-change.publisher';
import { GUARDRAIL_POLICY_INVALIDATION_CHANNEL } from '../policy-v2';

describe('GuardrailPolicyChangePublisher', () => {
  it('publishes { tenantId } on guardrail:config:invalidate and schedules the tenant re-screen', async () => {
    const redis = { publish: vi.fn(async () => undefined) };
    const registry = { scheduleTenantRescreen: vi.fn() };
    await new GuardrailPolicyChangePublisher(redis as never, registry as never).policyChanged('tenant-a');
    expect(GUARDRAIL_POLICY_INVALIDATION_CHANNEL).toBe('guardrail:config:invalidate');
    expect(redis.publish).toHaveBeenCalledWith('guardrail:config:invalidate', JSON.stringify({ tenantId: 'tenant-a' }));
    expect(registry.scheduleTenantRescreen).toHaveBeenCalledWith('tenant-a');
  });

  it('a Redis failure never fails the write, and the re-screen is still scheduled', async () => {
    const redis = { publish: vi.fn(async () => Promise.reject(new Error('redis down'))) };
    const registry = { scheduleTenantRescreen: vi.fn() };
    await expect(new GuardrailPolicyChangePublisher(redis as never, registry as never).policyChanged('t')).resolves.toBeUndefined();
    expect(registry.scheduleTenantRescreen).toHaveBeenCalledWith('t');
  });

  it('a throwing registry never fails the write', async () => {
    const registry = {
      scheduleTenantRescreen: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    await expect(new GuardrailPolicyChangePublisher(undefined, registry as never).policyChanged('t')).resolves.toBeUndefined();
  });

  it('nothing wired is a no-op, not an error', async () => {
    await expect(new GuardrailPolicyChangePublisher().policyChanged('t')).resolves.toBeUndefined();
  });
});
