/**
 * `KnownPhiService` gathers `known_phi`'s inputs for one consultation — the row's patient id, the
 * clinician's profile, the effective context schema's PHI kinds and the persisted context items —
 * and folds them with `collectKnownPhi`. Fail-open: any read failure yields what is left, never a
 * throw, because the detector's span-level pass in `apps/text` runs regardless.
 */
import { describe, expect, it, vi } from 'vitest';
import { ContextItemType } from '@arcaai/domains';
import type { ClsService } from 'nestjs-cls';
import type { IActiveUserContext } from '../../../interfaces';
import { KnownPhiService } from '../known-phi.service';

const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-a' : undefined)) } as unknown as ClsService<IActiveUserContext>;
const definition = { schemaVersion: '1.0', kinds: [{ key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI' }] };

function build(over: { consultation?: unknown; profileThrows?: boolean } = {}) {
  const consultations = { findByIdOrNull: vi.fn(async () => over.consultation ?? { patientId: 'P-1', doctorId: 'u-1', departmentId: null }) };
  const userProfiles = {
    findFirst: vi.fn(async () => {
      if (over.profileThrows) throw new Error('db down');
      return { firstName: 'Ravi', lastName: 'Kumar', staffId: 'ST-9' };
    }),
  };
  const item = { kindKey: 'patient', createdAt: new Date(), content: JSON.stringify({ patient_name: 'Asha Menon' }), encryptedContent: null };
  const contextItems = { findByConsultation: vi.fn(async () => [item]), decryptContentFromEntity: vi.fn() };
  const contextSchemas = { getEffectiveBundle: vi.fn(async () => ({ definition })) };
  const service = new KnownPhiService(cls, consultations as never, userProfiles as never, contextItems as never, contextSchemas as never, undefined);
  return { service, consultations, contextItems };
}

describe('KnownPhiService.forConsultation', () => {
  it('folds the patient id, the clinician and the persisted PHI-kind values', async () => {
    const { service, contextItems } = build();
    const entries = await service.forConsultation('c-1');
    expect(entries).toEqual(
      expect.arrayContaining([
        { label: 'patient id', value: 'P-1' },
        { label: 'clinician name', value: 'Ravi Kumar' },
        { label: 'staff id', value: 'ST-9' },
        { label: 'patient_name', value: 'Asha Menon' },
      ]),
    );
    expect(contextItems.findByConsultation).toHaveBeenCalledWith('c-1', { type: ContextItemType.STRUCTURED });
  });

  it('merges the caller`s own context over the persisted one, and reads the row once per TTL', async () => {
    const { service, consultations } = build();
    await service.forConsultation('c-1');
    const entries = await service.forConsultation('c-1', { patient: { patient_name: 'Asha M. Menon' } });
    expect(entries).toContainEqual({ label: 'patient_name', value: 'Asha M. Menon' });
    expect(consultations.findByIdOrNull).toHaveBeenCalledTimes(1);
  });

  it('never throws: a failed profile read just leaves the clinician out, an unknown consultation yields nothing', async () => {
    const partial = await build({ profileThrows: true }).service.forConsultation('c-1');
    expect(partial).toContainEqual({ label: 'patient id', value: 'P-1' });
    expect(partial.find((entry) => entry.label === 'staff id')).toBeUndefined();

    const none = build();
    none.consultations.findByIdOrNull.mockResolvedValueOnce(null as never);
    expect(await none.service.forConsultation('missing')).toEqual([]);
  });
});
