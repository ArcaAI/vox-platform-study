/**
 * TASK-786 — the SUPER_ADMIN credential-policy surface.
 *
 * What is worth pinning here is what this service must NOT do: it owns no
 * enforcement. Every write is delegated to `SettingsRegistryWriteService`, the
 * single descriptor-driven enforcement point that supplies the super-admin
 * gate, the type check, the cache refresh and the sys-event. A test that let
 * this service write a row directly would be testing a second write path that
 * must not exist.
 */
import { describe, expect, it, vi } from 'vitest';
import { SecurityPolicyService } from '../security-policy.service';

/** `versions` models rows that already exist (key → stored version). */
function makeService(stored: Record<string, unknown> = {}, versions: Record<string, number> = {}) {
  const appSettings = {
    getValueWithDefault: vi.fn((key: string, dflt: unknown) => (key in stored ? stored[key] : dflt)),
  };
  const writeService = {
    write: vi.fn(async () => ({})),
    getBackingRowVersion: vi.fn(async (key: string) => versions[key] ?? 0),
  };
  return { service: new SecurityPolicyService(appSettings as never, writeService as never), writeService };
}

describe('SecurityPolicyService.getPolicy', () => {
  it('returns the shipped defaults when nothing is stored', () => {
    const { service } = makeService();
    const policy = service.getPolicy();
    expect(policy.password).toEqual({
      minLength: 12,
      maxLength: 128,
      requireUppercase: true,
      requireLowercase: true,
      requireDigit: true,
      requireSpecial: true,
      maxAgeDays: 0,
    });
    expect(policy.secret).toEqual({ byteLength: 32, encoding: 'hex' });
  });

  it('returns the EFFECTIVE policy — stored rows win over the defaults', () => {
    const { service } = makeService({ 'security.password.minLength': 16, 'security.secret.byteLength': 48 });
    const policy = service.getPolicy();
    expect(policy.password.minLength).toBe(16);
    expect(policy.secret.byteLength).toBe(48);
  });

  it('publishes the code-enforced bounds, the pinned alphabets and the governed surfaces', () => {
    const { service } = makeService();
    expect(service.getPolicy().bounds).toEqual({
      minByteLength: 16,
      maxByteLength: 64,
      pinnedEncodings: { apiKey: 'hex', storageAccessKey: 'base64url' },
      governedSurfaces: ['serviceAccountClientSecret', 'apiKey', 'webhookSigningSecret', 'storageAccessKey'],
    });
  });
});

describe('SecurityPolicyService.updatePolicy', () => {
  it('writes ONLY the supplied fields, at system scope, through the enforcement point', async () => {
    const { service, writeService } = makeService();
    await service.updatePolicy({ passwordMinLength: 14, secretEncoding: 'base64url' });

    expect(writeService.write).toHaveBeenCalledTimes(2);
    // No row yet ⇒ no precondition; a first write must not 428 on itself.
    expect(writeService.write).toHaveBeenCalledWith('security.password.minLength', 14, { scope: 'system' });
    expect(writeService.write).toHaveBeenCalledWith('security.secret.encoding', 'base64url', { scope: 'system' });
  });

  it('writes a false boolean rather than skipping it as absent', async () => {
    const { service, writeService } = makeService();
    await service.updatePolicy({ passwordRequireSpecial: false });
    expect(writeService.write).toHaveBeenCalledWith('security.password.requireSpecial', false, { scope: 'system' });
  });

  /**
   * Without this the surface works exactly ONCE: the write lane is
   * compare-and-set and 428s any write to an existing row that carries no
   * precondition. Observed live before the fix — the second policy PUT of the
   * deployment failed.
   */
  it('preconditions a write on the version of the row it just read', async () => {
    const { service, writeService } = makeService({}, { 'security.secret.byteLength': 3 });
    await service.updatePolicy({ secretByteLength: 48 });
    expect(writeService.write).toHaveBeenCalledWith('security.secret.byteLength', 48, { scope: 'system', expectedVersion: 3 });
  });

  it('writes a zero rather than skipping it as absent', async () => {
    const { service, writeService } = makeService();
    await service.updatePolicy({ passwordMaxAgeDays: 0 });
    expect(writeService.write).toHaveBeenCalledWith('security.password.maxAgeDays', 0, { scope: 'system' });
  });

  it('writes nothing for an empty request', async () => {
    const { service, writeService } = makeService();
    await service.updatePolicy({});
    expect(writeService.write).not.toHaveBeenCalled();
  });

  it('propagates an enforcement-point refusal instead of swallowing it', async () => {
    const { service, writeService } = makeService();
    writeService.write.mockRejectedValueOnce(new Error('Setting is managed by super administrators only.'));
    await expect(service.updatePolicy({ secretByteLength: 48 })).rejects.toThrow(/super administrators only/);
  });

  it('re-reads and returns the effective policy after writing', async () => {
    const stored: Record<string, unknown> = {};
    const appSettings = { getValueWithDefault: vi.fn((key: string, dflt: unknown) => (key in stored ? stored[key] : dflt)) };
    const writeService = {
      write: vi.fn(async (key: string, value: unknown) => {
        stored[key] = value;
        return {};
      }),
      getBackingRowVersion: vi.fn(async () => 0),
    };
    const service = new SecurityPolicyService(appSettings as never, writeService as never);

    const result = await service.updatePolicy({ secretByteLength: 64 });
    expect(result.secret.byteLength).toBe(64);
  });
});
