/**
 * the consent register READ is clinician-reachable.
 *
 * `admin/consent-grants` is class-gated `@CanManage('ConsentGrant')` (the PHI
 * authorization root: recording and revoking a grant stay tenant-admin work).
 * But the Consultation Scribe's consent PRE-FLIGHT reads the same register
 * (`GET /admin/consent-grants?externalPatientId=…`) for the patient about to be
 * recorded, and a clinician — including a super admin impersonating one — holds
 * no `manage:ConsentGrant`, so every Scribe session opened by a doctor surfaced
 * a 403 before Start (measured on hope-v2-dev, 2026-09-03). The LIST handler
 * therefore declares `read` at method level, which the guard reads with
 * `getAllAndOverride([handler, class])`, so it overrides the class gate for this
 * one route only; the write routes keep `manage`.
 */
import { describe, expect, it } from 'vitest';
import { REQUIRED_PERMISSIONS_KEY } from '@arcaai/applications';
import { ConsentGrantController } from '../consent.controller';

const methodMeta = (method: string) => Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, (ConsentGrantController.prototype as any)[method]);

describe('ConsentGrantController — authorization metadata ', () => {
  it('list (GET) requires only read:ConsentGrant so clinicians can pre-flight consent', () => {
    expect(methodMeta('list')).toEqual([{ action: 'read', subject: 'ConsentGrant' }]);
  });

  it('create and revoke keep the class-level manage gate (no method override)', () => {
    expect(methodMeta('create')).toBeUndefined();
    expect(methodMeta('revoke')).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_KEY, ConsentGrantController)).toEqual([{ action: 'manage', subject: 'ConsentGrant' }]);
  });
});
