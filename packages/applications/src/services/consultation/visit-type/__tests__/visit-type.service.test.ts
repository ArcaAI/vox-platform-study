/**
 * `VisitTypeService` — the platform's two visit types, seen from a call site.
 *
 * TASK-882: the service used to walk a tenant → SYSTEM settings cascade over the
 * `consultation.visitTypes` catalogue. The owner's model has no tenant-managed conditions, so
 * the cascade is gone and what is pinned here is the contract every caller still relies on:
 * the two shipped types, for every tenant, with no settings lane wired at all.
 */
import { describe, expect, it } from 'vitest';
import { VisitTypeService } from '../visit-type.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const ACME = 'aaaaaaaa-0000-0000-0000-00000000000a';

describe('the vocabulary', () => {
  it('serves the two shipped visit types to every tenant, in order', () => {
    const service = new VisitTypeService();
    expect(service.catalogue(ACME).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
    expect(service.catalogue(SYSTEM_TENANT_ID).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
    expect(service.catalogue(null).map((v) => v.key)).toEqual(['new-visit', 'revisit']);
  });

  it('takes no dependency — the unwired instance IS the wired one', () => {
    expect(new VisitTypeService().catalogue(ACME)).toBe(new VisitTypeService().catalogue(null));
  });
});

describe('what the call sites ask it', () => {
  const service = new VisitTypeService();

  it('resolves a consultation`s visit type from its parent link', () => {
    expect(service.forConsultation(ACME, { isFollowUp: false }).key).toBe('new-visit');
    expect(service.forConsultation(ACME, { isFollowUp: true }).key).toBe('revisit');
  });

  it('prefers a RECORDED visit type, matched by key or alias, over the parent link', () => {
    expect(service.forConsultation(ACME, { recorded: 'follow-up', isFollowUp: false }).key).toBe('revisit');
    expect(service.forConsultation(ACME, { recorded: 'new-patient', isFollowUp: true }).key).toBe('new-visit');
  });

  it('maps a visit type onto the Department prompt column it declares', () => {
    expect(service.promptSlot(ACME, 'revisit')).toBe('revisit');
    expect(service.promptSlot(ACME, 'new-visit')).toBe('new-patient');
    expect(service.promptSlot(ACME, 'pre-summary')).toBe('new-patient');
  });

  it('answers the membership question a route needs to accept or refuse a value', () => {
    expect(service.match(ACME, 'referral')?.key).toBe('new-visit');
    expect(service.match(ACME, 'walk-in')).toBeNull();
  });
});
