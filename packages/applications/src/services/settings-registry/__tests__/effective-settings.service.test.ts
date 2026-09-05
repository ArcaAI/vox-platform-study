import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it, vi } from 'vitest';
import { EffectiveSettingsService } from '../effective-settings.service';
import { TenantSettingsService } from '../tenant-settings.service';

// The facade resolves the global-kv cascade for the caller's tenant and refuses secret keys.

function serviceWith(
  // Backs the global-kv lane. Omitted ⇒ no stored row at any scope, so
  // global-kv keys resolve to their descriptor default.
  //
  // The lane is now the full cascade
  // (tenant → SYSTEM → default) behind `TenantSettingsService`, so the facade
  // takes THAT service rather than reading `IAppSettingsService` with a
  // key-only lookup. A real `TenantSettingsService` is constructed over a fake
  // two-lane cache, so these cases exercise the production resolution path
  // instead of a stub of it.
  stored?: { platform?: Record<string, unknown>; tenant?: Record<string, Record<string, unknown>> },
): EffectiveSettingsService {
  const tenantSettings = stored
    ? new TenantSettingsService({
        getValueFromCache: (key: string) => (stored.platform && key in stored.platform ? stored.platform[key] : null),
        getTenantValueFromCache: (tenantId: string, key: string) => {
          const rows = stored.tenant?.[tenantId];
          return rows && key in rows ? rows[key] : null;
        },
      } as any)
    : undefined;
  return new EffectiveSettingsService(tenantSettings as any);
}

const CTX = { tenantId: 'tnt-1', departmentId: 'dep-1', doctorId: null };

describe('EffectiveSettingsService', () => {
  // Specimen changed from `tts.credential.azure` (removed with the `db-secret`
  // tier in TASK-872) to a `vault-kv` platform secret. The rule under test is
  // the same and is tier-independent: the refusal keys off
  // `sensitivity: 'secret'`, not off where the secret is stored.
  it('refuses a secret key (never surfaces a secret value)', async () => {
    const svc = serviceWith();
    await expect(svc.resolveEffective('minio.secretKey', CTX)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('throws for an unknown registry key', async () => {
    const svc = serviceWith();
    await expect(svc.resolveEffective('nope.key', CTX)).rejects.toThrow(/unknown setting/i);
  });

  // The tier that genuinely has no resolver is `entitlement` (the
  // plan feature-flag matrix). `entitlements.enabled` USED to land here too,
  // because no global-kv lane existed; it now resolves (see the global-kv
  // describe block below).
  // Specimen changed in TASK-872: `entitlements.featureDnaReports` was one of
  // the three plan feature-flag descriptors removed there.
  // `entitlements.featurePlatformDefaultCredential` is the surviving
  // `entitlement`-tier key and reaches the same fallthrough — the tier has no
  // lane at all, so `failMode` never enters into it.
  it('throws for a non-secret key whose tier has no registered resolver', async () => {
    const svc = serviceWith();
    await expect(svc.resolveEffective('entitlements.featurePlatformDefaultCredential', CTX)).rejects.toThrow(/no effective resolver/i);
  });

  // The global-kv override lane. Before this,
  // `agentic.context.*` short-circuited to the descriptor default and a value
  // written to the KV store was invisible here, so the read surface lied.
  describe('global-kv override lane', () => {
    // SUPERSEDED — `sourceScope` was the literal tier name
    // `'global-kv'`, which said WHERE the value is stored, not WHICH scope set
    // it. With six knobs now `maxScope: 'tenant'`, "stored in the KV" no longer
    // identifies the answer, so the lane reports the winning CASCADE tier
    // (`tenant` | `system` | `code-default`) — the same vocabulary the pipeline
    // branch above already uses, and what observability of fallbacks asks for.
    it('reports a stored platform row with sourceScope system', async () => {
      const svc = serviceWith({ platform: { 'agentic.context.liveDelta.maxChars': 9000 } });

      await expect(svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX)).resolves.toEqual({
        key: 'agentic.context.liveDelta.maxChars',
        tier: 'global-kv',
        value: 9000,
        sourceScope: 'system',
      });
    });

    it('reports a TENANT override ahead of the platform row', async () => {
      const svc = serviceWith({
        platform: { 'rateLimit.maxRequests': 100 },
        tenant: { 'tnt-1': { 'rateLimit.maxRequests': 10 } },
      });

      await expect(svc.resolveEffective('rateLimit.maxRequests', CTX)).resolves.toEqual({
        key: 'rateLimit.maxRequests',
        tier: 'global-kv',
        value: 10,
        sourceScope: 'tenant',
      });
      // …and the SAME facade answers a different tenant with the platform row.
      await expect(svc.resolveEffective('rateLimit.maxRequests', { ...CTX, tenantId: 'tnt-2' })).resolves.toMatchObject({
        value: 100,
        sourceScope: 'system',
      });
    });

    it('falls back to the descriptor default with sourceScope code-default', async () => {
      const svc = serviceWith({ platform: {} });

      await expect(svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX)).resolves.toEqual({
        key: 'agentic.context.liveDelta.maxChars',
        tier: 'global-kv',
        value: 12000,
        sourceScope: 'code-default',
      });
    });

    it('falls back to the descriptor default when no settings resolver is wired', async () => {
      const svc = serviceWith();
      const res = await svc.resolveEffective('agentic.context.liveDelta.maxChars', CTX);
      expect(res.sourceScope).toBe('code-default');
      expect(res.value).toBe(12000);
    });

    it('now resolves entitlements.enabled (a global-kv key) instead of throwing', async () => {
      const svc = serviceWith();
      const res = await svc.resolveEffective('entitlements.enabled', CTX);
      expect(res.tier).toBe('global-kv');
      expect(res.value).toBe(false);
    });

    it('resolves the newly registered platform-ops keys', async () => {
      const svc = serviceWith();
      await expect(svc.resolveEffective('rate-limit.enabled', CTX)).resolves.toMatchObject({
        value: true,
        sourceScope: 'code-default',
      });
      await expect(svc.resolveEffective('agentic.trajectory.retentionDays', CTX)).resolves.toMatchObject({
        value: 30,
      });
    });
  });

  // TASK-881 — the `models.*` lane is GONE with the `AiTaskDefault` facade.
  // Model SELECTION is not a setting: it resolves through
  // `AiRoutingPolicyService.resolveDefault`, and a `models.<taskKey>` read is
  // an unknown key like any other (never a lane that quietly answers null).
  describe('models.* (retired)', () => {
    it.each(['models.nlp.ner', 'models.guardrail.validate', 'models.harness.judge', 'models.text.live'])('%s is an unknown key', async (key) => {
      const svc = serviceWith();
      await expect(svc.resolveEffective(key, CTX)).rejects.toThrow(/unknown setting 'models\./);
    });
  });

  // The declared failure mode, honoured by the read facade.
  describe('failMode', () => {
    it('open-to-default: an unset global-kv tuning knob resolves to the descriptor default', async () => {
      const appSettings = { getValueWithDefault: vi.fn(() => null) };
      const svc = serviceWith(appSettings);

      // `rate-limit.enabled` is a tuning/protection flag → open-to-default.
      await expect(svc.resolveEffective('rate-limit.enabled', CTX)).resolves.toMatchObject({
        value: true,
        sourceScope: 'code-default',
      });
    });


    // The `closed` half of this contract is pinned on the db-config lane in
    // `effective-settings.db-config.test.ts` (an unresolved value raises; a
    // backend error propagates). It used to be exercised here through the
    // `models.*` lane, which TASK-881 retired with the `AiTaskDefault` facade.
  });
});
